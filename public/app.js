/* ================= 你画我猜 · 前端逻辑 ================= */
'use strict';

const $ = (id) => document.getElementById(id);
const PALETTE = ['#111827', '#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4',
                 '#3b82f6', '#8b5cf6', '#ec4899', '#a16207', '#6b7280', '#ffffff'];
const REACTS = ['👍', '😂', '😱', '🤔', '👏', '❤️', '🔥', '😭'];
const AVATARS = ['🐱','🐶','🦊','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🦄','🐙','🦉','🐧','🐢','🦈','🐝'];

/* ---- 头像改用图片渲染 ------------------------------------------------
 * 原来直接用 emoji 字符，由「操作系统自己的 emoji 字体」画出来：
 *   Windows -> Segoe UI Emoji、安卓 -> Noto Color Emoji、iOS -> Apple Color Emoji，
 * 同一局游戏里电脑端和手机端的头像长得不一样。这里换成微软 Fluent Emoji
 * 的矢量图（MIT 授权，见 public/avatars/SOURCE.md），全平台完全一致。
 *
 * 注意：存的仍然是 emoji 字符（协议、localStorage、服务端都不用改），
 *       只在渲染那一刻换成 <img>，老数据也能正常显示。
 * ------------------------------------------------------------------- */
const AVATAR_FILE = {
  '🐱': 'cat',        '🐶': 'dog_face',  '🦊': 'fox',         '🐼': 'panda',
  '🐨': 'koala',      '🐯': 'tiger_face','🦁': 'lion',        '🐮': 'cow_face',
  '🐷': 'pig_face',   '🐸': 'frog',      '🐵': 'monkey_face', '🦄': 'unicorn',
  '🐙': 'octopus',    '🦉': 'owl',       '🐧': 'penguin',     '🐢': 'turtle',
  '🦈': 'shark',      '🐝': 'honeybee'
};

/** 头像的 HTML：认识的 emoji 渲染成图片，不认识的老数据回退成 emoji 文字 */
function avatarImg(ch) {
  const f = AVATAR_FILE[ch];
  if (!f) return esc(ch || '');
  return '<img class="avp" src="avatars/' + f + '.svg" alt="' + esc(ch) + '" draggable="false">';
}

const S = {
  ws: null,
  me: null,
  room: null,
  myAvatar: AVATARS[Math.floor(Math.random() * AVATARS.length)],
  strokes: [],
  strokeMap: new Map(),
  cur: null,
  sid: 0,
  pending: [],
  tool: 'pen',
  color: PALETTE[0],
  width: 0.008,
  isDrawer: false,
  myWord: null,
  joined: false,
  drawing: false,
  muted: false,
  endTime: 0,
  offset: 0,
  duration: 0,
  rafPending: false,
  lastLeft: -1,
  lastTickSec: -1,
  cats: [],          // 词库分类（服务端下发）
  bank: null,        // 词库总量
  themePicks: [],    // 房主当前选中的主题（含 🎲 / 📅 快捷项）
  themeMeta: [],     // 快捷主题定义
  limitMeta: [],     // 玩法限制定义
  boardLocked: false,// 「一笔画完」画板锁
  blindDraw: false,  // 「盲画模式」开关
  bg: '#ffffff',     // 画布底色（画白色物体时可以换深色）
  pingMs: 0,         // 到服务器的往返延迟
  pingTimer: null,
  voted: false       // 本回合是否已给画作打分
};

/* ---------------- 音效（WebAudio 合成，零资源） ---------------- */
let actx = null;

/** iOS / 部分安卓浏览器要求 AudioContext 必须由用户手势创建或恢复，
 *  否则一直是 suspended，全程静音。首次触摸/点击时解锁一次。 */
function unlockAudio() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!actx) actx = new AC();
    if (actx.state === 'suspended' && actx.resume) actx.resume();
  } catch (e) {}
}
window.addEventListener('touchstart', unlockAudio, true);
window.addEventListener('mousedown', unlockAudio, true);
window.addEventListener('keydown', unlockAudio, true);

function tone(freq, dur, type, vol, delay) {
  if (S.muted) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const t0 = actx.currentTime + (delay || 0);
    const o = actx.createOscillator();
    const g = actx.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol || 0.12, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(actx.destination);
    o.start(t0); o.stop(t0 + dur + 0.02);
  } catch (e) {}
}
const sfx = {
  correct() { [660, 880, 1180].forEach((f, i) => tone(f, 0.14, 'sine', 0.13, i * 0.075)); },
  join() { tone(520, 0.09, 'triangle', 0.07); tone(780, 0.1, 'triangle', 0.06, 0.07); },
  start() { [440, 620].forEach((f, i) => tone(f, 0.13, 'square', 0.06, i * 0.1)); },
  tickTock() { tone(880, 0.05, 'square', 0.05); },
  end() { tone(400, 0.16, 'sine', 0.09); tone(300, 0.28, 'sine', 0.09, 0.15); },
  over() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.26, 'sine', 0.11, i * 0.13)); },
  close() { tone(300, 0.08, 'sawtooth', 0.05); }
};

/* ---------------- 工具 ---------------- */
function show(screen) {
  // 离开某页时顺手清掉它的错误提示，免得上次留下的报错一直挂在页面上。
  // （曾经出现过：游戏里用「开天眼」到只剩一个字，服务端回 error，
  //   回大厅后那行红字还显示在大厅底部）
  if (screen !== 'screen-login') $('login-err').textContent = '';
  if (screen !== 'screen-lobby') $('lobby-err').textContent = '';
  ['screen-login', 'screen-lobby', 'screen-game'].forEach((s) => $(s).classList.toggle('active', s === screen));
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function send(obj) {
  if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(obj));
}

/* ---------------- 复制到剪贴板 ----------------
 * navigator.clipboard 只在安全上下文（https / localhost）可用，
 * 局域网走 http://172.x.x.x:3000 时它是 undefined，所以必须留一条老式兜底。
 */
function fallbackCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) { return false; }
}

function copyText(text) {
  return new Promise((resolve) => {
    if (!text) return resolve(false);
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(
        () => resolve(true),
        () => resolve(fallbackCopy(text))
      );
    } else {
      resolve(fallbackCopy(text));
    }
  });
}

/** 把某个按钮 + 某段文本接成「点一下就复制」，并给出已复制/失败的反馈 */
function wireCopy(btnId, srcId) {
  const btn = $(btnId);
  const src = $(srcId);
  if (!btn) return;
  const read = () => (src ? src.textContent.trim() : '');
  const flash = (ok) => {
    btn.textContent = ok ? '已复制 ✓' : '复制失败';
    btn.classList.toggle('ok', ok);
    setTimeout(() => { btn.textContent = '复制'; btn.classList.remove('ok'); }, 1400);
  };
  btn.onclick = () => copyText(read()).then(flash);
  if (src) {
    src.title = '点一下即可复制';
    src.onclick = () => copyText(read()).then((ok) => { if (ok) flash(true); });
  }
}
function scrollChat() {
  const m = $('chat');
  m.scrollTop = m.scrollHeight;
}
function addMsg(html, cls) {
  const d = document.createElement('div');
  d.className = 'msg ' + (cls || '');
  d.innerHTML = html;
  $('chat').appendChild(d);
  while ($('chat').children.length > 300) $('chat').removeChild($('chat').firstChild);
  scrollChat();
}

/* ==================================================================
 *  WebSocket
 * ================================================================== */
/* ==================================================================
 *  连接 / 断线重连
 * --------------------------------------------------------------
 *  移动端切后台、息屏，桌面切标签久了、系统休眠，或者网络在 WiFi↔4G 之间切换，
 *  都会让 WebSocket 被系统掐掉。以前的做法是写一句「请刷新页面」就完事 ——
 *  等于整局作废。现在：
 *    · onclose 不再报死，改为指数退避自动重连（上限 5 秒）
 *    · 回到前台 / 亮屏 / 网络恢复时**立刻**重连，不等退避
 *      （被挂起时定时器会被节流，等它就是几十秒后才轮到，用户第一眼看到的还是"掉线"）
 *    · 重连带上稳定的 playerId，服务端复用席位 → 分数、连击、已猜中都不丢
 * ================================================================== */
const RECONNECT_BASE = 400;
const RECONNECT_MAX = 5000;
const RECONNECT_GIVEUP = 8;            // 连续失败这么多次就放弃，提示刷新
let reconnectTimer = null;
let reconnectDelay = RECONNECT_BASE;
let reconnectTries = 0;

function wsURL() {
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
}

