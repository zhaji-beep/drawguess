'use strict';
/**
 * v2 玩法集成测试：主题词库 / 连击 / 追赶 / 开天眼 / 结算称号 / 全局限定不重复
 *
 * ⚠️ 必须用「快速节奏」启动服务，否则等不到下一回合会超时：
 *   PORT=3100 TURN_END_DELAY=1200 VOTE_WINDOW_MS=800 node server.js
 *   PORT=3100 node test/v2.js
 *
 * 最省事的办法是直接跑 test/run-all.js —— 它会自动用正确参数起服务。
 */
const http = require('http');
const crypto = require('crypto');
const { WORDS } = require('../words');
const CAT_OF = new Map(WORDS.map((w) => [w[0], w[1]]));
const PORT = Number(process.env.PORT) || 3100;
const HOST = '127.0.0.1';

let fails = 0;
function T(name, ok, extra) {
  console.log((ok ? '  \u2713 ' : '  \u2717 ') + name + (extra ? '   -> ' + extra : ''));
  if (!ok) fails++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function encFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  const mask = crypto.randomBytes(4);
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = 0x80 | len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 0x80 | 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
  head[0] = 0x80 | opcode;
  const body = Buffer.alloc(len);
  for (let i = 0; i < len; i++) body[i] = data[i] ^ mask[i & 3];
  return Buffer.concat([head, mask, body]);
}
function decFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0], b1 = buf[1];
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) === 0x80;
  let len = b1 & 0x7f, off = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = buf.readUInt32BE(6); off = 10; }
  let mask = null;
  if (masked) { if (buf.length < off + 4) return null; mask = buf.slice(off, off + 4); off += 4; }
  if (buf.length < off + len) return null;
  const p = Buffer.from(buf.slice(off, off + len));
  if (mask) for (let i = 0; i < p.length; i++) p[i] ^= mask[i & 3];
  return { opcode, payload: p, total: off + len };
}

class Client {
  constructor(tag) { this.tag = tag; this.inbox = []; }
  connect() {
    return new Promise((res, rej) => {
      const key = crypto.randomBytes(16).toString('base64');
      const req = http.request({
        port: PORT, host: HOST,
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' }
      });
      req.on('upgrade', (r, socket, head) => {
        this.socket = socket; this.buf = Buffer.alloc(0);
        if (head && head.length) this.buf = head;
        socket.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.drain(); });
        socket.on('error', () => {});
        res(this);
      });
      req.on('error', rej);
      req.end();
    });
  }
  drain() {
    for (;;) {
      const f = decFrame(this.buf);
      if (!f) break;
      this.buf = this.buf.slice(f.total);
      if (f.opcode === 0x1) { let m; try { m = JSON.parse(f.payload.toString('utf8')); } catch (e) { continue; } this.inbox.push(m); }
      else if (f.opcode === 0x9) this.socket.write(encFrame(0xa, Buffer.alloc(0)));
      else if (f.opcode === 0x8) this.socket.destroy();
    }
  }
  take(type) {
    const i = this.inbox.findIndex((m) => m.t === type);
    return i >= 0 ? this.inbox.splice(i, 1)[0] : null;
  }
  async wait(type, timeout) {
    const end = Date.now() + (timeout || 8000);
    while (Date.now() < end) {
      const m = this.take(type);
      if (m) return m;
      await sleep(25);
    }
    throw new Error(this.tag + ' 等待 ' + type + ' 超时');
  }
  clear() { this.inbox.length = 0; }
  send(o) { this.socket.write(encFrame(0x1, JSON.stringify(o))); }
  close() { try { this.socket.destroy(); } catch (e) {} }
}

const THEMES = ['动物', '食物'];

