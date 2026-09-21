'use strict';
/**
 * 你画我猜 · 局域网联机版
 * 零依赖：Node 原生 http + 手写 WebSocket（RFC 6455）
 * 启动：node server.js   访问：http://<本机IP>:3000
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MSG = 1024 * 1024;      // 单条消息上限 1MB
const MAX_PLAYERS = 10;

/* ==================================================================
 *  词库  —— 独立到 words.js，按「分类 → 难度」分组维护
 *  WORDS 摊平后为 [词, 分类, 难度1易/2中/3难]
 * ================================================================== */
const { WORDS, CATEGORIES, CATEGORY_META, WORD_STATS, selfCheck } = require('./words');

/* ==================================================================
 *  猜词温度（玩法增强）
 *  猜词者以前只有一个动作——打字，而且猜错了游戏一声不吭。
 *  这里做「四层判断」把他从盲猜变成推理：
 *      很近   猜的是答案的一部分
 *      方向对 和答案同属一个词库分类          ← 这一档以前是完全缺失的
 *      沾边   字数对上 / 有一个字沾上了
 *  关键点：**语义相关性来自词库本身**（words.js 按 20 个分类组织），
 *  所以不接任何外部服务 —— 猜「老虎」而答案是「狮子」时，两者同属动物，
 *  就能告诉他「方向对了」。
 * ================================================================== */
const WORD_CAT = new Map(WORDS.map((w) => [w[0], w[1]]));

/** 「方向对」会缩小范围（等于变相送线索），所以每回合限量；用完自动降到只剩「沾边」 */
const WARM_BUDGET = 3;

const AVATARS = ['🐱','🐶','🦊','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🦄','🐙','🦉','🐧','🐢','🦈','🐝'];

/* ==================================================================
 *  工具函数
 * ================================================================== */
let uidCounter = 0;
const uid = () => (++uidCounter).toString(36) + Math.random().toString(36).slice(2, 6);

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const randOf = (a) => a[Math.floor(Math.random() * a.length)];

/** 归一化猜词：去空格标点、全角转半角、转小写 */
function norm(s) {
  return String(s || '')
    .replace(/[\s\u3000]/g, '')
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[.,!?;:'"`~@#$%^&*()_+\-=\[\]{}|\\\/<>，。！？；：、“”‘’《》【】（）—…·]/g, '')
    .toLowerCase();
}

/* ==================================================================
 *  选词引擎（v2）—— 实现见 picker.js
 *  三层防重复 + 难度配比 + 分类去重，详见 picker.js 头部注释。
 * ================================================================== */
const picker = require('./picker');
picker.init(WORDS);
const RECENT_MAX = picker.RECENT_MAX;

const pickWords = (room, n, exclude) =>
  picker.pickWords(room, n, exclude, (r, info) =>
    pushSystem(r, '词库已经刷完一遍啦，重新洗牌继续（累计出题 ' + info.used +
      ' 个，仅保留最近 ' + info.kept + ' 个词进入冷却）'));

const markUsed = (room, word) => picker.markUsed(room, word);
const poolStats = (room) => picker.poolStats(room);

const DIFF_MULT = { 1: 1.0, 2: 1.3, 3: 1.7 };
const DIFF_NAME = { 1: '简单', 2: '中等', 3: '困难' };

const COMBO_BONUS = 12;      // 每层连击额外 +12 分
const COMBO_MAX = 5;         // 连击层数上限（否则长局会滚成天文数字）
const CATCHUP_MAX = 0.40;    // 追赶加成上限 +40%
const CATCHUP_GAP = 600;     // 落后 600 分时吃满追赶加成
const REVEAL_COST = 15;      // 「开天眼」每用一次，画手本回合收益 -15

const REROLL_DEFAULT = 3;          // 选词阶段默认能换几批
const REROLL_OPTIONS = [2, 3, 5];  // 房主可选档位
const CHOOSE_TIMEOUT = 25000;      // 选词限时
// 回合结算停留总时长；自动化测试可用 TURN_END_DELAY=50 加速
const TURN_END_DELAY = Number(process.env.TURN_END_DELAY) || 6500;
// 结算停留拆成「投票窗 + 展示窗」，总时长不变，不改变原有节奏
const VOTE_WINDOW = Number(process.env.VOTE_WINDOW_MS) ||
  Math.min(4000, Math.max(30, Math.round(TURN_END_DELAY * 0.6)));
const VOTE_MAX_STARS = 5;
const VOTE_SCORE_PER_STAR = 8;     // 画作均分 1~5 星 → 画手 +8~40 分
const CUSTOM_WORD_MAX = 200;       // 单房最多导入多少个自定义词

/* ---------------- 主题解析：普通分类 / 随机 3 类 / 每日主题 ---------------- */
const THEME_RANDOM = '__random3';
const THEME_DAILY = '__daily';
const THEME_META = [
  { key: THEME_RANDOM, name: '🎲 随机 3 类', desc: '开局随机挑 3 个分类' },
  { key: THEME_DAILY, name: '📅 每日主题', desc: '按日期生成，同一天全房一致' }
];

/** 小巧的种子随机数发生器（同一 seed 结果稳定） */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 用种子从分类里抽 n 个不重复的 */
function pickCatsBySeed(seed, n) {
  const rng = mulberry32(seed);
  const pool = CATEGORIES.slice();
  const out = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  return out;
}

/** 把房主的选择（可能含 🎲 / 📅 这类快捷项）解析成具体分类数组 */
function effectiveThemes(room) {
  const sel = (room.settings && room.settings.themes) || [];
  if (!sel.length) return [];
  if (sel.includes(THEME_RANDOM)) {
    if (!room.themeRandom || room.themeRandom.length !== 3) {
      room.themeRandom = shuffle(CATEGORIES.slice()).slice(0, 3);
    }
    return room.themeRandom;
  }
  if (sel.includes(THEME_DAILY)) {
    const d = new Date();
    const seed = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
    return pickCatsBySeed(seed, 3);
  }
  return sel.filter((c) => CATEGORIES.includes(c));
}

/** 解析并缓存到 room.effectiveThemes（picker 会优先读这个） */
function refreshThemes(room) {
  room.effectiveThemes = effectiveThemes(room);
  room.bag = null;
  return room.effectiveThemes;
}

/** 清洗房主导入的自定义词库 → [词, '自定义', 难度] */
function buildCustomPool(words) {
  const out = [];
  const seen = new Set();
  for (const raw of words || []) {
    const w = cleanCustomWord(raw);
    if (!w || seen.has(w)) continue;
    seen.add(w);
    out.push([w, '自定义', diffByLength(w)]);
    if (out.length >= CUSTOM_WORD_MAX) break;
  }
  return out;
}

const DEFAULT_LIMITS = { singleColor: false, oneStroke: false, noEraser: false, blindDraw: false, inherit: false };

/** 统一的限制读取口，避免每处都重写一遍 Object.assign */
const limitOf = (room) => Object.assign({}, DEFAULT_LIMITS, room.settings && room.settings.limits);

/** 「接盘画」清掉上一轮残留的代价 —— 必须给出口，否则画手会被堵死 */
const INHERIT_CLEAR_COST = 10;

/* ==================================================================
 *  断线重连相关参数
 *  移动端切后台 / 息屏 / 桌面切标签久了 / 网络切换，都会让 WebSocket 被系统掐掉。
 *  这些参数决定了「多久算真死」以及「回来还能不能认出你」。
 * ================================================================== */
/** 心跳间隔：每 25 秒探一次（测试可用 HB_INTERVAL_MS 覆盖） */
const HB_INTERVAL = Number(process.env.HB_INTERVAL_MS) || 25000;
/** 容忍几轮没收到任何字节才判死。5 轮 ≈ 125 秒 —— 给「切后台再回来」留足窗口。
 *  真正的死连接只是多占两分钟内存，代价可接受。 */
const HB_MAX_MISS = 5;
/** 断线后先忍着不出声的宽限期。
 *  切后台、WiFi 闪一下、进隧道都只是几秒的事，一断就广播会把提示变成
 *  「狼来了」。这期间回来就一声不吭地接上。（测试可用 RECONNECT_GRACE_MS 覆盖） */
const RECONNECT_GRACE = Number(process.env.RECONNECT_GRACE_MS) || 6000;
/** 席位保留时长：这期间用同一个 pid 重连可以拿回分数。测试可用 SEAT_TTL_MS 覆盖 */
const SEAT_TTL = Number(process.env.SEAT_TTL_MS) || 3 * 60 * 1000;
/** 房间空了之后延迟多久再回收，给重连留窗口。测试可用 ROOM_TTL_MS 覆盖 */
const ROOM_TTL = Number(process.env.ROOM_TTL_MS) || 3 * 60 * 1000;

/* 画布底色可选值。白色画在白色画布上会隐形（比如画饺子），
   所以画手可以换成浅灰或深色底，白色笔迹立刻就看得见了。 */
const CANVAS_BG = ['#ffffff', '#e9eef4', '#2b2f38'];
const LIMIT_META = [
  { key: 'singleColor', name: '只用一种颜色', desc: '整回合只能用一个颜色画' },
  { key: 'oneStroke', name: '一笔画完', desc: '不能抬笔，只能留下一笔' },
  { key: 'noEraser', name: '禁用橡皮', desc: '画错只能撤销，不能擦' },
  { key: 'blindDraw', name: '盲画模式', desc: '画手看不到自己画的内容，3 秒后才显示' },
  { key: 'inherit', name: '接盘画', desc: '回合开始不清空画布，接着上一轮的残留画；清空要 -10 分' }
];

/** 自定义词按字数折算难度：2 字以内简单，3 字中等，4 字以上困难 */
const diffByLength = (w) => ([...w].length <= 2 ? 1 : [...w].length === 3 ? 2 : 3);

/** 清洗自定义词：去空白、只留中英文数字、限长 8 */
function cleanCustomWord(s) {
  return String(s || '')
    .replace(/[\s\u3000]/g, '')
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '')
    .slice(0, 8);
}