/** 真正的建连逻辑。isRetry = 这是重连（不是首次），文案与失败处理都不同 */
function openSocket(isRetry, onFail) {
  let ws;
  try { ws = new WebSocket(wsURL()); }
  catch (e) { if (onFail) onFail('无法连接服务器'); return null; }
  S.ws = ws;

  ws.onopen = () => {
    send({
      t: 'join', name: S.myName, roomCode: S.myRoomCode || null,
      avatar: S.myAvatar, pid: S.playerId
    });
    startPingLoop();
    if (isRetry) {
      reconnectDelay = RECONNECT_BASE;
      reconnectTries = 0;
      addMsg('✅ 已重新连接', 'sys');
    }
  };
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    // 重连时如果服务端说房间不存在，说明房间早被回收了 —— 别再死循环重试
    if (isRetry && m.t === 'error' && /不存在/.test(m.msg || '')) {
      S.joined = false;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      show('screen-login');
      toastErr('房间已经关掉了，重新开一局吧');
      return;
    }
    handle(m);
  };
  ws.onclose = () => {
    if (!S.joined) return;             // 首次连接就没成 → 交给 doLogin 的 onFail 提示
    scheduleReconnect(false);
  };
  ws.onerror = () => {};
  return ws;
}

function scheduleReconnect(immediate) {
  if (reconnectTimer) return;
  const wait = immediate ? 0 : reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX);
  reconnectTries++;
  if (reconnectTries > RECONNECT_GIVEUP) {
    const b = $('turn-banner');
    if (b) b.textContent = '连不上服务器，刷新页面重试';
    return;
  }
  const b = $('turn-banner');
  if (b) b.textContent = '⚠️ 连接中断，正在重连…（第 ' + reconnectTries + ' 次）';
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    openSocket(true);
  }, wait);
}

/** 回到前台 / 亮屏 / 网络恢复 → 立刻重连，不等退避计时器 */
function kickReconnect() {
  if (!S.joined) return;
  if (S.ws && S.ws.readyState === 1) return;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  reconnectDelay = RECONNECT_BASE;
  reconnectTries = 0;
  openSocket(true);
}

function connect(name, roomCode, avatar, onFail) {
  S.myName = name;
  S.myRoomCode = roomCode || null;
  S.myAvatar = avatar;
  const ws = openSocket(false, onFail);
  if (!ws) return;
  setTimeout(() => { if (!S.joined && onFail) onFail('连接超时，检查一下服务是否还在运行'); }, 6000);
}

function handle(m) {
  switch (m.t) {
    case 'joined': {
      S.me = m.me;
      S.joined = true;
      S.room = m.room;
      loading = false;
      if (m.themeMeta) S.themeMeta = m.themeMeta;
      if (m.limitMeta) S.limitMeta = m.limitMeta;
      if (m.cats) { S.cats = m.cats; buildThemeChips(); }
      if (m.limitMeta) buildLimitChips();
      if (m.wordBank) S.bank = m.wordBank;
      show(m.room.state === 'lobby' ? 'screen-lobby' : 'screen-game');
      applyRoom(m.room);
      // 建房时服务端才会分配房间号 —— 记下来，重连要靠它回到同一个房间
      S.myRoomCode = m.room.code;
      // 清掉「正在重连…」的横幅；游戏中的横幅随后会被 turnStart 覆盖
      const tb = $('turn-banner');
      if (tb && /重连|断开|网络|连不上/.test(tb.textContent || '')) tb.textContent = '';
      if (m.room.state !== 'lobby' && !S.rejoined) addMsg('你加入了游戏，正在观战', 'sys');
      S.rejoined = true;
      break;
    }
    case 'state':
      applyRoom(m.room);
      break;

    case 'choosing': {
      S.room = m.room;
      S.isDrawer = m.drawerId === S.me.id;
      S.myWord = null;
      clearOverlays();
      resetCanvas();
      applyRoom(m.room);
      hideWordOverlays();
      setRevealUsed(false);
      if (S.isDrawer) {
        $('ov-choose').classList.add('show');
        $('turn-banner').textContent = '轮到你画了，选一个词';
      } else {
        $('ov-wait').classList.add('show');
        $('wait-drawer').textContent = m.drawerName || '有人';
        $('turn-banner').textContent = (m.drawerName || '有人') + ' 正在选词…';
      }
      sfx.start();
      break;
    }

    case 'wordChoice': {
      // 画手只收到这条（不收到 choosing），选词弹窗在这里打开
      S.isDrawer = true;
      clearOverlays();
      $('ov-choose').classList.add('show');
      $('turn-banner').textContent = '轮到你画了，选一个词';
      $('tools').classList.add('off');
      if (!m.rerolled) $('input-custom').value = '';   // 新回合才清空，换一批时保留用户输入
      refreshChooseBar(m.rerollLeft);
      const box = $('word-picks');
      box.innerHTML = '';
      m.words.forEach((o) => {
        const b = document.createElement('button');
        b.className = 'word-pick';
        b.dataset.d = o.d;
        b.innerHTML = esc(o.w) + '<span class="d">' + esc(o.d) + '</span>';
        b.onclick = () => {
          send({ t: 'chooseWord', word: o.w });
          hideWordOverlays();
        };
        box.appendChild(b);
      });
      break;
    }

    case 'drawerWord': {
      S.myWord = m.word;
      break;
    }

    case 'turnStart': {
      S.room = m.room;
      S.isDrawer = m.drawerId === S.me.id;
      S.endTime = m.endTime;
      S.offset = (m.room.serverNow || Date.now()) - Date.now();
      S.duration = m.duration;
      S.lastTickSec = -1;
      clearOverlays();
      resetCanvas();
      applyRoom(m.room);
      hideWordOverlays();
      const wtip = $('warm-tip'); if (wtip) wtip.classList.remove('show');
      if (S.isDrawer) {
        setRevealUsed(false);
        $('tools').classList.remove('off');
        $('board').classList.add('draw-mode');
        $('input-guess').disabled = true;
        $('input-guess').placeholder = '你是画手，专心画';
        $('turn-banner').textContent = '你的题目：' + (S.myWord || '') + '　（不许写字！）';
      } else {
        $('tools').classList.add('off');
        $('board').classList.remove('draw-mode');
        $('input-guess').disabled = false;
        $('input-guess').placeholder = '猜猜看这是什么…';
        if (!isMobileLayout()) $('input-guess').focus();
        $('turn-banner').textContent = m.drawerName + ' 正在作画';
      }
      // 手机版：画手折叠底部面板腾出画布，猜词者展开好打字
      if (isMobileLayout()) setSheetCollapsed(S.isDrawer);
      sfx.start();
      break;
    }

    case 'hint':
      $('hint-chars').textContent = m.mask.split('').join(' ');
      if (m.category && !$('hint-cat').textContent) $('hint-cat').textContent = m.category;
      addMsg((m.byDrawer ? '👁 ' + esc(m.byDrawer) + ' 开天眼揭示了一个字：' : '提示更新：') +
             m.mask.split('').join(' '), 'sys');
      break;

    case 'tick': {
      if (m.left <= 10 && m.left > 0 && m.left !== S.lastTickSec) sfx.tickTock();
      S.lastTickSec = m.left;
      break;
    }

    case 'correct': {
      sfx.correct();
      const tag = m.rank === 1 ? ' 🥇 首猜！' : ' #' + m.rank;
      const extra = [];
      if (m.combo > 1) extra.push('🔥 连击 x' + m.combo);
      if (m.catchup > 0) extra.push('追赶 +' + m.catchup + '%');
      addMsg('<span class="who">' + avatarImg(m.avatar) + ' ' + esc(m.name) + '</span> 猜对了！' +
             '<span class="mtag">+' + m.gain + ' 分' + tag +
             (extra.length ? '　' + extra.join('　') : '') + '</span>', 'correct');
      break;
    }

    case 'revealUsed':
      setRevealUsed(true, m.penalty);
      break;

    case 'boardLock':
      setBoardLocked(m.locked);
      break;

    case 'pong': {
      const rtt = Math.max(0, Date.now() - (m.ts || Date.now()));
      // 用滑动平均压一下抖动，读数别乱跳
      S.pingMs = S.pingMs ? Math.round(S.pingMs * 0.6 + rtt * 0.4) : rtt;
      renderPing();
      break;
    }

    case 'voted':
      lockVote(m.stars);
      break;

    case 'voteIn':
      if (!S.voted) $('vote-sub').textContent = m.count + ' 人已评分…';
      break;

    case 'voteResult': {
      const box = $('vote-box');
      box.classList.add('show');
      paintStars(Math.round(m.avg));
      document.querySelectorAll('#vote-stars .star').forEach((b) => { b.disabled = true; });
      $('vote-title').textContent = m.count
        ? '画作评分 ' + m.avg + ' 星（' + m.count + ' 人）'
        : '本回合没人评分';
      $('vote-sub').textContent = m.count
        ? esc(m.drawerName) + ' 画作分 +' + m.bonus
        : '';
      if (m.count) sfx.correct();
      break;
    }

    case 'close':
      sfx.close();
      break;

    case 'warm':
      showWarm(m);
      break;

    case 'chat': {
      if (m.kind === 'system') addMsg(esc(m.text), 'sys');
      else if (m.kind === 'join') addMsg(avatarImg(m.avatar) + ' <b>' + esc(m.name) + '</b> ' + esc(m.text), 'join');
      else addMsg('<span class="who">' + avatarImg(m.avatar) + ' ' + esc(m.name) + '</span>' + esc(m.text), '');
      break;
    }

    case 'draw':
      onDraw(m);
      break;

    case 'turnEnd': {
      const drawerName = m.drawerName || '?';
      $('end-drawer').innerHTML = '本回合画手：<b>' + esc(drawerName) + '</b>';
      $('end-word').textContent = m.word;
      let r = '';
      if (m.allGuessed) r = '全员猜中，画手 +60 加成 🎉';
      else if (m.reason === 'drawerLeft') r = '画手离开了，本回合中断';
      else r = '时间到，没人全部猜出来';
      if (m.drawerCombo > 1) r += '　画手连击 x' + m.drawerCombo;
      $('end-reason').textContent = r;
      $('end-next').textContent = '画手本回合 +' + m.drawerGain + ' 分' +
        (m.revealPenalty ? '（开天眼 -' + m.revealPenalty + '）' : '');
      clearOverlays();
      $('ov-end').classList.add('show');
      S.isDrawer = false;
      $('tools').classList.add('off');
      sfx.end();
      applyRoom(m.room);            // 先把最新房间状态落地，showVote 才能正确判断谁是画手
      showVote($('ov-end'), m.voting ? m.voteWindow : 0);
      break;
    }

    case 'gameEnd': {
      const box = $('final-ranks');
      box.innerHTML = '';
      m.ranking.forEach((p, i) => {
        const d = document.createElement('div');
        d.className = 'rank-row' + (p.rank === 1 ? ' top1' : '');
        d.style.animationDelay = (i * 0.09) + 's';
        const ttl = (p.titles || []).map((t) => '<span class="ttl">' + esc(t) + '</span>').join('');
        d.innerHTML = '<span class="r">' + (p.rank === 1 ? '👑' : p.rank) + '</span>' +
                      '<span class="av">' + avatarImg(p.avatar) + '</span>' +
                      '<span class="nm-wrap"><span class="nm">' + esc(p.name) + '</span>' +
                      (ttl ? '<span class="titles">' + ttl + '</span>' : '') + '</span>' +
                      '<span class="sc">' + p.score + '</span>';
        box.appendChild(d);
      });
      const st = m.wordStats;
      let extra = '';
      if (m.bestDrawing) {
        extra = '<br>⭐ 全场最佳画作：<b>' + esc(m.bestDrawing.word) + '</b>' +
          '（' + esc(m.bestDrawing.drawerName) + '，' + m.bestDrawing.avg + ' 星）';
      }
      $('final-stats').innerHTML = st
        ? '本局出题 <b>' + st.played + '</b> 个 · 不重复 <b>' + st.unique + '</b> 个' +
          (st.repeat ? ' · 重复 ' + st.repeat + ' 个' : ' · 零重复 🎉') + '<br>' +
          '词库规模 <b>' + st.allTotal + '</b> 词 · 本局已消耗 <b>' + st.poolUsed + '</b> / ' + st.poolTotal +
          (st.recycled ? ' · 池子重洗 ' + st.recycled + ' 次' : '') + extra
        : '';
      clearOverlays();
      $('ov-final').classList.add('show');
      $('btn-again').style.display = (S.me && S.room && S.room.hostId === S.me.id) ? '' : 'none';
      S.isDrawer = false;
      $('tools').classList.add('off');
      sfx.over();
      applyRoom(m.room);
      break;
    }

    case 'react':
      spawnEmoji(m.emoji);
      break;

    case 'error': {
      // 只往「当前正在看的那一页」的错误栏写。旧写法无条件写 login-err + lobby-err，
      // 导致游戏内的报错（比如开天眼只剩一个字）留在大厅页底部，回大厅就一直挂着。
      if ($('screen-login').classList.contains('active')) $('login-err').textContent = m.msg;
      if ($('screen-lobby').classList.contains('active')) $('lobby-err').textContent = m.msg;
      // 选词阶段出错就地显示在弹窗里，否则用户会对着没反应的按钮发呆
      if (S.isDrawer && $('ov-choose').classList.contains('show')) {
        $('choose-tip').textContent = '⚠️ ' + m.msg;
        $('choose-tip').style.color = 'var(--danger)';
      } else {
        toastErr(m.msg);
      }
      if (!S.joined) {
        S.joined = true; // 阻止重连提示
        if (S.ws) S.ws.close();
      }
      break;
    }
  }
}