(async () => {
  console.log('\n=== v2 玩法集成测试 ===\n');

  // 防呆：服务端必须用快速节奏启动，否则投票窗口太长会等不到下一回合
  if (!process.env.VOTE_WINDOW_MS) {
    console.log('  ⚠️  提示：没检测到 VOTE_WINDOW_MS。');
    console.log('      本测试需要服务端以快速节奏启动，否则会卡在「等下一回合选词」：');
    console.log('        PORT=' + PORT + ' TURN_END_DELAY=1200 VOTE_WINDOW_MS=800 node server.js');
    console.log('      或者直接跑 test/run-all.js（会自动带正确参数）。');
    console.log('');
  }
  const A = new Client('A'), B = new Client('B'), C = new Client('C');
  const all = [A, B, C];
  try {
    await A.connect();
    A.send({ t: 'join', name: '阿甲', avatar: '🐼' });
    const ja = await A.wait('joined');
    const code = ja.room.code;

    T('服务端下发词库分类（大厅主题按钮用）', Array.isArray(ja.cats) && ja.cats.length >= 20,
      ja.cats.length + ' 个分类');
    T('服务端下发词库总量', ja.wordBank && ja.wordBank.total >= 500,
      ja.wordBank ? ja.wordBank.total + ' 词' : '无');
    T('分类带词数（前端展示）', ja.cats.every((c) => c.name && c.count > 0),
      ja.cats.slice(0, 4).map((c) => c.name + ':' + c.count).join(' '));

    await B.connect(); B.send({ t: 'join', name: '阿乙', roomCode: code, avatar: '🦊' });
    await B.wait('joined');
    await C.connect(); C.send({ t: 'join', name: '阿丙', roomCode: code, avatar: '🐯' });
    await C.wait('joined');
    await sleep(150);

    /* ---------- 主题词库 ---------- */
    A.clear(); B.clear(); C.clear();
    A.send({ t: 'settings', themes: THEMES, rounds: 6, duration: 30 });
    await sleep(250);
    const st = await A.wait('state');
    T('房主可限定词库主题', Array.isArray(st.room.themes) && st.room.themes.join() === THEMES.join(),
      st.room.themes.join('+'));
    T('词池规模随主题收窄', st.room.pool.total > 0 && st.room.pool.total < ja.wordBank.total,
      '全部 ' + ja.wordBank.total + ' → 限定后 ' + st.room.pool.total);
    T('非房主改主题无效', await (async () => {
      B.clear();
      B.send({ t: 'settings', themes: ['科技'] });
      await sleep(250);
      const s = await A.wait('state', 2000).catch(() => null);
      return !s || s.room.themes.join() === THEMES.join();
    })());

    /* ---------- 打满 6 轮 ---------- */
    A.clear(); B.clear(); C.clear();
    A.send({ t: 'start' });

    const usedWords = [];
    const comboByPlayer = {};
    const totalTurns = 6 * 3;

    for (let turn = 0; turn < totalTurns; turn++) {
      // 等画手
      let drawer = null, wc = null;
      for (let i = 0; i < 200 && !drawer; i++) {
        for (const c of all) {
          const m = c.take('wordChoice');
          if (m) { drawer = c; wc = m; break; }
        }
        if (!drawer) await sleep(25);
      }
      if (!drawer) throw new Error('第 ' + (turn + 1) + ' 回合没有等到选词');
      const guessers = all.filter((c) => c !== drawer);

      if (turn === 0) {
        T('候选词 3 个且难度各异', wc.words.length === 3 &&
          new Set(wc.words.map((w) => w.d)).size === 3,
          wc.words.map((w) => w.w + '(' + w.d + ')').join(' / '));
        T('候选词全部落在房主限定的主题内',
          wc.words.every((w) => THEMES.includes(CAT_OF.get(w.w))),
          wc.words.map((w) => w.w + ':' + CAT_OF.get(w.w)).join(' / '));
      }

      drawer.clear();
      drawer.send({ t: 'chooseWord', word: wc.words[0].w });
      const dw = await drawer.wait('drawerWord');
      const answer = dw.word;
      usedWords.push(answer);

      // 第 3 回合验证「开天眼」
      if (turn === 2 && [...answer].length >= 2) {
        drawer.clear(); A.clear(); B.clear(); C.clear();
        drawer.send({ t: 'reveal' });
        const ru = await drawer.wait('revealUsed', 3000);
        const h = await A.wait('hint', 3000).catch(() => null);
        T('开天眼：画手收到扣分回执', ru.penalty >= 15, '-' + ru.penalty);
        T('开天眼：向全员揭示一个字', !!h && /[^＿]/.test(h.mask || ''), h ? h.mask : '无');
        drawer.send({ t: 'reveal' });
        const err = await drawer.wait('error', 3000).catch(() => null);
        T('开天眼每回合限一次', !!err && /用过/.test(err.msg), err ? err.msg : '无');
      }

      // 猜
      for (const g of guessers) {
        g.clear();
        g.send({ t: 'guess', text: answer });
        const cor = await g.wait('correct', 5000);
        comboByPlayer[g.tag] = comboByPlayer[g.tag] || [];
        comboByPlayer[g.tag].push(cor.combo);
      }

      await drawer.wait('turnEnd', 8000);
      const teAll = await guessers[0].wait('turnEnd', 8000);
      if (turn === 2) {
        T('开天眼代价体现在回合结算里', teAll.revealPenalty >= 15, '-' + teAll.revealPenalty + ' 分');
      }
    }

    T('6 轮 × 3 人共 18 个词', usedWords.length === totalTurns, usedWords.length + ' 个');
    T('同一局内零重复（核心目标）', new Set(usedWords).size === usedWords.length,
      '不重复 ' + new Set(usedWords).size + '/' + usedWords.length);
    const offTheme = usedWords.filter((w) => CAT_OF.has(w) && !THEMES.includes(CAT_OF.get(w)));
    T('全部词都在房主限定的主题内', offTheme.length === 0,
      offTheme.length ? '越界：' + offTheme.join('、') : '越界 0 个');

    // 连击
    const allCombos = Object.values(comboByPlayer).flat();
    const maxCombo = Math.max(0, ...allCombos);
    T('连击系统生效（出现 x2 及以上）', maxCombo >= 2,
      Object.entries(comboByPlayer).map(([k, v]) => k + ':' + v.join('→')).join('  '));
    T('连击层数有上限，长局不会滚成天文数字', maxCombo <= 5, '最高 x' + maxCombo);

    // 追赶
    const fin = await A.wait('gameEnd', 15000);
    T('结算包含词库统计', !!fin.wordStats && fin.wordStats.played === totalTurns,
      fin.wordStats ? ('出题 ' + fin.wordStats.played + ' · 不重复 ' + fin.wordStats.unique + ' · 重复 ' + fin.wordStats.repeat) : '无');
    T('结算统计确认零重复', fin.wordStats.repeat === 0);
    T('结算颁发称号', fin.ranking.some((r) => (r.titles || []).length > 0),
      fin.ranking.map((r) => r.name + '[' + (r.titles || []).join(',') + ']').join('  '));
    T('排行榜含画手累计收益字段', fin.ranking.every((r) => typeof r.drawerGainTotal === 'number'));

    /* ---------- 再来一局：词池重置但全局冷却保留 ---------- */
    A.clear();
    A.send({ t: 'again' });
    const lobby = await A.wait('state', 4000);
    T('再来一局回到大厅且词池归零', lobby.room.state === 'lobby' && lobby.room.pool.used === 0,
      '已用 ' + lobby.room.pool.used + ' / ' + lobby.room.pool.total);

  } catch (e) {
    T('测试流程', false, e.message);
  }

  A.close(); B.close(); C.close();
  console.log('\n' + (fails === 0 ? '全部通过 ✅' : fails + ' 项失败 ❌') + '\n');
  process.exit(fails === 0 ? 0 : 1);
})();