/* ==================================================================
 *  WebSocket 实现（服务端）
 * ================================================================== */
const OP = { CONT: 0x0, TEXT: 0x1, BIN: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  let head;
  if (len < 126) {
    head = Buffer.alloc(2);
    head[1] = len;
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeUInt32BE(Math.floor(len / 4294967296), 2);
    head.writeUInt32BE(len >>> 0, 6);
  }
  head[0] = 0x80 | opcode;
  return Buffer.concat([head, data]);
}

/** 解析一帧，数据不足返回 null */
function parseFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0], b1 = buf[1];
  const fin = (b0 & 0x80) === 0x80;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) === 0x80;
  let len = b1 & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < off + 2) return null;
    len = buf.readUInt16BE(off); off += 2;
  } else if (len === 127) {
    if (buf.length < off + 8) return null;
    const hi = buf.readUInt32BE(off), lo = buf.readUInt32BE(off + 4);
    len = hi * 4294967296 + lo; off += 8;
  }
  if (len > MAX_MSG) return { tooBig: true, total: buf.length };
  let mask = null;
  if (masked) {
    if (buf.length < off + 4) return null;
    mask = buf.slice(off, off + 4); off += 4;
  }
  if (buf.length < off + len) return null;
  const payload = Buffer.from(buf.slice(off, off + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  return { fin, opcode, payload, total: off + len };
}

function createConn(socket) {
  socket.setNoDelay(true);
  let buf = Buffer.alloc(0);
  let frags = [];
  let fragOp = 0;
  let alive = true;
  let closed = false;

  const conn = {
    ready: false,
    alive: () => alive,
    setAlive: (v) => { alive = v; },
    onMessage: () => {},
    onClose: () => {},
    send(obj) {
      if (closed) return;
      const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
      try { socket.write(encodeFrame(OP.TEXT, text)); } catch (e) { conn.kill(); }
    },
    ping() {
      if (closed) return;
      try { socket.write(encodeFrame(OP.PING, Buffer.alloc(0))); } catch (e) { conn.kill(); }
    },
    kill() {
      if (closed) return;
      closed = true;
      try { socket.destroy(); } catch (e) {}
      conn.onClose();
    },
    feed(chunk) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        const f = parseFrame(buf);
        if (!f) break;
        if (f.tooBig) return conn.kill();
        buf = buf.slice(f.total);
        if (f.opcode === OP.CLOSE) return conn.kill();
        if (f.opcode === OP.PING) { try { socket.write(encodeFrame(OP.PONG, Buffer.alloc(0))); } catch (e) {} continue; }
        if (f.opcode === OP.PONG) { alive = true; continue; }
        if (f.opcode === OP.TEXT || f.opcode === OP.BIN) {
          frags = [f.payload];
          fragOp = f.opcode;
        } else if (f.opcode === OP.CONT) {
          frags.push(f.payload);
        } else continue;

        if (f.fin) {
          const full = frags.length === 1 ? frags[0] : Buffer.concat(frags);
          frags = [];
          if (fragOp === OP.TEXT) conn.onMessage(full.toString('utf8'));
        }
      }
    }
  };
  conn.ready = true;

  socket.on('data', (c) => { alive = true; conn.feed(c); });
  socket.on('error', () => conn.kill());
  socket.on('close', () => conn.kill());
  /* ⚠️ 关键：对端发 FIN（正常关闭、移动端切后台被系统回收）时，
     'close' 在实测里**不会立刻触发** —— 服务端要等下一次写失败才发现。
     这里显式监听 'end'，一收到 FIN 就当作断线，掉线才能被立刻识别。 */
  socket.on('end', () => conn.kill());
  return conn;
}

/* ==================================================================
 *  房间 / 游戏逻辑
 * ================================================================== */
const rooms = new Map();

function newRoomCode() {
  let c;
  do { c = String(Math.floor(1000 + Math.random() * 9000)); } while (rooms.has(c));
  return c;
}

const roomOf = (p) => rooms.get(p.roomCode);

function send(p, msg) { if (p && p.conn) p.conn.send(msg); }

function broadcast(room, msg, exceptId) {
  const text = JSON.stringify(msg);
  for (const p of room.players.values()) {
    if (p.id === exceptId) continue;
    if (p.conn) p.conn.send(text);
  }
}

function othersCount(room) {
  let n = 0;
  for (const p of room.players.values()) if (p.id !== room.drawerId) n++;
  return n;
}

function roomState(room) {
  const inLobby = room.state === 'lobby';
  return {
    code: room.code,
    hostId: room.hostId,
    state: room.state,
    round: room.round,
    totalRounds: inLobby ? room.settings.rounds : room.totalRounds,
    duration: inLobby ? room.settings.duration : Math.round(room.duration / 1000),
    themes: (room.settings && room.settings.themes) || [],
    themesResolved: room.effectiveThemes || [],
    limits: Object.assign({}, DEFAULT_LIMITS, room.settings && room.settings.limits),
    reroll: (room.settings && room.settings.reroll) || REROLL_DEFAULT,
    boardLocked: !!room.boardLocked,
    customCount: (room.customPool || []).length,
    pool: poolStats(room),
    drawerId: room.drawerId,
    category: room.category || null,
    wordLen: room.word ? room.word.length : 0,
    mask: hintMask(room),
    endTime: room.endTime || 0,
    serverNow: Date.now(),
    players: [...room.players.values()].map((p) => ({
      id: p.id, name: p.name, avatar: p.avatar,
      score: p.score, guessed: !!p.guessed, isDrawer: p.id === room.drawerId,
      host: p.id === room.hostId, combo: p.combo || 0
    }))
  };
}