function toastErr(msg) {
  if (S.joined && S.room) addMsg('⚠️ ' + msg, 'sys');
}

/* ==================================================================
 *  房间状态渲染
 * ================================================================== */
function applyRoom(r) {
  if (!r) return;
  const prev = S.room;
  S.room = r;

  const isHost = S.me && r.hostId === S.me.id;

  if (r.state === 'lobby') {
    clearOverlays();
    if (prev && prev.state === 'gameEnd') resetCanvas();
    show('screen-lobby');
    $('lobby-code').textContent = r.code;
    const iu = $('invite-url');
    if (iu) iu.textContent = location.origin + '/?room=' + r.code;
    $('lobby-count').textContent = r.players.length;
    const box = $('lobby-players');
    box.innerHTML = '';
    r.players.forEach((p) => {
      const d = document.createElement('div');
      d.className = 'pcard';
      d.innerHTML = '<span class="av">' + avatarImg(p.avatar) + '</span><span class="nm">' + esc(p.name) +
                    '</span>' + (p.host ? '<span class="badge">房主</span>' : '');
      box.appendChild(d);
    });
    $('btn-start').disabled = !isHost || r.players.length < 2;
    $('btn-start').textContent = isHost
      ? (r.players.length < 2 ? '至少需要 2 人' : '开始游戏（' + r.players.length + ' 人）')
      : '等待房主开始';
    document.querySelectorAll('#seg-rounds button').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === r.totalRounds));
    document.querySelectorAll('#seg-duration button').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === r.duration));
    document.querySelectorAll('#seg-reroll button').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === (r.reroll || 3)));
    document.querySelectorAll('#seg-rounds button, #seg-duration button, #seg-reroll button')
      .forEach((b) => { b.disabled = !isHost; });
    S.themePicks = r.themes || [];
    renderThemeChips();
    renderLimitChips();
    $('custom-note').textContent = r.customCount
      ? '已导入 ' + r.customCount + ' 个词'
      : '未导入';
    document.querySelectorAll('#custom-words, #btn-custom-apply, #btn-custom-clear')
      .forEach((el) => { el.disabled = !isHost; });
    if (isHost) $('lobby-note').textContent = '你是房主，凑满 2 人就能开始';
    else $('lobby-note').textContent = '等房主开始游戏…';
    return;
  }

  // 游戏中
  if (!$('screen-game').classList.contains('active')) show('screen-game');
  $('game-code').textContent = r.code;
  setBoardLocked(r.boardLocked);
  S.blindDraw = !!(r.limits && r.limits.blindDraw);
  renderBlindBadge();
  if (blindActive()) scheduleBlindRender();
  const poolTxt = r.pool
    ? '　<span style="font-size:11px;color:var(--dim);font-weight:500">词池 ' +
      (r.pool.total - r.pool.left) + '/' + r.pool.total + ' 已出</span>'
    : '';
  $('round-info').innerHTML = '第 <b>' + Math.min(r.round, r.totalRounds) + '</b> / ' + r.totalRounds + ' 轮' + poolTxt;

  if (r.state === 'playing' || r.state === 'choosing' || r.state === 'turnEnd') {
    if (r.category) $('hint-cat').textContent = r.category;
    else $('hint-cat').textContent = '';
    if (r.wordLen && !(S.isDrawer && S.myWord)) {
      const mask = r.mask || '＿'.repeat(r.wordLen);
      $('hint-chars').textContent = mask.split('').join(' ');
    }
  }
  if (S.isDrawer && S.myWord && (r.state === 'playing')) {
    $('hint-cat').textContent = '你的题目';
    $('hint-chars').textContent = S.myWord;
  }

  const list = $('game-players');
  list.innerHTML = '';
  [...r.players].sort((a, b) => b.score - a.score).forEach((p) => {
    const d = document.createElement('div');
    d.className = 'prow' + (p.isDrawer ? ' drawing' : '') + (p.guessed && !p.isDrawer ? ' done' : '') +
                  (S.me && p.id === S.me.id ? ' me' : '');
    d.innerHTML = '<span class="av">' + avatarImg(p.avatar) + '</span>' +
                  '<span class="nm">' + esc(p.name) + (p.host ? ' 👑' : '') +
                  (p.combo > 1 ? '<span class="combo">🔥' + p.combo + '</span>' : '') + '</span>' +
                  '<span class="tick">' + (p.isDrawer ? '✏️' : (p.guessed ? '✅' : '')) + '</span>' +
                  '<span class="sc">' + p.score + '</span>';
    list.appendChild(d);
  });
  renderReacts();
}

