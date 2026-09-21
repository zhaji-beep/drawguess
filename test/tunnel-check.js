'use strict';
/**
 * 公网隧道连通性自检：走真实的 WebSocket 握手，验证隧道能承载联机游戏
 * 用法：node test/tunnel-check.js https://xxx.trycloudflare.com
 */
const https = require('https');
const crypto = require('crypto');

const target = process.argv[2];
if (!target) {
  console.error('用法：node test/tunnel-check.js https://xxx.trycloudflare.com');
  process.exit(2);
}
const u = new URL(target);
const PORT = u.port ? Number(u.port) : 443;

let fails = 0;
function T(name, ok, extra) {
  console.log((ok ? '  \u2713 ' : '  \u2717 ') + name + (extra ? '   -> ' + extra : ''));
  if (!ok) fails++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- 帧编解码（客户端侧要加掩码） ---- */
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
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) === 0x80;
  let len = buf[1] & 0x7f, off = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = buf.readUInt32BE(6); off = 10; }
  let mask = null;
  if (masked) { if (buf.length < off + 4) return null; mask = buf.slice(off, off + 4); off += 4; }
  if (buf.length < off + len) return null;
  const p = Buffer.from(buf.slice(off, off + len));
  if (mask) for (let i = 0; i < p.length; i++) p[i] ^= mask[i & 3];
  return { opcode, payload: p, total: off + len };
}

class TunnelClient {
  constructor(tag) { this.tag = tag; this.inbox = []; }
  connect() {
    return new Promise((res, rej) => {
      const key = crypto.randomBytes(16).toString('base64');
      const req = https.request({
        host: u.hostname, port: PORT, path: '/',
        headers: {
          Connection: 'Upgrade', Upgrade: 'websocket',
          'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13',
          'User-Agent': 'DrawGuess-TunnelCheck'
        }
      });
      req.on('upgrade', (r, socket, head) => {
        this.socket = socket;
        this.buf = head && head.length ? head : Buffer.alloc(0);
        socket.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.drain(); });
        socket.on('error', () => {});
        res(this);
      });
      req.on('response', (r) => rej(new Error('隧道拒绝了 WebSocket 升级，HTTP ' + r.statusCode)));
      req.on('error', rej);
      req.setTimeout(15000, () => rej(new Error('握手超时')));
      req.end();
    });
  }
  drain() {
    for (;;) {
      const f = decFrame(this.buf);
      if (!f) break;
      this.buf = this.buf.slice(f.total);
      if (f.opcode === 0x1) { try { this.inbox.push(JSON.parse(f.payload.toString('utf8'))); } catch (e) {} }
      else if (f.opcode === 0x9) this.socket.write(encFrame(0xa, Buffer.alloc(0)));
      else if (f.opcode === 0x8) this.socket.destroy();
    }
  }
  take(type) {
    const i = this.inbox.findIndex((m) => m.t === type);
    return i >= 0 ? this.inbox.splice(i, 1)[0] : null;
  }
  async wait(type, timeout) {
    const end = Date.now() + (timeout || 12000);
    for (;;) {
      const m = this.take(type);
      if (m) return m;
      if (Date.now() > end) throw new Error(this.tag + ' 等待 ' + type + ' 超时');
      await sleep(30);
    }
  }
  send(o) { this.socket.write(encFrame(0x1, JSON.stringify(o))); }
  close() { try { this.socket.destroy(); } catch (e) {} }
}

(async () => {
  console.log('\n=== 公网隧道自检 ===');
  console.log('目标：' + target + '\n');
  const A = new TunnelClient('A'), B = new TunnelClient('B');
  try {
    /* 1. HTTP 层 */
    const html = await new Promise((res, rej) => {
      const r = https.get(target + '/', { headers: { 'User-Agent': 'DrawGuess-TunnelCheck' } }, (resp) => {
        let s = '';
        resp.on('data', (d) => { s += d; });
        resp.on('end', () => res({ code: resp.statusCode, body: s }));
      });
      r.on('error', rej);
      r.setTimeout(15000, () => rej(new Error('HTTP 超时')));
    });
    T('HTTP 页面能通过隧道打开', html.code === 200 && /你画我猜/.test(html.body),
      'HTTP ' + html.code + ' · ' + html.body.length + ' 字节');
    T('页面没有被插入拦截页（无 click to continue）', !/tunnel/i.test(html.body.slice(0, 400)));

    /* 2. WebSocket 层 */
    await A.connect();
    A.send({ t: 'join', name: '公网甲', avatar: '🐼' });
    const ja = await A.wait('joined', 15000);
    T('WebSocket 握手穿过隧道成功', !!ja.room && /^\d{4}$/.test(ja.room.code), '房间号 ' + ja.room.code);
    T('隧道下服务端下发词库信息', ja.wordBank && ja.wordBank.total >= 500, ja.wordBank.total + ' 词');

    await B.connect();
    B.send({ t: 'join', name: '公网乙', roomCode: ja.room.code, avatar: '🦊' });
    const jb = await B.wait('joined', 15000);
    T('第二个客户端能加入同一房间', jb.room.code === ja.room.code && jb.room.players.length === 2);

    /* 3. 打一个完整回合，验证双向实时通信 */
    A.inbox.length = 0; B.inbox.length = 0;
    A.send({ t: 'settings', rounds: 1, duration: 30 });
    await sleep(400);
    A.send({ t: 'start' });

    let drawer = null, wc = null;
    for (let i = 0; i < 400 && !drawer; i++) {
      for (const c of [A, B]) { const m = c.take('wordChoice'); if (m) { drawer = c; wc = m; break; } }
      if (!drawer) await sleep(30);
    }
    T('隧道下能正常指派画手并下发候选词', !!drawer,
      wc ? wc.words.map((w) => w.w).join(' / ') : '无');
    if (drawer) {
      const guesser = drawer === A ? B : A;
      drawer.send({ t: 'chooseWord', word: wc.words[0].w });
      const dw = await drawer.wait('drawerWord', 15000);

      drawer.send({ t: 'draw', op: 'begin', sid: 1, color: '#ef4444', w: 0.008, mode: 'pen', x: 0.2, y: 0.2 });
      drawer.send({ t: 'draw', op: 'pts', sid: 1, pts: [0.3, 0.3, 0.4, 0.4] });
      drawer.send({ t: 'draw', op: 'end', sid: 1 });
      const dv = await guesser.wait('draw', 15000);
      T('笔画能实时同步过隧道（画手→猜者）', !!dv && dv.op === 'begin',
        '收到 op=' + dv.op + ' color=' + dv.color);

      guesser.send({ t: 'guess', text: dw.word });
      const cor = await guesser.wait('correct', 15000);
      T('猜词判定过隧道正常', cor.gain > 0, '+' + cor.gain + ' 分');
      const te = await drawer.wait('turnEnd', 15000);
      T('回合结算过隧道正常', te.word === dw.word, '答案「' + te.word + '」');
    }
  } catch (e) {
    T('隧道联机流程', false, e.message);
  }
  A.close(); B.close();
  console.log('\n' + (fails === 0 ? '隧道可用 ✅ 可以放心开黑' : fails + ' 项失败 ❌') + '\n');
  process.exit(fails === 0 ? 0 : 1);
})();