function hintMask(room) {
  if (!room.word) return '';
  const chars = [...room.word];
  return chars.map((c, i) => (room.hintIdx.includes(i) ? c : '＿')).join('');
}

function pushSystem(room, text, kind) {
  broadcast(room, { t: 'chat', kind: kind || 'system', name: '', text, time: Date.now() });
}

function cleanRoom(room) {
  ['timer', 'endTimer', 'tickTimer', 'voteTimer'].forEach((k) => { if (room[k]) clearTimeout(room[k]); });
  if (room.hintTimers) room.hintTimers.forEach(clearTimeout);
  if (room.seats) room.seats.forEach((s) => { if (s.timer) clearTimeout(s.timer); });
}

/* ---------------- 回合流程 ---------------- */

function startGame(room) {
  cleanRoom(room);
  room.round = 1;
  room.totalRounds = room.settings.rounds;
  room.duration = room.settings.duration * 1000;
  room.order = shuffle([...room.players.keys()]);
  room.turnIndex = -1;
  room.usedWords = [];          // 新一局 → 已用词清零，词库全量可用
  room.bag = null;
  room.recycledCount = 0;
  room.gameWords = [];
  room.gameVotes = [];
  room.stats = {};
  refreshThemes(room);          // 开局定稿主题（🎲 随机 3 类 在这一刻抽定）
  for (const p of room.players.values()) {
    p.score = 0;
    p.combo = 0;
    p.drawerGainTotal = 0;
    p.voteGainTotal = 0;
    p.firstGuess = 0;
    p.guessCount = 0;
    p.reactCount = 0;
  }
  room.strokes = [];
  room.carryStrokes = [];         // 「接盘画」的残留跨局不保留
  room.seats = new Map();         // 新一局开始，上一局的断线席位作废
  room.inherited = false;
  const th = room.effectiveThemes;
  broadcast(room, {
    t: 'chat', kind: 'system', name: '', time: Date.now(),
    text: '游戏开始！共 ' + room.totalRounds + ' 轮' +
      (th.length ? '　词库主题：' + th.join(' + ') : '')
  });
  advanceTurn(room, 0);
}

function advanceTurn(room, depth) {
  if (depth > 40) return endGame(room);
  cleanRoom(room);
  room.players.forEach((p) => { p.guessed = false; });
  // 「接盘画」：先把上一轮的笔迹存起来，等这一轮选完词再放回画布
  room.carryStrokes = limitOf(room).inherit ? room.strokes.slice() : [];
  room.inherited = false;
  room.strokes = [];
  room.guessedOrder = [];
  room.word = null;
  room.category = null;
  room.hintIdx = [];
  room.drawerId = null;
  room.boardLocked = false;       // 「一笔画完」的锁随回合重置
  room.lockColor = null;

  room.turnIndex++;
  while (room.turnIndex >= room.order.length) {
    room.round++;
    if (room.round > room.totalRounds) return endGame(room);
    room.order = shuffle([...room.players.keys()]);
    room.turnIndex = 0;
    if (!room.order.length) return endGame(room);
  }
  const drawer = room.players.get(room.order[room.turnIndex]);
  if (!drawer) return advanceTurn(room, depth + 1);

  room.state = 'choosing';
  room.drawerId = drawer.id;
  room.rerollLeft = room.settings.reroll;
  room.offered = [];                                   // 本回合已展示过的候选词
  room.choice = pickWords(room, 3, room.offered);
  room.offered = room.choice.map((w) => w[0]);
  armChooseTimeout(room);
  send(drawer, { t: 'wordChoice', words: choicePayload(room), rerollLeft: room.rerollLeft });
  broadcast(room, {
    t: 'choosing',
    drawerId: drawer.id,
    drawerName: drawer.name,
    drawerAvatar: drawer.avatar,
    room: roomState(room)
  }, drawer.id);
  send(drawer, { t: 'state', room: roomState(room) });
}

const choicePayload = (room) => room.choice.map((w) => ({ w: w[0], d: DIFF_NAME[w[2]] }));

/** 启动/重置选词倒计时，超时自动选第一个候选词 */
function armChooseTimeout(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = setTimeout(() => {
    if (room.state !== 'choosing' || !room.drawerId) return;
    chooseWord(room, room.drawerId, room.choice[0][0]);
  }, CHOOSE_TIMEOUT);
}

/** 画手点「换一批」：重抽候选词，额度由房主设置（会排除本回合已展示过的词） */
function rerollWords(room, player) {
  if (room.state !== 'choosing' || player.id !== room.drawerId) return;
  if (!room.rerollLeft || room.rerollLeft <= 0) {
    return send(player, { t: 'error', msg: '换词次数已经用完了，从这 ' + room.choice.length + ' 个词里挑一个吧' });
  }
  room.rerollLeft--;
  room.choice = pickWords(room, 3, room.offered || []);
  room.offered = (room.offered || []).concat(room.choice.map((w) => w[0]));
  armChooseTimeout(room);
  send(player, { t: 'wordChoice', words: choicePayload(room), rerollLeft: room.rerollLeft, rerolled: true });
  pushSystem(room, player.name + ' 换了一批候选词（还剩 ' + room.rerollLeft + ' 次）');
}

function chooseWord(room, playerId, word, custom) {
  if (room.state !== 'choosing' || playerId !== room.drawerId) return;
  const entry = custom
    ? [word, '自定义', diffByLength(word)]
    : (room.choice.find((x) => x[0] === word) || room.choice[0]);
  cleanRoom(room);

  room.word = entry[0];
  room.wordDiff = entry[2];
  room.category = entry[1];
  room.hintIdx = [];
  // 「接盘画」：把上一轮的残留放回画布，这一轮要接着它画
  const carry = Array.isArray(room.carryStrokes) ? room.carryStrokes : [];
  room.strokes = carry.slice();
  room.inherited = room.strokes.length > 0;
  room.carryStrokes = [];
  room.guessedOrder = [];
  room.state = 'playing';
  room.revealUsed = false;        // 「开天眼」每回合 1 次
  room.revealPenalty = 0;
  room.lockColor = null;          // 「只用一种颜色」的锁定色，每回合重置
  room.warmLeft = WARM_BUDGET;    // 猜词温度「方向对」的本回合额度
  room.boardLocked = false;       // 「一笔画完」的画板锁，每回合重置
  room.bg = CANVAS_BG[0];         // 画布底色，每回合重置成白色
  room.votes = new Map();
  room.players.forEach((p) => { p.guessed = false; });
  room.startTime = Date.now();
  room.endTime = room.startTime + room.duration;

  markUsed(room, room.word);      // 写入本局已用词 + 全局冷却队列
  room.gameWords = room.gameWords || [];
  room.gameWords.push(room.word);

  const drawer = room.players.get(room.drawerId);
  if (!drawer) return advanceTurn(room, 0);

  send(drawer, { t: 'drawerWord', word: room.word, diff: DIFF_NAME[room.wordDiff] });
  broadcast(room, {
    t: 'turnStart',
    drawerId: room.drawerId,
    drawerName: drawer.name,
    drawerAvatar: drawer.avatar,
    category: room.category,
    wordLen: room.word.length,
    mask: hintMask(room),
    duration: room.duration,
    endTime: room.endTime,
    room: roomState(room)
  });

  /* 「接盘画」：客户端收到 turnStart 会 resetCanvas()，所以残留必须在它之后补发。
     同一条 WebSocket 连接按序处理，所以不会出现"先画再被清掉"。 */
  if (room.inherited) {
    broadcast(room, { t: 'draw', op: 'fill', strokes: room.strokes, bg: room.bg });
    pushSystem(room, '🖌 接盘画：画布上留着上一轮的笔迹，接着画吧（清空要 -' +
      INHERIT_CLEAR_COST + ' 分）');
  }

  // 提示：50% 处揭示第一个字，剩余 20% 处揭示第二个字
  room.hintTimers = [];
  const maxReveal = room.word.length >= 4 ? 2 : 1;
  const revealAt = [0.5, 0.75];
  for (let i = 0; i < maxReveal; i++) {
    room.hintTimers.push(setTimeout(() => {
      if (room.state !== 'playing') return;
      const pool = [...room.word].map((_, idx) => idx).filter((idx) => !room.hintIdx.includes(idx));
      if (!pool.length) return;
      room.hintIdx.push(randOf(pool));
      if (room.hintIdx.length >= maxReveal) return;
      broadcast(room, { t: 'hint', mask: hintMask(room), category: room.category });
    }, room.duration * revealAt[i]));
  }

  room.endTimer = setTimeout(() => endTurn(room, 'timeout'), room.duration);
  // 每秒同步剩余时间
  room.tickTimer = setInterval(() => {
    if (room.state !== 'playing') return;
    const left = Math.max(0, Math.round((room.endTime - Date.now()) / 1000));
    broadcast(room, { t: 'tick', left });
    if (left <= 0) endTurn(room, 'timeout');
  }, 1000);
}