function clearOverlays() {
  ['ov-choose', 'ov-wait', 'ov-end', 'ov-final'].forEach((id) => $(id).classList.remove('show'));
  $('vote-box').classList.remove('show');
  S.voted = false;
}
function hideWordOverlays() {
  $('ov-choose').classList.remove('show');
  $('ov-wait').classList.remove('show');
}

/** 刷新选词弹窗底部的换词按钮与提示文案 */
function refreshChooseBar(left) {
  const n = typeof left === 'number' ? left : 0;
  const btn = $('btn-reroll');
  btn.disabled = n <= 0;
  btn.textContent = n > 0 ? '🔄 换一批（还剩 ' + n + ' 次）' : '🔄 换词机会用完了';
  const tip = $('choose-tip');
  tip.style.color = '';
  tip.textContent = n > 0
    ? '也可以自己出题（1~8 个字）· 25 秒内没选就自动用第一个'
    : '这 3 个词是最后一批了，挑一个吧';
}

/** 提交自定义题目；不主动关弹窗，等服务器确认（turnStart 会关），失败则原地报错 */
function submitCustomWord() {
  const v = $('input-custom').value.trim();
  const tip = $('choose-tip');
  if (!v) {
    tip.textContent = '先写个词再点确认';
    tip.style.color = 'var(--warn)';
    $('input-custom').focus();
    return;
  }
  send({ t: 'customWord', word: v });
  tip.textContent = '正在用「' + v + '」出题…';
  tip.style.color = 'var(--accent2)';
}

/* ---------------- 词库主题 / 玩法限制 / 开天眼 ---------------- */
function buildThemeChips() {
  const box = $('theme-chips');
  if (!box || box.children.length || !S.cats.length) return;
  // 快捷主题（🎲 随机 3 类 / 📅 每日主题）与普通分类互斥，放最前面
  S.themeMeta.forEach((t) => {
    const b = document.createElement('button');
    b.className = 'chip special';
    b.dataset.cat = t.key;
    b.title = t.desc;
    b.textContent = t.name;
    b.onclick = () => {
      S.themePicks = S.themePicks.includes(t.key) ? [] : [t.key];
      renderThemeChips();
      send({ t: 'settings', themes: S.themePicks });
    };
    box.appendChild(b);
  });
  const sep = document.createElement('span');
  sep.className = 'chip-sep';
  box.appendChild(sep);
  S.cats.forEach((c) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.cat = c.name;
    b.innerHTML = esc(c.name) + '<span class="n">' + c.count + '</span>';
    b.onclick = () => {
      const cur = new Set(S.themePicks.filter((x) => !x.startsWith('__')));
      if (cur.has(c.name)) cur.delete(c.name); else cur.add(c.name);
      S.themePicks = [...cur];
      renderThemeChips();
      send({ t: 'settings', themes: S.themePicks });
    };
    box.appendChild(b);
  });
}

function renderThemeChips() {
  const isHost = !!(S.me && S.room && S.room.hostId === S.me.id);
  const picks = (S.room && S.room.themes) || S.themePicks || [];
  document.querySelectorAll('#theme-chips .chip').forEach((b) => {
    b.classList.toggle('on', picks.includes(b.dataset.cat));
    b.disabled = !isHost;
  });
  const pool = S.room && S.room.pool;
  const total = pool ? pool.total : (S.bank ? S.bank.total : null);
  const resolved = (S.room && S.room.themesResolved) || [];
  const note = $('theme-note');
  if (picks.length) {
    note.textContent = resolved.length
      ? resolved.join(' + ') + '（' + (total || '?') + ' 词）'
      : '已选主题（' + (total || '?') + ' 词）';
  } else {
    note.textContent = '全部' + (total ? '（' + total + ' 词）' : '');
  }
}

function buildLimitChips() {
  const box = $('limit-chips');
  if (!box || box.children.length || !S.limitMeta.length) return;
  S.limitMeta.forEach((l) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.limit = l.key;
    b.title = l.desc;
    b.textContent = l.name;
    b.onclick = () => {
      // 以按钮自己的 on 状态为准，而不是 S.room.limits。
      // 后者要等服务端 state 回来才更新，连点两下会读到旧值 ——
      // 「开→关」会算成「开→开」，看起来就像关不掉。
      const next = !b.classList.contains('on');
      const lim = Object.assign({}, (S.room && S.room.limits) || {});
      lim[l.key] = next;
      b.classList.toggle('on', next);
      send({ t: 'settings', limits: lim });
    };
    box.appendChild(b);
  });
}

function renderLimitChips() {
  const isHost = !!(S.me && S.room && S.room.hostId === S.me.id);
  const lim = (S.room && S.room.limits) || {};
  document.querySelectorAll('#limit-chips .chip').forEach((b) => {
    b.classList.toggle('on', !!lim[b.dataset.limit]);
    b.disabled = !isHost;
  });
  const on = S.limitMeta.filter((l) => lim[l.key]);
  $('limit-note').textContent = on.length ? on.map((l) => l.name).join(' · ') : '全部关闭';
  // 限制生效时同步禁用画手的对应控件
  const oneStroke = !!lim.oneStroke;
  $('tool-clear').disabled = oneStroke;
  $('tool-eraser').disabled = !!lim.noEraser || oneStroke;
}

/** 房主导入自定义词库 */
function applyCustomWords() {
  const raw = $('custom-words').value || '';
  const list = raw.split(/[\n,，、;；]+/).map((s) => s.trim()).filter(Boolean);
  if (!list.length) {
    $('custom-note').textContent = '没读到词，一行一个或用逗号分隔';
    return;
  }
  send({ t: 'settings', customWords: list });
  $('custom-note').textContent = '正在导入 ' + list.length + ' 个…';
}

function setRevealUsed(used, penalty) {
  const b = $('tool-reveal');
  if (!b) return;
  b.disabled = !!used;
  b.classList.toggle('on', !!used);
  b.textContent = used ? '👁 已用（-' + (penalty || 15) + '）' : '👁 开天眼';
}

/** 猜词温度提示：三档颜色，2.6 秒自动淡出。
 *  服务端只把它发给猜的人本人，所以这里不用判断角色。 */
let warmTimer = null;
function showWarm(m) {
  const el = $('warm-tip');
  if (!el) return;
  const icon = { hot: '🔥', warm: '🌤', cool: '🌥' }[m.level] || '🔍';
  el.className = 'warm-tip lv-' + (m.level || 'cool');
  el.textContent = icon + ' ' + (m.text || '') +
    (m.level === 'warm' && typeof m.left === 'number' ? '（本回合还剩 ' + m.left + ' 次）' : '');
  void el.offsetWidth;              // 强制重排，否则「清掉再点亮」不会触发过渡
  el.classList.add('show');
  if (warmTimer) clearTimeout(warmTimer);
  warmTimer = setTimeout(() => { el.classList.remove('show'); }, 2600);
}

/** 「一笔画完」：这一笔用掉后锁死画板，避免画手还在傻画 */
function setBoardLocked(locked) {
  S.boardLocked = !!locked;
  $('board').classList.toggle('locked', S.boardLocked);
  $('lock-tip').classList.toggle('show', S.boardLocked);
  if (S.boardLocked) {
    $('lock-tip').textContent = S.isDrawer
      ? '✏️ 你的一笔已用完，交给队友猜吧'
      : '✏️ 画手的一笔已用完';
  }
}

