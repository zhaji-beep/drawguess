'use strict';
/**
 * 测试用 WebSocket 客户端（手写 RFC 6455 帧编解码，与服务端实现对称）
 * 供 test/v2.js、test/features.js 复用。
 */
const http = require('http');
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor(tag, port, host) {
    this.tag = tag;
    this.port = port || Number(process.env.PORT) || 3000;
    this.host = host || '127.0.0.1';
    this.inbox = [];
  }
  connect() {
    return new Promise((res, rej) => {
      const key = crypto.randomBytes(16).toString('base64');
      const req = http.request({
        port: this.port, host: this.host,
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' }
      });
      req.on('upgrade', (r, socket, head) => {
        this.socket = socket;
        this.buf = Buffer.alloc(0);
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
      if (f.opcode === 0x1) {
        let m; try { m = JSON.parse(f.payload.toString('utf8')); } catch (e) { continue; }
        this.inbox.push(m);
        // 事件驱动唤醒：轮询式 wait 会引入 20ms 量级的测量误差
        const w = this._waiters && this._waiters.get(m.t);
        if (w && w.length) w.shift()(m);
      } else if (f.opcode === 0x9) {
        this.socket.write(encFrame(0xa, Buffer.alloc(0)));
      } else if (f.opcode === 0x8) {
        this.socket.destroy();
      }
    }
  }
  /** 等到某类消息就立刻返回（不用轮询，适合延迟测量） */
  once(type, timeout) {
    this._waiters = this._waiters || new Map();
    if (!this._waiters.has(type)) this._waiters.set(type, []);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(this.tag + ' 等待 ' + type + ' 超时')), timeout || 8000);
      this._waiters.get(type).push((m) => { clearTimeout(timer); resolve(m); });
    });
  }
  take(type) {
    const i = this.inbox.findIndex((m) => m.t === type);
    return i >= 0 ? this.inbox.splice(i, 1)[0] : null;
  }
  async wait(type, timeout) {
    const end = Date.now() + (timeout || 8000);
    for (;;) {
      const m = this.take(type);
      if (m) return m;
      if (Date.now() > end) throw new Error(this.tag + ' 等待 ' + type + ' 超时');
      await sleep(20);
    }
  }
  /** 等一小段时间，确认某类消息没来 */
  async expectNone(type, ms) {
    await sleep(ms || 250);
    return !this.inbox.some((m) => m.t === type);
  }
  clear() { this.inbox.length = 0; }
  send(o) { this.socket.write(encFrame(0x1, JSON.stringify(o))); }
  close() { try { this.socket.destroy(); } catch (e) {} }
}

module.exports = { Client, encFrame, decFrame, sleep };