/** 画手道具「开天眼」：主动揭示一个未公开的字，代价是本回合收益 -15（每回合 1 次） */
function revealHint(room, player) {
  if (room.state !== 'playing' || player.id !== room.drawerId) return;
  if (!room.word) return;
  if (room.revealUsed) return send(player, { t: 'error', msg: '本回合的「开天眼」已经用过了' });
  const all = [...room.word].map((_, i) => i);
  const pool = all.filter((i) => !room.hintIdx.includes(i));
  if (pool.length <= 1) return send(player, { t: 'error', msg: '只剩一个字了，再揭示就没得猜啦' });

  room.revealUsed = true;
  room.hintIdx.push(randOf(pool));
  room.revealPenalty = (room.revealPenalty || 0) + REVEAL_COST;

  broadcast(room, { t: 'hint', mask: hintMask(room), category: room.category, byDrawer: player.name });
  send(player, { t: 'revealUsed', penalty: room.revealPenalty });
  pushSystem(room, player.name + ' 用了「开天眼」，主动揭示一个字（本回合画手收益 -' + REVEAL_COST + '）');
}

function endTurn(room, reason) {
  if (room.state !== 'playing') return;
  cleanRoom(room);
  room.state = 'turnEnd';

  const drawer = room.players.get(room.drawerId);
  const need = othersCount(room);
  const got = room.guessedOrder.length;
  const allGot = need > 0 && got >= need;
  let drawerGain = 0;
  let comboBonus = 0;
  if (drawer) {
    drawerGain = got * 35;
    if (allGot) drawerGain += 60;                      // 全员猜中加成
    if (allGot) {
      drawer.combo = Math.min((drawer.combo || 0) + 1, COMBO_MAX);   // 画手连续「全员猜中」也有连击
      comboBonus = Math.round(drawerGain * 0.15 * (drawer.combo - 1));
      drawerGain += comboBonus;
    } else {
      drawer.combo = 0;
    }
    drawerGain = Math.max(0, drawerGain - (room.revealPenalty || 0));  // 用「开天眼」的代价
    drawer.score += drawerGain;
    drawer.drawerGainTotal = (drawer.drawerGainTotal || 0) + drawerGain;
  }

  // 没猜中的玩家断连击
  for (const p of room.players.values()) {
    if (p.id !== room.drawerId && !p.guessed) p.combo = 0;
  }

  broadcast(room, {
    t: 'turnEnd',
    reason,
    word: room.word,
    wordDiff: room.wordDiff,
    drawerId: room.drawerId,
    drawerName: drawer ? drawer.name : '?',
    drawerGain,
    comboBonus,
    drawerCombo: drawer ? (drawer.combo || 0) : 0,
    revealPenalty: room.revealPenalty || 0,
    allGuessed: allGot,
    strokes: room.strokes,
    voting: VOTE_WINDOW > 0 && need > 0,
    voteWindow: VOTE_WINDOW,
    room: roomState(room)
  });

  // 投票窗：非画手给画作打 1~5 星；总停留时长不变，只是把前半段让给投票
  room.votes = new Map();
  room.voteBonus = 0;
  if (VOTE_WINDOW > 0 && need > 0) {
    room.voteTimer = setTimeout(() => closeVote(room), VOTE_WINDOW);
  }
  room.timer = setTimeout(() => advanceTurn(room, 0), TURN_END_DELAY);
}

/** 投票窗结束：结算画作分并广播 */
function closeVote(room) {
  if (room.state !== 'turnEnd') return;
  room.voteTimer = null;
  const drawer = room.players.get(room.drawerId);
  const votes = [...(room.votes || new Map()).values()];
  const avg = votes.length ? votes.reduce((a, b) => a + b, 0) / votes.length : 0;
  const bonus = Math.round(avg * VOTE_SCORE_PER_STAR);
  if (drawer && bonus > 0) {
    drawer.score += bonus;
    drawer.voteGainTotal = (drawer.voteGainTotal || 0) + bonus;
  }
  room.voteBonus = bonus;

  // 记录本局最佳画作
  if (votes.length) {
    room.gameVotes = room.gameVotes || [];
    room.gameVotes.push({
      word: room.word, avg: Math.round(avg * 10) / 10, count: votes.length,
      drawerId: room.drawerId, drawerName: drawer ? drawer.name : '?'
    });
  }

  broadcast(room, {
    t: 'voteResult',
    word: room.word,
    count: votes.length,
    avg: Math.round(avg * 10) / 10,
    drawerName: drawer ? drawer.name : '?',
    bonus,
    stars: votes
  });
  if (votes.length) {
    pushSystem(room, '画作评分 ' + (Math.round(avg * 10) / 10) + ' 星（' + votes.length + ' 人参与），' +
      (drawer ? drawer.name : '画手') + ' 额外 +' + bonus + ' 分');
  }
}

/** 玩家给本回合画作打分 */
function handleVote(room, player, starsRaw) {
  if (room.state !== 'turnEnd') return;
  if (player.id === room.drawerId) return;                 // 画手不能给自己打分
  const n = Math.round(Number(starsRaw));
  if (!Number.isFinite(n) || n < 1 || n > VOTE_MAX_STARS) {
    return send(player, { t: 'error', msg: '评分要在 1~' + VOTE_MAX_STARS + ' 星之间' });
  }
  room.votes = room.votes || new Map();
  if (room.votes.has(player.id)) {
    return send(player, { t: 'error', msg: '这一回合已经评过分了' });
  }
  room.votes.set(player.id, n);
  send(player, { t: 'voted', stars: n, count: room.votes.size });
  broadcast(room, { t: 'voteIn', id: player.id, name: player.name, count: room.votes.size }, player.id);
}