/* ---------------- 画作投票 ---------------- */
function showVote(box, window_) {
  S.voted = false;
  const isDrawer = !!(S.room && S.room.drawerId === S.me.id);
  const wrap = $('vote-box');
  if (!window_ || isDrawer) { wrap.classList.remove('show'); return; }
  wrap.classList.add('show');
  $('vote-title').textContent = '这幅画值几星？';
  $('vote-sub').textContent = '评分会变成画手的画作分（1 星 8 分，满星 40 分）';
  const row = $('vote-stars');
  row.innerHTML = '';
  for (let i = 1; i <= 5; i++) {
    const b = document.createElement('button');
    b.className = 'star';
    b.textContent = '★';
    b.title = i + ' 星';
    b.onmouseenter = () => paintStars(i);
    b.onclick = () => { send({ t: 'vote', stars: i }); };
    row.appendChild(b);
  }
  row.onmouseleave = () => paintStars(0);
  paintStars(0);
}

function paintStars(n) {
  document.querySelectorAll('#vote-stars .star').forEach((b, i) => {
    b.classList.toggle('on', i < n);
  });
}

function lockVote(stars) {
  S.voted = true;
  $('vote-title').textContent = '你打了 ' + stars + ' 星，等其他人…';
  paintStars(stars);
  document.querySelectorAll('#vote-stars .star').forEach((b) => { b.disabled = true; });
}

/* ==================================================================
 *  设备 / 布局（由 compat.js 识别的 data-layout 驱动）
 * ================================================================== */
function isMobileLayout() {
  if (window.DG) return window.DG.layout === 'mobile';
  return !!(document.documentElement.getAttribute('data-layout') === 'mobile');
}

function layoutName(l) { return l === 'mobile' ? '手机版' : '电脑版'; }

function renderLayoutToggles() {
  const cur = (window.DG && window.DG.layout) || document.documentElement.getAttribute('data-layout') || 'desktop';
  const next = cur === 'mobile' ? 'desktop' : 'mobile';
  document.querySelectorAll('.js-layout-toggle').forEach((b) => {
    b.textContent = (cur === 'mobile' ? '🖥 ' : '📱 ') + '切换到' + layoutName(next);
    b.title = '当前是' + layoutName(cur) + '，点击切换（会记住选择）';
  });
  const hint = $('layout-hint');
  if (hint) {
    const mode = window.DG ? window.DG.mode : 'auto';
    hint.textContent = mode === 'auto'
      ? '已按设备自动识别为' + layoutName(cur)
      : '已手动锁定为' + layoutName(cur) + '（换设备也不会自动切）';
  }
}

/* 底部面板折叠：手机版给画手腾出整块画布 */
function setSheetCollapsed(v) {
  const side = $('side');
  if (!side) return;
  side.classList.toggle('collapsed', !!v);
  const label = $('sheet-label');
  if (label) label.textContent = v ? '展开玩家 / 聊天' : '玩家 / 聊天';
  requestAnimationFrame(() => { if (typeof resizeCanvas === 'function') resizeCanvas(); });
}

/* compat.js 在切换布局时会回调这里 */
window.DG_ON_LAYOUT = function (layout) {
  renderLayoutToggles();
  if (layout === 'mobile') setSheetCollapsed(false);
  if (typeof resizeCanvas === 'function') resizeCanvas();
};

/* 盲画模式的角标：告诉画手「不是画丢了，是故意的」 */
function renderBlindBadge() {
  const el = $('blind-badge');
  if (!el) return;
  const on = blindActive();
  el.classList.toggle('show', on);
  if (on) el.textContent = '🙈 盲画模式 · 你的笔迹 ' + (BLIND_DELAY / 1000) + ' 秒后才显形';
}

/* ==================================================================
 *  延迟指示器
 *  公网隧道实测 p50 355ms、p90 575ms；局域网 <1ms。
 *  把这个数字摆出来，用户能立刻判断「卡是网络的锅还是游戏的锅」。
 * ================================================================== */
function renderPing() {
  const el = $('ping');
  if (!el) return;
  if (!S.pingMs) { el.textContent = '-- ms'; el.className = 'ping'; return; }
  const ms = S.pingMs;
  el.textContent = ms + ' ms';
  el.className = 'ping ' + (ms < 80 ? 'good' : ms < 220 ? 'ok' : 'bad');
  el.title = '到服务器的往返延迟（每 4 秒刷新）：' + ms + ' ms' +
    (ms < 80 ? ' · 局域网级' : ms < 220 ? ' · 公网可用' : ' · 公网偏高，笔画会有延迟');
}

function startPingLoop() {
  if (S.pingTimer) clearInterval(S.pingTimer);
  const beat = () => { if (S.ws && S.ws.readyState === 1) send({ t: 'ping', ts: Date.now() }); };
  beat();
  S.pingTimer = setInterval(beat, 4000);
}

/* 画布底色：白色物体（饺子、雪人、云）画在白底上会隐形，换个底色就解决了 */
const CANVAS_BG = ['#ffffff', '#e9eef4', '#2b2f38'];
const BG_NAMES = ['白', '浅灰', '深色'];

function setCanvasBg(color) {
  if (CANVAS_BG.indexOf(color) < 0) color = CANVAS_BG[0];
  S.bg = color;
  canvas.style.background = color;
  document.querySelectorAll('#bgs .bg-dot').forEach((b) => {
    b.classList.toggle('on', b.dataset.bg === color);
  });
  requestRender();
}

function renderReacts() {
  const bar = $('react-bar');
  if (bar.children.length) return;
  REACTS.forEach((e) => {
    const b = document.createElement('button');
    b.className = 'react-btn';
    b.textContent = e;
    b.onclick = () => { send({ t: 'react', emoji: e }); spawnEmoji(e); };
    bar.appendChild(b);
  });
}

function spawnEmoji(e) {
  const layer = $('float-layer');
  const d = document.createElement('div');
  d.className = 'float-emoji';
  d.textContent = e;
  d.style.left = (8 + Math.random() * 78) + '%';
  d.style.animationDelay = (Math.random() * 0.15) + 's';
  layer.appendChild(d);
  setTimeout(() => d.remove(), 2700);
}

/* ==================================================================
 *  Canvas 绘图
 * ================================================================== */
const canvas = $('board');
const ctx = canvas.getContext('2d');
let CW = 0, CH = 0;

/** 移动端要压住 devicePixelRatio：不少安卓机报 3~4，
 *  按原值分配画布会得到上千万像素，rAF 重绘直接卡成幻灯片。 */
function pixelRatioFor(w, h) {
  const raw = window.devicePixelRatio || 1;
  const cap = isMobileLayout() ? 2 : 3;
  let dpr = Math.min(raw, cap);
  // 再兜一道：总像素不超过 420 万
  const MAX_PX = 4.2e6;
  while (dpr > 1 && w * dpr * h * dpr > MAX_PX) dpr -= 0.25;
  return Math.max(1, dpr);
}

function resizeCanvas() {
  const wrap = canvas.parentElement;
  const w = Math.max(1, wrap.clientWidth);
  const h = Math.max(1, wrap.clientHeight);
  const dpr = pixelRatioFor(w, h);
  CW = w; CH = h;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  requestRender();
}

function strokeWidthOf(s) {
  return Math.max(1, s.w * Math.min(CW, CH));
}

/** 画一条笔迹。limitPts 用于「远端笔画渐进显形」——只画到第 n 个点 */
function paintStroke(c, s, limitPts) {
  const pts = s.pts;
  if (!pts || pts.length < 2) return;
  const maxLen = limitPts ? Math.min(pts.length, limitPts * 2) : pts.length;
  if (maxLen < 2) return;
  c.save();
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.strokeStyle = s.mode === 'eraser' ? (S.bg || '#ffffff') : s.color;
  c.fillStyle = c.strokeStyle;
  c.lineWidth = strokeWidthOf(s);
  if (maxLen === 2) {
    c.beginPath();
    c.arc(pts[0] * CW, pts[1] * CH, c.lineWidth / 2, 0, Math.PI * 2);
    c.fill();
  } else {
    c.beginPath();
    c.moveTo(pts[0] * CW, pts[1] * CH);
    for (let i = 2; i < maxLen; i += 2) c.lineTo(pts[i] * CW, pts[i + 1] * CH);
    c.stroke();
  }
  c.restore();
}

function requestRender() {
  if (S.rafPending) return;
  S.rafPending = true;
  requestAnimationFrame(() => {
    S.rafPending = false;
    render();
  });
}

