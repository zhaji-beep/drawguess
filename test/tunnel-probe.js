'use strict';
/**
 * 走 TLS 的 WebSocket 客户端（给隧道测量用）
 * 与 test/client.js 同构，区别是走 https/wss 而不是明文 ws。
 */
const https = require('https');
const crypto = require('crypto');

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class TunnelClient {
  constructor(tag, host, port) {
    this.tag = tag;
    this.host = host;
    this.port = port || 443;
    this.inbox = [];
  }
  connect() {
    return new Promise((res, rej) => {
      const key = crypto.randomBytes(16).toString('base64');
      const req = https.request({
        host: this.host, port: this.port, path: '/',
        headers: {
          Connection: 'Upgrade', Upgrade: 'websocket',
          'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13',
          'User-Agent': 'DrawGuess-LatencyProbe'
        }
      });
      req.on('upgrade', (r, socket, head) => {
        this.socket = socket;
        this.buf = head && head.length ? head : Buffer.alloc(0);
        socket.setNoDelay(true);
        socket.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.drain(); });
        socket.on('error', () => {});
        res(this);
      });
      req.on('response', (r) => rej(new Error('隧道拒绝 WebSocket 升级，HTTP ' + r.statusCode)));
      req.on('error', rej);
      req.setTimeout(20000, () => rej(new Error('握手超时')));
      req.end();
    });
  }
  drain() {
    for (;;) {
      const f = decFrame(this.buf);
      if (!f) break;
      this.buf = this.buf.slice(f.total);
      if (f.opcode === 0x1) {
        let m; try { m = JSON.parse(f.payload.toString('utf8')); } catch (e) { continue; }
        this.inbox.push(m);
        const w = this._waiters && this._waiters.get(m.t);
        if (w && w.length) w.shift()(m);
      }
      else if (f.opcode === 0x9) this.socket.write(encFrame(0xa, Buffer.alloc(0)));
      else if (f.opcode === 0x8) this.socket.destroy();
    }
  }
  /** 事件驱动等待，测量精度不受轮询间隔影响 */
  once(type, timeout) {
    this._waiters = this._waiters || new Map();
    if (!this._waiters.has(type)) this._waiters.set(type, []);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(this.tag + ' 等待 ' + type + ' 超时')), timeout || 20000);
      this._waiters.get(type).push((m) => { clearTimeout(timer); resolve(m); });
    });
  }
  take(type) {
    const i = this.inbox.findIndex((m) => m.t === type);
    return i >= 0 ? this.inbox.splice(i, 1)[0] : null;
  }
  async wait(type, timeout) {
    const end = Date.now() + (timeout || 20000);
    for (;;) {
      const m = this.take(type);
      if (m) return m;
      if (Date.now() > end) throw new Error(this.tag + ' 等待 ' + type + ' 超时');
      await sleep(15);
    }
  }
  clear() { this.inbox.length = 0; }
  send(o) { this.socket.write(encFrame(0x1, JSON.stringify(o))); }
  close() { try { this.socket.destroy(); } catch (e) {} }
}

module.exports = { TunnelClient, encFrame, decFrame, sleep };