function endGame(room) {
  cleanRoom(room);
  room.state = 'gameEnd';
  room.drawerId = null;
  room.word = null;

  const players = [...room.players.values()];

  const ranking = players
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({
      rank: i + 1, id: p.id, name: p.name, avatar: p.avatar, score: p.score,
      drawerGainTotal: p.drawerGainTotal || 0,
      voteGainTotal: p.voteGainTotal || 0,
      firstGuess: p.firstGuess || 0,
      guessCount: p.guessCount || 0,
      reactCount: p.reactCount || 0,
      combo: p.combo || 0
    }));

  // 结算称号：每个称号只颁给唯一的第一名（同分时用总分打破平局），避免「人人都有」
  const titles = {};
  const award = (key, label) => {
    const top = ranking
      .slice()
      .sort((a, b) => (b[key] || 0) - (a[key] || 0) || b.score - a.score)[0];
    if (!top || (top[key] || 0) <= 0) return;
    (titles[top.id] = titles[top.id] || []).push(label);
  };
  award('drawerGainTotal', '🎨 神笔马良');
  award('voteGainTotal', '⭐ 全场最佳画作');
  award('firstGuess', '⚡ 神速首猜');
  award('guessCount', '🧠 最强大脑');
  award('reactCount', '🎉 气氛担当');

  // 本局评分最高的画作
  const voted = (room.gameVotes || []).slice().sort((a, b) => b.avg - a.avg || b.count - a.count);
  const bestDrawing = voted.length ? voted[0] : null;

  // 本局词库去重情况
  const gameWords = room.gameWords || [];
  const uniq = new Set(gameWords).size;
  const wordStats = {
    played: gameWords.length,
    unique: uniq,
    repeat: gameWords.length - uniq,
    poolUsed: (room.usedWords || []).length,
    poolTotal: poolStats(room).total,
    recycled: room.recycledCount || 0,
    allTotal: WORD_STATS.total
  };

  ranking.forEach((r) => { r.titles = titles[r.id] || []; });

  broadcast(room, { t: 'gameEnd', ranking, wordStats, bestDrawing, room: roomState(room) });
}

/* ---------------- 猜词 ---------------- */

function handleGuess(room, player, text) {
  text = String(text || '').slice(0, 60).trim();
  if (!text) return;

  if (room.state !== 'playing') {
    broadcast(room, { t: 'chat', kind: 'chat', name: player.name, avatar: player.avatar, text, time: Date.now() });
    return;
  }
  if (player.id === room.drawerId) return;               // 画手不能说话
  if (player.guessed) {                                   // 已猜中，转为聊天
    broadcast(room, { t: 'chat', kind: 'chat', name: player.name, avatar: player.avatar, text, time: Date.now() });
    return;
  }

  const g = norm(text), w = norm(room.word);
  if (g === w) {
    player.guessed = true;
    room.guessedOrder.push(player.id);
    const rank = room.guessedOrder.length;
    const left = Math.max(0, Math.round((room.endTime - Date.now()) / 1000));

    // ---- 计分：基础分 + 剩余时间 + 首猜奖励 + 连击 + 追赶 ----
    player.combo = Math.min((player.combo || 0) + 1, COMBO_MAX);
    player.guessCount = (player.guessCount || 0) + 1;
    if (rank === 1) player.firstGuess = (player.firstGuess || 0) + 1;

    const base = Math.max(50, 110 - (rank - 1) * 15) + (rank === 1 ? 30 : 0);
    const comboBonus = (player.combo - 1) * COMBO_BONUS;

    // 追赶机制：落后第一名越多，加成越高（最多 +40%），避免一边倒
    const topScore = Math.max(0, ...[...room.players.values()].map((p) => p.score));
    const gap = Math.max(0, topScore - player.score);
    const catchup = Math.min(CATCHUP_MAX, gap / CATCHUP_GAP);

    const raw = (base + left * 2 + comboBonus) * DIFF_MULT[room.wordDiff];
    const gain = Math.round(raw * (1 + catchup));
    player.score += gain;

    broadcast(room, {
      t: 'correct',
      id: player.id, name: player.name, avatar: player.avatar,
      rank, gain, combo: player.combo, comboBonus,
      catchup: Math.round(catchup * 100), time: Date.now()
    });
    broadcast(room, { t: 'state', room: roomState(room) });

    if (room.guessedOrder.length >= othersCount(room)) endTurn(room, 'allGuessed');
    return;
  }

  /* ---- 猜词温度：分层判断 ----
   * ①② 含剧透 → 只回给猜的人；③ 不含剧透 → 照常进聊天。
   * 注意：只有 ① 会 return，②③ 都继续往下走，所以**「猜错的话会出现在聊天里」
   * 这个原有行为一点没变**。 */
  const rough = text;
  const minPart = w.length <= 2 ? 1 : 2;

  // ① 很近：猜的是答案的一部分（沿用原有逻辑，消息类型也保持不变）
  if (w.length > 1 && g.length >= minPart && g.length < w.length && w.includes(g)) {
    send(player, { t: 'close', text });
    send(player, { t: 'warm', level: 'hot', text: '就差一点了！' });
    return;
  }

  // ② 方向对：和答案属于同一个分类
  const wCat = WORD_CAT.get(room.word);
  const gCat = WORD_CAT.get(rough);
  if (wCat && gCat && wCat === gCat && (room.warmLeft || 0) > 0) {
    room.warmLeft = (room.warmLeft || 0) - 1;
    send(player, {
      t: 'warm', level: 'warm', left: room.warmLeft,
      text: '方向对了，就在这一类里接着想'
    });
  } else if (rough.length === room.word.length) {
    // ③ 沾边：字数对上了
    send(player, { t: 'warm', level: 'cool', text: '字数对了' });
  } else if ([...new Set(rough)].some((ch) => room.word.indexOf(ch) >= 0)) {
    send(player, { t: 'warm', level: 'cool', text: '有一个字沾边了' });
  }

  broadcast(room, { t: 'chat', kind: 'chat', name: player.name, avatar: player.avatar, text, time: Date.now() });
}

/* ---------------- 绘画 ---------------- */