/* 「盲画模式」：画手看不到自己刚画的东西，笔迹延迟 BLIND_DELAY 才显形。
   猜词者不受影响（不然没人看得出画的是什么，笑点就没了）。 */
const BLIND_DELAY = 3000;
let blindTimer = null;

function blindActive() {
  return !!(S.blindDraw && S.isDrawer && S.room && S.room.state === 'playing');
}

function strokeVisible(s) {
  if (!blindActive()) return true;
  if (!s.bornAt) return true;                       // 服务器下发的历史笔迹直接可见
  return Date.now() - s.bornAt >= BLIND_DELAY;
}

function scheduleBlindRender() {
  if (blindTimer) return;
  blindTimer = setInterval(() => {
    if (!blindActive()) { clearInterval(blindTimer); blindTimer = null; return; }
    requestRender();
  }, 400);
}

/* ==================================================================
 *  远端笔画渐进显形（抗抖动）
 * ------------------------------------------------------------------
 *  公网隧道实测 p50 355ms、p90 575ms、最坏能到 2s —— 数据包是一阵一阵到的。
 *  如果收到就整段画出来，观感就是「一顿一顿」。
 *  这里让远端笔画按指数逼近的方式逐点显形：落后越多追得越快，
 *  抖动被抹平成匀速笔触，代价只是极小的追赶延迟（局域网下几乎无感）。
 * ================================================================== */
const SMOOTH_LAG_MAX = 260;      // 落后超过这么多点就全速追（防止越拖越远）

/* ==================================================================
 *  外推预测
 * ------------------------------------------------------------------
 *  公网隧道 355ms 的往返是改不了的，但可以把「画笔已经到这儿了」的
 *  感知提前一点点：远端笔画在**活跃接收**状态下，按最近一段的方向往前猜一小段。
 *
 *  三条保守约束（避免甩尾穿帮）：
 *    ① 只有最近 320ms 内收到过数据才算「活跃」，停笔就不猜；
 *    ② 必须已经追平真实数据才外推，否则预测会跑到显形前面；
 *    ③ 外推长度有上限（最近线段的 55%，且不超过画布短边 3.5%）。
 *  真实数据一到，预测尾巴会被真实笔迹自然覆盖，不需要额外回拉。
 * ================================================================== */
const PREDICT_ACTIVE_MS = 320;
const PREDICT_FRACTION = 0.55;
const PREDICT_CAP = 0.035;

function predictTail(s) {
  if (s.local) return null;
  if (!s.lastAt || Date.now() - s.lastAt > PREDICT_ACTIVE_MS) return null;
  const n = s.pts.length;
  if (n < 6) return null;
  const total = (n / 2) | 0;
  if (s.revealed === undefined || s.revealed < total - 0.5) return null;
  const x0 = s.pts[n - 4], y0 = s.pts[n - 3];
  const x1 = s.pts[n - 2], y1 = s.pts[n - 1];
  let dx = (x1 - x0) * PREDICT_FRACTION;
  let dy = (y1 - y0) * PREDICT_FRACTION;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.0015) return null;                   // 几乎没动，别猜
  if (len > PREDICT_CAP) { const k = PREDICT_CAP / len; dx *= k; dy *= k; }
  return [x1 + dx, y1 + dy];
}

/** 只画「最后一小段 + 预测点」，不改动已显形的部分 */
function paintTail(c, s, tail) {
  const n = s.pts.length;
  c.save();
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.strokeStyle = s.mode === 'eraser' ? (S.bg || '#ffffff') : s.color;
  c.lineWidth = strokeWidthOf(s);
  c.beginPath();
  c.moveTo(s.pts[n - 2] * CW, s.pts[n - 1] * CH);
  c.lineTo(tail[0] * CW, tail[1] * CH);
  c.stroke();
  c.restore();
}

function advanceReveal() {
  let need = false;
  // 延迟越低追得越快：局域网几乎不引入额外延迟，公网才靠平滑抹抖
  const rtt = S.pingMs || 0;
  const rate = rtt < 80 ? 0.6 : rtt < 250 ? 0.35 : 0.22;
  const now = Date.now();
  for (let i = 0; i < S.strokes.length; i++) {
    const s = S.strokes[i];
    if (s.local) continue;                       // 自己的笔迹直接全显，不做平滑
    // 活跃笔画要持续重绘：预测尾巴会在停笔 320ms 后消失
    if (s.lastAt && now - s.lastAt <= PREDICT_ACTIVE_MS) need = true;
    const total = (s.pts.length / 2) | 0;
    if (s.revealed === undefined) s.revealed = 1;
    if (s.revealed >= total) continue;
    const behind = total - s.revealed;
    if (behind > SMOOTH_LAG_MAX) s.revealed = total;    // 落后太多就别磨蹭了
    else s.revealed += Math.max(0.6, behind * rate);
    need = true;
  }
  return need;
}

let revealLoop = null;
function startRevealLoop() {
  if (revealLoop) return;
  const tick = () => {
    if (advanceReveal()) {
      render();
      revealLoop = requestAnimationFrame(tick);
    } else {
      revealLoop = null;
    }
  };
  revealLoop = requestAnimationFrame(tick);
}

function render() {
  if (!CW) return;
  // 先铺底色：画白色物体（饺子、雪人、云…）时换成深色底就看得见了
  ctx.fillStyle = S.bg || '#ffffff';
  ctx.fillRect(0, 0, CW, CH);
  const blind = blindActive();
  for (let i = 0; i < S.strokes.length; i++) {
    const s = S.strokes[i];
    if (blind && !strokeVisible(s)) continue;
    paintStroke(ctx, s, s.local ? undefined : s.revealed);
  }
  // 正在画的那一笔在盲画模式下也不给看
  if (S.cur && !blind) paintStroke(ctx, S.cur);
  // 远端笔画的外推尾巴
  if (!blind) {
    for (let i = 0; i < S.strokes.length; i++) {
      const tail = predictTail(S.strokes[i]);
      if (tail) paintTail(ctx, S.strokes[i], tail);
    }
  }
}

function resetCanvas() {
  S.strokes = [];
  S.strokeMap.clear();
  S.cur = null;
  S.pending = [];
  requestRender();
}

function onDraw(m) {
  if (m.op === 'fill') {
    if (m.bg) setCanvasBg(m.bg);
    S.strokes = Array.isArray(m.strokes) ? m.strokes.map((s) => ({ ...s, pts: s.pts.slice() })) : [];
    S.strokeMap.clear();
    S.strokes.forEach((s) => S.strokeMap.set(s.sid, s));
    S.cur = null;
    requestRender();
    return;
  }
  if (m.op === 'bg') { setCanvasBg(m.bg); return; }
  if (m.op === 'begin') {
    const s = { sid: m.sid, color: m.color, w: m.w, mode: m.mode, pts: [m.x, m.y], revealed: 1 };
    S.strokes.push(s);
    S.strokeMap.set(m.sid, s);
    requestRender();
    return;
  }
  if (m.op === 'pts') {
    const s = S.strokeMap.get(m.sid);
    if (s && Array.isArray(m.pts)) {
      for (let i = 0; i < m.pts.length; i++) s.pts.push(m.pts[i]);
      s.lastAt = Date.now();             // 外推预测用它判断笔画是否还在「活跃接收」
      startRevealLoop();                 // 逐点显形，抹平公网抖动
      requestRender();
    }
    return;
  }
  if (m.op === 'end') { const s = S.strokeMap.get(m.sid); if (s) s.lastAt = 0; startRevealLoop(); return; }
  if (m.op === 'undo') { const s = S.strokes.pop(); if (s) S.strokeMap.delete(s.sid); requestRender(); return; }
  if (m.op === 'clear') { S.strokes = []; S.strokeMap.clear(); requestRender(); return; }
}

/* ==================================================================
 *  输入层（统一 pointer / touch / mouse）
 * ------------------------------------------------------------------
 *  只在有 PointerEvent 时才用 pointer 事件：iOS 13 以下和老 Android
 *  WebView 都没有它，只能退回 touch + mouse。
 *  另外用 activeId 只认第一根手指——防止手掌边缘误触打断笔画。
 * ================================================================== */
function posOf(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  // 保留 4 位小数：1000px 画布上精度 0.1px，肉眼无差别，
  // 但 JSON 体积能小三分之一左右，公网下每帧少传不少字节
  const r4 = (v) => Math.round(v * 10000) / 10000;
  return [
    r4(Math.max(0, Math.min(1, (clientX - r.left) / r.width))),
    r4(Math.max(0, Math.min(1, (clientY - r.top) / r.height)))
  ];
}