function handleDraw(room, player, m) {
  if (player.id !== room.drawerId) return;
  if (room.state !== 'playing') return;
  const limits = Object.assign({}, DEFAULT_LIMITS, room.settings && room.settings.limits);
  switch (m.op) {
    case 'bg': {
      // 换画布底色：不算笔画，不受「一笔画完」限制
      if (CANVAS_BG.indexOf(m.bg) < 0) return;
      room.bg = m.bg;
      broadcast(room, { t: 'draw', op: 'bg', bg: m.bg }, player.id);
      break;
    }
    case 'begin': {
      // ---- 玩法限制（服务端强制，前端禁用只是体验层） ----
      if (limits.noEraser && m.mode === 'eraser') {
        return send(player, { t: 'error', msg: '本局房主禁用了橡皮，用「撤销」吧' });
      }
      if (limits.oneStroke && (room.boardLocked || room.strokes.length >= 1)) {
        return send(player, { t: 'error', msg: '本局是「一笔画完」，这一笔已经用掉了' });
      }
      let color = m.color;
      if (limits.singleColor) {
        if (!room.lockColor) room.lockColor = m.color;
        color = room.lockColor;
      }
      const s = { sid: m.sid, color, w: m.w, mode: m.mode, pts: [m.x, m.y] };
      room.strokes.push(s);
      if (room.strokes.length > 600) room.strokes.shift();
      broadcast(room, { t: 'draw', op: 'begin', sid: m.sid, color, w: m.w, mode: m.mode, x: m.x, y: m.y }, player.id);
      break;
    }
    case 'pts': {
      const last = room.strokes[room.strokes.length - 1];
      if (!last || last.sid !== m.sid || !Array.isArray(m.pts)) return;
      if (last.pts.length > 30000) return;
      for (let i = 0; i < m.pts.length; i++) {
        const v = Number(m.pts[i]);
        last.pts.push(Number.isFinite(v) ? Math.max(-0.2, Math.min(1.2, v)) : 0);
      }
      broadcast(room, { t: 'draw', op: 'pts', sid: m.sid, pts: m.pts }, player.id);
      break;
    }
    case 'end': {
      broadcast(room, { t: 'draw', op: 'end', sid: m.sid }, player.id);
      // 「一笔画完」：抬笔即锁定画板 —— 画手能立刻看到反馈，不会再傻画半天
      if (limits.oneStroke && !room.boardLocked && room.strokes.length >= 1) {
        room.boardLocked = true;
        broadcast(room, { t: 'boardLock', locked: true, reason: 'oneStroke' });
        pushSystem(room, '画手的一笔已经画完了，接下来交给队友猜');
      }
      break;
    }
    case 'undo': {
      room.strokes.pop();
      broadcast(room, { t: 'draw', op: 'undo' });
      // 撤销之后重新拿回这一笔
      if (limits.oneStroke && room.boardLocked && !room.strokes.length) {
        room.boardLocked = false;
        broadcast(room, { t: 'boardLock', locked: false, reason: 'oneStroke' });
        pushSystem(room, '画手撤销了上一笔，可以重新画一笔');
      }
      break;
    }
    case 'clear':
      if (limits.oneStroke) return send(player, { t: 'error', msg: '本局是「一笔画完」，不能清空重画' });
      // 「接盘画」：擦掉别人的残留要有代价，但绝不能堵死
      if (room.inherited && room.strokes.length) {
        player.score = Math.max(0, player.score - INHERIT_CLEAR_COST);
        broadcast(room, { t: 'state', room: roomState(room) });
        pushSystem(room, player.name + ' 擦掉了上一轮的残留（-' + INHERIT_CLEAR_COST + ' 分）');
      }
      room.inherited = false;
      room.strokes = [];
      broadcast(room, { t: 'draw', op: 'clear' });
      break;
  }
}

/* ---------------- 连接处理 ---------------- */

function handleJoin(conn, msg) {
  const name = String(msg.name || '').trim().slice(0, 12) || '无名氏';
  const avatar = AVATARS.includes(msg.avatar) ? msg.avatar : randOf(AVATARS);
  let room;

  if (msg.roomCode) {
    room = rooms.get(String(msg.roomCode).trim());
    if (!room) return conn.send({ t: 'error', msg: '房间 ' + msg.roomCode + ' 不存在，检查一下号码？' });
  } else {
    room = { code: newRoomCode() };
    rooms.set(room.code, room);
  }
  if (room.players && room.players.size >= MAX_PLAYERS) {
    return conn.send({ t: 'error', msg: '房间满了（最多 ' + MAX_PLAYERS + ' 人）' });
  }

  room.players = room.players || new Map();
  room.settings = room.settings || { rounds: 3, duration: 80, reroll: REROLL_DEFAULT };
  if (room.settings.reroll === undefined) room.settings.reroll = REROLL_DEFAULT;
  if (!Array.isArray(room.settings.themes)) room.settings.themes = [];
  if (!room.settings.limits) room.settings.limits = Object.assign({}, DEFAULT_LIMITS);
  room.state = room.state || 'lobby';
  room.round = room.round || 0;
  room.totalRounds = room.totalRounds || room.settings.rounds;
  room.strokes = room.strokes || [];
  room.usedWords = room.usedWords || [];      // 本局已用词（防重复的核心）
  room.gameWords = room.gameWords || [];
  room.gameVotes = room.gameVotes || [];
  room.customPool = room.customPool || [];
  if (room.bag === undefined) room.bag = null;
  if (!room.effectiveThemes) refreshThemes(room);

  /* 断线重连：带上 pid 且席位还没过期 → 复用同一个 id。
     复用 id 很关键 —— room.order（出场顺序）和 room.hostId 都是按 id 记的。 */
  const seat = takeSeat(room, msg.pid);
  const player = {
    // id 必须是**服务端内部那个**（seat.id），不能用 pid：
    // room.order（出场顺序）和 room.hostId 都是按 id 记的，换了 id 就全错位
    id: seat ? seat.id : uid(),
    pid: msg.pid ? String(msg.pid) : null,   // 客户端稳定 id，断线存档时当键
    name, avatar,
    score: seat ? seat.score : 0,
    guessed: seat ? seat.guessed : false,
    combo: seat ? seat.combo : 0,
    drawerGainTotal: seat ? seat.drawerGainTotal : 0,
    voteGainTotal: seat ? seat.voteGainTotal : 0,
    firstGuess: seat ? seat.firstGuess : 0,
    guessCount: seat ? seat.guessCount : 0,
    reactCount: seat ? seat.reactCount : 0,
    conn, roomCode: room.code, disconnected: false
  };
  room.players.set(player.id, player);
  if (!room.hostId) room.hostId = player.id;
  // 只有「全新玩家」才清已猜中状态；重连的人要保留（否则他能重复猜同一个词）
  if (!seat && (room.state === 'playing' || room.state === 'choosing')) player.guessed = false;
  // 有人回来了，取消房间回收
  if (room.reapTimer) { clearTimeout(room.reapTimer); room.reapTimer = null; }

  conn.playerId = player.id;
  conn.myRoom = room;

  send(player, {
    t: 'joined',
    me: { id: player.id, name, avatar, host: room.hostId === player.id },
    cats: CATEGORY_META,           // 大厅主题选择用
    themeMeta: THEME_META,         // 🎲 随机 3 类 / 📅 每日主题
    limitMeta: LIMIT_META,         // 玩法限制开关
    wordBank: WORD_STATS,          // 词库总量，前端展示
    room: roomState(room)
  });

  // 回放当前画布
  if (room.strokes.length && (room.state === 'playing' || room.state === 'turnEnd')) {
    send(player, { t: 'draw', op: 'fill', strokes: room.strokes, bg: room.bg || CANVAS_BG[0] });
  } else if (room.bg && room.bg !== CANVAS_BG[0]) {
    send(player, { t: 'draw', op: 'bg', bg: room.bg });
  }
  if (room.state === 'playing' && room.word) {
    send(player, { t: 'turnStart', drawerId: room.drawerId, category: room.category,
      wordLen: room.word.length, duration: room.duration, endTime: room.endTime,
      room: roomState(room), joining: true });
  }
  if (room.state === 'choosing') {
    send(player, { t: 'choosing', drawerId: room.drawerId, drawerName: '', drawerAvatar: '', room: roomState(room) });
  }

  // 宽限期内回来的（noticed=false）什么都不说 —— 闪断不该有存在感。
  // 只有真被广播过「掉线了」的人回来，才报一句「重新连接上了」。
  if (!seat || seat.noticed) {
    broadcast(room, { t: 'chat', kind: 'join', name: player.name, avatar: player.avatar,
      text: seat ? '重新连接上了' : '加入了房间', time: Date.now() }, player.id);
  }
  broadcast(room, { t: 'state', room: roomState(room) }, player.id);
}

/* ==================================================================
 *  断线席位
 *  断线 ≠ 离开。移动端切个后台就可能被系统掐掉连接，这时候把分数直接扔掉，
 *  用户回来就只剩「刷新页面」一条路，整局作废。
 *  只把状态存成「席位」、**不把人留在 room.players 里** —— 这样
 *  othersCount / advanceTurn / 投票这些「数人头」的逻辑一行都不用改。
 * ================================================================== */