function flushPoints() {
  if (!S.pending.length || !S.cur) return;
  send({ t: 'draw', op: 'pts', sid: S.cur.sid, pts: S.pending.slice() });
  S.pending = [];
}
let flushTimer = null;
/** 落笔后头 140ms 用 16ms 间隔——把「按下去有没有反应」的延迟压到最低；
 *  之后回到 45ms，避免长笔画把包发得太碎。 */
function scheduleFlush(young) {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; flushPoints(); }, young ? 16 : 45);
}

let activeId = null;                 // 正在画的那根手指 / 鼠标

function canDrawNow() {
  return !!(S.isDrawer && S.room && S.room.state === 'playing' && !S.boardLocked);
}

function drawStart(id, clientX, clientY) {
  if (!canDrawNow()) return false;
  if (activeId !== null) return false;          // 多指：只认第一根
  activeId = id;
  const [x, y] = posOf(clientX, clientY);
  S.fx = x; S.fy = y;             // 平滑滤波的起点必须精确落在落笔处，否则笔画会缩水
  const sid = ++S.sid;
  const mode = S.tool === 'eraser' ? 'eraser' : 'pen';
  S.cur = { sid, color: S.color, w: mode === 'eraser' ? S.width * 2.2 : S.width, mode, pts: [x, y], bornAt: Date.now(), local: true };
  S.pending = [];
  S.drawing = true;
  send({ t: 'draw', op: 'begin', sid, color: S.cur.color, w: S.cur.w, mode, x, y });
  if (blindActive()) { scheduleBlindRender(); renderBlindBadge(); }
  requestRender();
  return true;
}

/** 手指和鼠标画出来的必然是锯齿。用一阶低通把点流抹平：
 *  每个输出点向当前原始点追近固定比例 —— 高频抖动被吃掉，笔画走向保留。
 *  起点在 drawStart 里精确定位，所以笔画不会整体偏移。
 *  想调手感只改这个数（0 = 不平滑；越大越平滑，但太大笔会跟不上手）。 */
const STROKE_SMOOTH = 0.34;

function drawMove(id, clientX, clientY) {
  if (!S.drawing || !S.cur || id !== activeId) return;
  const [rx, ry] = posOf(clientX, clientY);
  // 平滑后的点才进画布和网络 —— 画手和猜词者看到的是同一条干净的线
  if (S.fx === undefined) { S.fx = rx; S.fy = ry; }
  S.fx += (rx - S.fx) * (1 - STROKE_SMOOTH);
  S.fy += (ry - S.fy) * (1 - STROKE_SMOOTH);
  const x = Math.round(S.fx * 10000) / 10000;
  const y = Math.round(S.fy * 10000) / 10000;
  S.cur.pts.push(x, y);
  S.pending.push(x, y);
  if (S.pending.length >= 20) flushPoints();
  else scheduleFlush(Date.now() - (S.cur.bornAt || 0) < 140);
  requestRender();
}

function drawEnd(id) {
  if (!S.drawing || !S.cur) return;
  if (id !== null && activeId !== null && id !== activeId) return;
  S.drawing = false;
  activeId = null;
  flushPoints();
  send({ t: 'draw', op: 'end', sid: S.cur.sid });
  S.strokes.push(S.cur);
  S.strokeMap.set(S.cur.sid, S.cur);
  S.cur = null;
  requestRender();
}

/* passive 支持探测：老浏览器会把 {passive:false} 当成 useCapture 布尔值 */
const PASSIVE_OK = (function () {
  let ok = false;
  try {
    const o = Object.defineProperty({}, 'passive', { get() { ok = true; return false; } });
    window.addEventListener('dg-probe', null, o);
    window.removeEventListener('dg-probe', null, o);
  } catch (e) {}
  return ok;
})();
const TOUCH_OPT = PASSIVE_OK ? { passive: false } : false;

if (window.PointerEvent) {
  canvas.addEventListener('pointerdown', (ev) => {
    if (!canDrawNow()) return;
    ev.preventDefault();
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) {}
    drawStart(ev.pointerId, ev.clientX, ev.clientY);
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (!S.drawing) return;
    ev.preventDefault();
    drawMove(ev.pointerId, ev.clientX, ev.clientY);
  });
  canvas.addEventListener('pointerup', (ev) => drawEnd(ev.pointerId));
  canvas.addEventListener('pointercancel', (ev) => drawEnd(ev.pointerId));
  canvas.addEventListener('pointerleave', (ev) => { if (S.drawing) drawEnd(ev.pointerId); });
} else {
  canvas.addEventListener('touchstart', (ev) => {
    if (!canDrawNow()) return;                  // 不是画手就别拦，让页面正常滚动
    ev.preventDefault();
    const t = ev.changedTouches[0];
    if (t) drawStart('t' + t.identifier, t.clientX, t.clientY);
  }, TOUCH_OPT);
  canvas.addEventListener('touchmove', (ev) => {
    if (!S.drawing) return;
    ev.preventDefault();
    const t = ev.changedTouches[0];
    if (t) drawMove('t' + t.identifier, t.clientX, t.clientY);
  }, TOUCH_OPT);
  const onTouchEnd = (ev) => {
    const t = ev.changedTouches[0];
    drawEnd(t ? 't' + t.identifier : null);
  };
  canvas.addEventListener('touchend', onTouchEnd);
  canvas.addEventListener('touchcancel', onTouchEnd);

  canvas.addEventListener('mousedown', (ev) => {
    if (!canDrawNow()) return;
    ev.preventDefault();
    drawStart('m', ev.clientX, ev.clientY);
  });
  window.addEventListener('mousemove', (ev) => { if (S.drawing) drawMove('m', ev.clientX, ev.clientY); });
  window.addEventListener('mouseup', () => drawEnd('m'));
}
canvas.addEventListener('contextmenu', (e) => e.preventDefault());


/* ==================================================================
 *  UI 装配
 * ================================================================== */
function buildUI() {
  // 头像
  const ap = $('avatar-picker');
  AVATARS.forEach((a) => {
    const b = document.createElement('button');
    b.className = 'avatar-opt' + (a === S.myAvatar ? ' on' : '');
    b.innerHTML = avatarImg(a);
    b.onclick = () => {
      S.myAvatar = a;
      [...ap.children].forEach((c) => c.classList.toggle('on', c === b));
    };
    ap.appendChild(b);
  });

  // 颜色
  const cp = $('colors');
  PALETTE.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'color-dot' + (i === 0 ? ' on' : '');
    b.style.background = c;
    b.onclick = () => {
      S.color = c;
      S.tool = 'pen';
      $('tool-eraser').classList.remove('on');
      [...cp.children].forEach((x) => x.classList.toggle('on', x === b));
    };
    cp.appendChild(b);
  });

  // 画布底色（画白色物体时换深色底）
  const bp = $('bgs');
  CANVAS_BG.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'bg-dot' + (i === 0 ? ' on' : '');
    b.dataset.bg = c;
    b.style.background = c;
    b.title = BG_NAMES[i] + '底';
    b.onclick = () => {
      setCanvasBg(c);
      send({ t: 'draw', op: 'bg', bg: c });
    };
    bp.appendChild(b);
  });

  // 粗细
  $('wsizes').querySelectorAll('.wsize').forEach((b) => {
    b.onclick = () => {
      S.width = Number(b.dataset.w);
      $('wsizes').querySelectorAll('.wsize').forEach((x) => x.classList.toggle('on', x === b));
    };
  });

  // 橡皮 / 撤销 / 清空
  $('tool-eraser').onclick = () => {
    S.tool = S.tool === 'eraser' ? 'pen' : 'eraser';
    $('tool-eraser').classList.toggle('on', S.tool === 'eraser');
  };
  $('tool-undo').onclick = () => send({ t: 'draw', op: 'undo' });
  $('tool-clear').onclick = () => { if (confirm('清空整个画布？')) send({ t: 'draw', op: 'clear' }); };
  $('tool-reveal').onclick = () => send({ t: 'reveal' });

  // 音效
  $('btn-sound').onclick = () => {
    S.muted = !S.muted;
    $('btn-sound').textContent = S.muted ? '🔇' : '🔊';
  };

  // 轮数 / 时长
  $('seg-rounds').querySelectorAll('button').forEach((b) => {
    b.onclick = () => send({ t: 'settings', rounds: Number(b.dataset.v) });
  });
  $('seg-duration').querySelectorAll('button').forEach((b) => {
    b.onclick = () => send({ t: 'settings', duration: Number(b.dataset.v) });
  });
  $('seg-reroll').querySelectorAll('button').forEach((b) => {
    b.onclick = () => send({ t: 'settings', reroll: Number(b.dataset.v) });
  });

  // 布局切换按钮（登录页 / 游戏内各一个）
  document.querySelectorAll('.js-layout-toggle').forEach((b) => {
    b.onclick = () => {
      if (window.DG) window.DG.toggle();
      else document.documentElement.setAttribute('data-layout', isMobileLayout() ? 'desktop' : 'mobile');
      setTimeout(resizeCanvas, 60);
    };
  });
  renderLayoutToggles();

  // 手机版底部面板折叠
  const handle = $('sheet-handle');
  if (handle) {
    handle.onclick = () => setSheetCollapsed(!$('side').classList.contains('collapsed'));
  }

  // 复制房间号 / 复制分享地址（统一走带兜底的 copyText）
  wireCopy('btn-copy', 'lobby-code');
  wireCopy('btn-copy-url', 'tip-url');

  // 开始 / 再来一局
  $('btn-start').onclick = () => send({ t: 'start' });
  $('btn-again').onclick = () => send({ t: 'again' });

  // 选词阶段的换一批 / 自定义出题
  $('btn-reroll').onclick = () => send({ t: 'reroll' });
  $('btn-custom-go').onclick = submitCustomWord;
  $('input-custom').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitCustomWord(); }
  });

  // 自定义词库导入
  $('btn-custom-apply').onclick = applyCustomWords;
  $('btn-custom-clear').onclick = () => {
    $('custom-words').value = '';
    send({ t: 'settings', customWords: [] });
  };

  // 猜词输入
  const gi = $('input-guess');
  function submitGuess() {
    const v = gi.value.trim();
    if (!v) return;
    send({ t: 'guess', text: v });
    gi.value = '';
  }
  $('btn-send').onclick = submitGuess;
  gi.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitGuess(); });
  // 手机上软键盘弹出会把视口压扁，聚焦后把输入框滚进可视区
  gi.addEventListener('focus', () => {
    if (!isMobileLayout()) return;
    setTimeout(() => {
      try { gi.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
      catch (e) { try { gi.scrollIntoView(false); } catch (e2) {} }
      scrollChat();
    }, 280);
  });

  // 分享地址：带上协议头，朋友直接粘到浏览器就能开
  $('tip-url').textContent = location.origin;

  // 快捷键
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'z' || e.key === 'Z') { if (S.isDrawer) send({ t: 'draw', op: 'undo' }); }
    if (e.key === 'e' || e.key === 'E') { $('tool-eraser').click(); }
    if (e.key >= '1' && e.key <= '3') {
      const bs = $('wsizes').querySelectorAll('.wsize');
      const btn = bs[Number(e.key) - 1];
      if (btn) btn.click();
    }
  });

  // 登录按钮
  $('btn-create').onclick = doLogin;
  $('btn-join').onclick = doLogin;
  $('input-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  $('input-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

  renderReacts();

  const ro = new ResizeObserver(() => resizeCanvas());
  ro.observe(canvas.parentElement);
  window.addEventListener('resize', resizeCanvas);
  window.addEventListener('orientationchange', () => setTimeout(resizeCanvas, 250));

  /* 切后台回来 / 亮屏 / 网络恢复 → 立刻重连。
     这几个事件是最可靠的「我刚被挂起过」信号：被挂起时定时器会被节流，
     光靠退避计时器可能要几十秒才轮到，而用户回来第一眼看到的还是"掉线"。 */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') kickReconnect();
  });
  window.addEventListener('pageshow', kickReconnect);
  window.addEventListener('online', () => {
    addMsg('网络恢复了，正在重连…', 'sys');
    kickReconnect();
  });
  window.addEventListener('offline', () => {
    const b = $('turn-banner');
    if (b && S.joined) b.textContent = '⚠️ 网络已断开…';
  });

  // 自动填名字，省事
  // 稳定的玩家 id：断线重连时用它复用身份，分数才不会丢
  S.playerId = localStorage.getItem('dg_pid');
  if (!S.playerId) {
    S.playerId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    localStorage.setItem('dg_pid', S.playerId);
  }

  const saved = localStorage.getItem('dg_name');
  if (saved) $('input-name').value = saved;
  const savedAv = localStorage.getItem('dg_avatar');
  if (savedAv && AVATARS.includes(savedAv)) {
    S.myAvatar = savedAv;
    [...ap.children].forEach((c) => c.classList.toggle('on', c.textContent === savedAv));
  }

  /* ================= 邀请链接：?room=1234 =================
   * 点开邀请链接 → 自动填好房间号；昵称之前存过就直接进房，一步都不用点。
   * 没存过昵称就聚焦昵称框，让他起个名字再进。 */
  wireCopy('btn-copy-invite', 'invite-url');

  // 开发者 QQ：点一下复制。手机浏览器里长按选中一段数字很别扭，
  // 这里直接点一下就给到剪贴板，跟房间号用的是同一套兜底逻辑。
  const qq = $('credit-qq');
  if (qq) {
    qq.onclick = () => copyText(qq.textContent.trim()).then((ok) => {
      if (!ok) return;
      const old = qq.textContent;
      qq.textContent = '已复制 ✓';
      setTimeout(() => { qq.textContent = old; }, 1400);
    });
  }
  const invited = (location.search.match(/[?&]room=(\d{4})(?!\d)/) || [])[1];
  if (invited) {
    $('input-code').value = invited;
    $('invite-tip').textContent = saved
      ? '已自动填入房间 ' + invited + '，正在进房…'
      : '已自动填入房间 ' + invited + '，给自己起个名字就能进';
    if (saved) {
      // 伪造一个 event 交给 doLogin：它只读 ev.currentTarget 来区分"建房 / 加入"
      setTimeout(() => doLogin({ currentTarget: $('btn-join'), preventDefault() {} }), 150);
    } else {
      $('input-name').focus();
    }
  }
}

let loading = false;
function doLogin(ev) {
  const name = $('input-name').value.trim();
  if (!name) { $('login-err').textContent = '先给自己起个名字吧'; $('input-name').focus(); return; }
  const codeEl = $('input-code');
  const isJoin = (ev && ev.currentTarget === $('btn-join')) || false;
  const code = isJoin ? codeEl.value.trim() : '';
  if (isJoin && !/^\d{4}$/.test(code)) { $('login-err').textContent = '房间号是 4 位数字'; return; }
  if (loading) return;
  loading = true;
  $('login-err').textContent = '连接中…';
  $('btn-create').disabled = $('btn-join').disabled = true;
  localStorage.setItem('dg_name', name);
  localStorage.setItem('dg_avatar', S.myAvatar);
  connect(name, code, S.myAvatar, (msg) => {
    loading = false;
    $('login-err').textContent = msg;
    $('btn-create').disabled = $('btn-join').disabled = false;
  });
}

/* ==================================================================
 *  倒计时
 * ================================================================== */
setInterval(() => {
  if (!S.room || (S.room.state !== 'playing')) {
    if (S.room && S.room.state !== 'playing') {
      $('timer-num').textContent = '--';
      $('timer-num').classList.remove('low');
      $('tbar').querySelector('i').style.width = '100%';
      $('tbar').classList.remove('low');
    }
    return;
  }
  if (S.isDrawer) {
    $('timer-num').textContent = '✏️';
  }
  const now = Date.now() + S.offset;
  const left = Math.max(0, (S.endTime - now) / 1000);
  const sec = Math.ceil(left);
  $('timer-num').textContent = S.isDrawer ? String(sec) : String(sec);
  $('timer-num').classList.toggle('low', sec <= 10);
  const pct = S.duration ? Math.max(0, Math.min(100, (left * 1000 / S.duration) * 100)) : 0;
  $('tbar').querySelector('i').style.width = pct + '%';
  $('tbar').classList.toggle('low', sec <= 10);
}, 100);

/* ---------------- 启动 ---------------- */
buildUI();
setCanvasBg(S.bg);          // 初始化画布底色（默认白）
resizeCanvas();
renderLayoutToggles();
/* 手机版不自动聚焦昵称：会立刻弹出软键盘、还可能触发页面缩放 */
if (!isMobileLayout()) $('input-name').focus();
/* 布局稳定后再量一次（地址栏收缩 / 字体加载完成都会影响画布尺寸） */
setTimeout(resizeCanvas, 300);
window.addEventListener('load', () => setTimeout(resizeCanvas, 120));