function saveSeat(room, player) {
  if (!room.seats) room.seats = new Map();
  // ⚠️ 键必须是客户端自己的 pid，不能是服务端内部 id ——
  // 重连时客户端只有 pid，用它查席位。
  const key = player.pid || player.id;
  const seat = {
    at: Date.now(),
    id: player.id,                 // 服务端内部 id 一起存，重连时要原样恢复
    noticed: false,                // 有没有向别人广播过「他掉线了」
    timer: null,                   // 宽限期定时器
    score: player.score,
    combo: player.combo || 0,
    guessed: !!player.guessed,
    drawerGainTotal: player.drawerGainTotal || 0,
    voteGainTotal: player.voteGainTotal || 0,
    firstGuess: player.firstGuess || 0,
    guessCount: player.guessCount || 0,
    reactCount: player.reactCount || 0
  };
  room.seats.set(key, seat);
  // 顺手清掉过期的，免得长期占内存
  const now = Date.now();
  room.seats.forEach((s, id) => {
    if (now - s.at > SEAT_TTL) { if (s.timer) clearTimeout(s.timer); room.seats.delete(id); }
  });
  return seat;
}

/** 取出并消费一个席位；不存在或已过期都返回 null（退化成新玩家） */
function takeSeat(room, pid) {
  if (!pid || !room.seats) return null;
  const key = String(pid);
  const s = room.seats.get(key);
  if (!s) return null;
  room.seats.delete(key);
  if (s.timer) { clearTimeout(s.timer); s.timer = null; }   // 人回来了，取消「掉线」广播
  return (Date.now() - s.at > SEAT_TTL) ? null : s;
}

/** 房间空了：不立刻删，先留个窗口给重连 */
function scheduleReap(room) {
  if (room.reapTimer) clearTimeout(room.reapTimer);
  room.reapTimer = setTimeout(() => {
    if (room.players && room.players.size) return;   // 期间有人回来了
    cleanRoom(room);
    rooms.delete(room.code);
  }, ROOM_TTL);
}

function handleDisconnect(room, player) {
  room.players.delete(player.id);
  const seat = saveSeat(room, player);          // 断线先存档，重连才能认回来

  if (!room.players.size) { cleanRoom(room); scheduleReap(room); return; }

  /* ⚠️ 不立刻喊「掉线了」。
     切后台、WiFi 闪一下、进隧道都只是几秒的事；一断就广播会把提示变成
     「狼来了」，别人分不清真走还是闪断，紧接着又看到「重新连接上了」更莫名其妙。
     这里先忍着，给 RECONNECT_GRACE 的宽限；人回来了就当无事发生。 */
  if (seat) {
    seat.timer = setTimeout(() => {
      seat.timer = null;
      if (room.players.has(player.id)) return;          // 已经回来了
      seat.noticed = true;
      if (!room.players.size) return;
      broadcast(room, { t: 'chat', kind: 'system', name: '', text: player.name + ' 掉线了，等他回来…', time: Date.now() });
      broadcast(room, { t: 'state', room: roomState(room) });
    }, RECONNECT_GRACE);
  }

  if (room.hostId === player.id) room.hostId = [...room.players.keys()][0];

  // 从出场顺序里摘掉，并修正游标
  if (room.order) {
    const idx = room.order.indexOf(player.id);
    if (idx >= 0) {
      room.order.splice(idx, 1);
      if (idx <= room.turnIndex) room.turnIndex--;
    }
  }

  // 画手跑了
  if (room.drawerId === player.id) {
    if (room.state === 'playing') { endTurn(room, 'drawerLeft'); return; }
    if (room.state === 'choosing') { advanceTurn(room, 0); return; }
  }

  if (room.state === 'playing' && room.guessedOrder.length >= othersCount(room)) {
    endTurn(room, 'allGuessed');
    return;
  }
  broadcast(room, { t: 'state', room: roomState(room) });
}

/* ==================================================================
 *  HTTP 静态服务
 * ================================================================== */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

/* ---- 标题：局域网访问显示「局域网联机」，公网访问显示「外网联机」 ----
 * 同一份代码既跑在本机（局域网）也跑在阿里云（公网），所以按请求的 Host 头
 * 判断：私网地址 / localhost 算局域网，其余（公网 IP、域名、trycloudflare
 * 隧道域名）算外网。index.html 里写死的那条标题是局域网默认值。
 */
const TITLE_LAN = '你画我猜 · 局域网联机';
const TITLE_WAN = '你画我猜 · 外网联机';

function isLanHost(hostHeader) {
  if (!hostHeader) return true;              // 没有 Host 头 → 当本机访问
  let h = String(hostHeader).trim().toLowerCase();
  if (h.startsWith('[')) {                   // IPv6 字面量，形如 [::1]:3000
    const end = h.indexOf(']');
    h = end >= 0 ? h.slice(1, end) : h;
  } else {
    const c = h.lastIndexOf(':');
    if (c >= 0) h = h.slice(0, c);           // 去掉端口
  }
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true;
  if (h.endsWith('.local')) return true;     // mDNS 名
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;                      // 域名 → 外网
  const a = Number(m[1]), b = Number(m[2]);
  return a === 10 || a === 127 ||            // 10/8、127/8
         (a === 192 && b === 168) ||         // 192.168/16
         (a === 172 && b >= 16 && b <= 31) || // 172.16/12
         (a === 169 && b === 254);           // 169.254/16 链路本地
}

/** 把 index.html 里的 <title> 换成与访问方式匹配的那个 */
function withTitle(buf, isLan) {
  const title = isLan ? TITLE_LAN : TITLE_WAN;
  return Buffer.from(
    buf.toString('utf8').replace(/<title>[^<]*<\/title>/, '<title>' + title + '</title>'),
    'utf8'
  );
}

const httpServer = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(req.url.split('?')[0]); } catch (e) { p = '/'; }
  if (p === '/' || p === '') p = '/index.html';
  const safe = path.normalize(p).replace(/^(\.\.[\/\\])+/, '').replace(/^[\/\\]+/, '');
  const file = path.join(PUBLIC_DIR, safe);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    // 只有首页要按访问方式换标题，其余静态资源原样发
    if (path.basename(file).toLowerCase() === 'index.html') {
      data = withTitle(data, isLanHost(req.headers.host));
    }
    // 头像图标内容永不变化，给长缓存，省得每次进登录页都重下 18 个 SVG
    const cache = /^avatars[\/\\]/.test(safe)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache';
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': cache });
    res.end(data);
  });
});

httpServer.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );

  let player = null;
  let room = null;
  let joined = false;

  const conn = createConn(socket);

  conn.onMessage = (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;

    try {
      if (m.t === 'join') {
        if (joined) return;
        joined = true;
        handleJoin(conn, m);
        if (conn.playerId && conn.myRoom) {
          player = conn.myRoom.players.get(conn.playerId);
          room = conn.myRoom;
        }
        return;
      }
      if (!player || !room || !rooms.has(room.code)) return;

      switch (m.t) {
        case 'start':
          if (player.id !== room.hostId) return;
          if (room.players.size < 2) return send(player, { t: 'error', msg: '至少 2 个人才能开始' });
          if (room.state === 'playing' || room.state === 'choosing') return;
          startGame(room);
          break;
        case 'chooseWord':
          chooseWord(room, player.id, String(m.word || ''));
          break;
        case 'reroll':
          rerollWords(room, player);
          break;
        case 'reveal':
          revealHint(room, player);
          break;
        case 'customWord': {
          if (room.state !== 'choosing' || player.id !== room.drawerId) return;
          const w = cleanCustomWord(m.word);
          if (!w) return send(player, { t: 'error', msg: '这个词不行——只能填中英文或数字，1~8 个字' });
          chooseWord(room, player.id, w, true);
          break;
        }
        case 'guess':
        case 'chat':
          handleGuess(room, player, m.text);
          break;
        case 'draw':
          handleDraw(room, player, m);
          break;
        case 'react':
          player.reactCount = (player.reactCount || 0) + 1;
          broadcast(room, { t: 'react', id: player.id, emoji: String(m.emoji || '👍').slice(0, 4) });
          break;
        case 'settings':
          if (player.id !== room.hostId) return;
          // 以前这里静默 return，房主在游戏里改了设置却毫无反馈，
          // 会以为「关了但没生效」。现在明确告诉他。
          if (room.state !== 'lobby') {
            return send(player, { t: 'error', msg: '游戏已经开始，设置只能在等待大厅里改' });
          }
          if (m.rounds) room.settings.rounds = Math.max(1, Math.min(6, Number(m.rounds) || 3));
          if (m.duration) room.settings.duration = Math.max(30, Math.min(180, Number(m.duration) || 80));
          if (m.reroll !== undefined) {
            const r = Number(m.reroll);
            room.settings.reroll = Number.isFinite(r) ? Math.max(0, Math.min(6, Math.round(r))) : REROLL_DEFAULT;
          }
          if (Array.isArray(m.themes)) {
            const raw = m.themes.slice(0, 10);
            const special = raw.filter((c) => c === THEME_RANDOM || c === THEME_DAILY).slice(0, 1);
            const normal = raw.filter((c) => CATEGORIES.includes(c)).slice(0, 10);
            // 快捷主题与普通分类互斥，避免语义打架
            room.settings.themes = special.length ? special : normal;
            room.themeRandom = null;
            const eff = refreshThemes(room);
            pushSystem(room, eff.length
              ? '房主把词库限定为：' + eff.join('、') + '（共 ' + poolStats(room).total + ' 个词）'
              : '房主把词库恢复为全部主题（共 ' + WORD_STATS.total + ' 个词）');
          }
          if (m.limits && typeof m.limits === 'object') {
            const lim = Object.assign({}, DEFAULT_LIMITS, room.settings.limits);
            for (const k of Object.keys(DEFAULT_LIMITS)) if (k in m.limits) lim[k] = !!m.limits[k];
            room.settings.limits = lim;
            const on = LIMIT_META.filter((x) => lim[x.key]).map((x) => x.name);
            pushSystem(room, on.length ? '房主开启了限制玩法：' + on.join('、') : '房主关闭了所有限制玩法');
          }
          if (Array.isArray(m.customWords)) {
            room.customPool = buildCustomPool(m.customWords);
            room.bag = null;
            pushSystem(room, room.customPool.length
              ? '房主导入了 ' + room.customPool.length + ' 个自定义词（已并入本房词池）'
              : '房主清空了自定义词库');
          }
          room.totalRounds = room.settings.rounds;
          room.duration = room.settings.duration * 1000;
          broadcast(room, { t: 'state', room: roomState(room) });
          break;
        case 'vote':
          handleVote(room, player, m.stars);
          break;
        case 'ping':
          // 纯回环，用来量往返延迟（顺便给界面上的延迟指示器用）
          send(player, { t: 'pong', ts: m.ts, server: Date.now() });
          break;
        case 'again':
          if (player.id !== room.hostId) return;
          cleanRoom(room);
          room.state = 'lobby';
          room.round = 0;
          room.drawerId = null;
          room.word = null;
          room.strokes = [];
          room.usedWords = [];       // 重开一局 → 词池重置，但全局冷却仍然生效
          room.bag = null;
          room.gameWords = [];
          room.gameVotes = [];
          room.recycledCount = 0;
          room.votes = new Map();
          room.players.forEach((p) => {
            p.score = 0; p.guessed = false; p.combo = 0;
            p.drawerGainTotal = 0; p.voteGainTotal = 0;
            p.firstGuess = 0; p.guessCount = 0; p.reactCount = 0;
          });
          broadcast(room, { t: 'state', room: roomState(room) });
          broadcast(room, { t: 'chat', kind: 'system', name: '', text: '房主开启了新一局，准备开始！', time: Date.now() });
          break;
        case 'renameRoom':
          break;
      }
    } catch (e) {
      console.error('[msg error]', e && e.message);
    }
  };

  conn.onClose = () => {
    if (player && room && rooms.has(room.code)) {
      if (room.players.get(player.id) === player) handleDisconnect(room, player);
    }
  };

  /* 心跳
   * ⚠️ 原来是「两轮收不到任何字节就 kill」——这在移动端会误杀：
   * 切后台 / 息屏时页面被挂起，JS 计时器被节流到 ≥1 分钟，
   * 客户端 4 秒的 ping 循环停摆，于是后台待够 50 秒必被服务端蹬掉。
   * 现在容忍 HB_MAX_MISS 轮（≈2 分钟），给「切后台再回来」留出窗口。 */
  let hbMiss = 0;
  const hb = setInterval(() => {
    if (conn.alive()) hbMiss = 0;
    else if (++hbMiss >= HB_MAX_MISS) { clearInterval(hb); return conn.kill(); }
    conn.setAlive(false);
    conn.ping();
  }, HB_INTERVAL);
  socket.on('close', () => clearInterval(hb));
});

/* ==================================================================
 *  启动
 * ================================================================== */
httpServer.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  const addrs = [];
  for (const k in nets) {
    for (const a of nets[k] || []) {
      if (a.family === 'IPv4' && !a.internal) addrs.push({ k, ip: a.address });
    }
  }
  const lan = addrs.find((a) => /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(a.ip) && !/WSL|Hyper|Virtual|VMware|Loopback/i.test(a.k));
  console.log('');
  console.log('  ==================================================');
  console.log('    🎨  你画我猜 · 局域网联机版已启动');
  console.log('  ==================================================');
  console.log('');
  console.log('   本机打开：   http://localhost:' + PORT);
  addrs.forEach((a) => {
    console.log('   局域网访问： http://' + a.ip + ':' + PORT + '   (' + a.k + ')');
  });
  if (lan) console.log('\n   👉 把上面这个局域网地址发给同一 WiFi / 局域网里的朋友即可联机');
  console.log('\n   ⚠ 若朋友打不开局域网地址（校园网 / 公司网常禁止设备互访，防火墙关了也没用），');
  console.log('     改用公网联机：双击 start-public.bat，把打印出的 trycloudflare 地址发给他们。');
  console.log('     登录页右下角显示的地址就是当前可分享的地址，直接照抄即可。');
  console.log('\n   词库：共 ' + WORD_STATS.total + ' 个词 / ' + WORD_STATS.categories + ' 个分类' +
    '（简单 ' + WORD_STATS.byDiff[1] + ' · 中等 ' + WORD_STATS.byDiff[2] + ' · 困难 ' + WORD_STATS.byDiff[3] + '）');
  console.log('   选词：房间内已用词硬排除 + 跨房间 ' + RECENT_MAX + ' 词软冷却，池子刷空后自动重洗');
  selfCheck((s) => console.log('   ⚠ ' + s));
  console.log('   开发者：炸鸡　·　有问题联系 QQ 3627690979\n');
  console.log('\n   关闭此窗口即停止服务 (Ctrl+C)\n');
});

httpServer.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('\n  ✗ 端口 ' + PORT + ' 已被占用。换个端口：set PORT=3001 && node server.js\n');
  } else {
    console.error('\n  ✗ 启动失败：' + e.message + '\n');
  }
  process.exit(1);
});
