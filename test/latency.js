'use strict';
/**
 * 绘制链路延迟测量
 * --------------------------------------------------------------
 * 分别测三个环节，定位公网延迟到底花在哪：
 *   1) 裸往返延迟（ping/pong）—— 网络本身
 *   2) 笔画端到端延迟（画手 begin → 对手收到）—— 含客户端发送缓冲
 *   3) HTTP 首字节 —— 参考值
 *
 * 用法：node test/latency.js
 *      TUNNEL=https://xxx.trycloudflare.com node test/latency.js
 */
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const { Client, sleep } = require('./client');

const ROOT = path.join(__dirname, '..');
const ROUNDS = Number(process.env.ROUNDS) || 30;

function freePort() {
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
function portOpen(port) {
  return new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = (v) => { try { s.destroy(); } catch (e) {} res(v); };
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
    s.setTimeout(900, () => done(false));
  });
}

function stats(list) {
  if (!list.length) return null;
  const s = list.slice().sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return {
    n: s.length,
    min: s[0],
    p50: q(0.5),
    p90: q(0.9),
    max: s[s.length - 1],
    avg: Math.round(sum / s.length)
  };
}
const fmt = (s) => s ? ('min ' + s.min + ' / p50 ' + s.p50 + ' / p90 ' + s.p90 + ' / max ' + s.max + ' ms') : '无数据';

/** 用 WebSocket 打 N 次 ping，量往返 */
async function measurePing(port, label, host) {
  const c = new Client('P', port, host);
  await c.connect();
  c.send({ t: 'join', name: '探针', avatar: '🐼' });
  await c.wait('joined', 15000);
  await sleep(300);

  const rtts = [];
  for (let i = 0; i < ROUNDS; i++) {
    c.clear();
    const t0 = process.hrtime.bigint();
    c.send({ t: 'ping', ts: Date.now() });
    await c.once('pong', 15000);
    rtts.push(Number(process.hrtime.bigint() - t0) / 1e6);
    await sleep(60);
  }
  c.close();
  return rtts;
}

/** 量「画手落笔 → 对手收到 begin」的端到端延迟 */
async function measureStroke(port, label, host) {
  const A = new Client('A', port, host), B = new Client('B', port, host);
  await A.connect();
  A.send({ t: 'join', name: '画手', avatar: '🐼' });
  const ja = await A.wait('joined', 15000);
  await B.connect();
  B.send({ t: 'join', name: '猜者', roomCode: ja.room.code, avatar: '🦊' });
  await B.wait('joined', 15000);
  await sleep(300);

  A.clear(); B.clear();
  A.send({ t: 'settings', rounds: 1, duration: 60 });
  await sleep(400);
  A.send({ t: 'start' });

  // 找到画手
  let drawer = null, wc = null;
  for (let i = 0; i < 300 && !drawer; i++) {
    for (const c of [A, B]) { const m = c.take('wordChoice'); if (m) { drawer = c; wc = m; break; } }
    if (!drawer) await sleep(25);
  }
  if (!drawer) { A.close(); B.close(); return null; }
  const peer = drawer === A ? B : A;
  drawer.clear(); peer.clear();
  drawer.send({ t: 'chooseWord', word: wc.words[0].w });
  await drawer.wait('drawerWord', 10000);
  await sleep(400);

  const lats = [];
  for (let i = 0; i < 15; i++) {
    peer.clear();
    const sid = 1000 + i;
    const t0 = process.hrtime.bigint();
    drawer.send({ t: 'draw', op: 'begin', sid, color: '#ef4444', w: 0.008, mode: 'pen', x: 0.3, y: 0.3 });
    await peer.once('draw', 15000);
    lats.push(Number(process.hrtime.bigint() - t0) / 1e6);
    await sleep(120);
  }
  A.close(); B.close();
  return lats;
}

(async () => {
  console.log('\n=== 绘制链路延迟测量 ===\n');

  /* 本地服务 */
  let localPort = Number(process.env.PORT) || 0;
  let srv = null;
  if (!localPort || !(await portOpen(localPort))) {
    localPort = await freePort();
    srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { PORT: String(localPort) }),
      stdio: 'ignore'
    });
    for (let i = 0; i < 40 && !(await portOpen(localPort)); i++) await sleep(200);
  }
  console.log('本地服务端口：' + localPort + '\n');

  /* 1. 本地 */
  const localPing = await measurePing(localPort, 'local');
  console.log('【本机回环】裸往返  ' + fmt(stats(localPing)));
  const localStroke = await measureStroke(localPort, 'local');
  console.log('【本机回环】笔画端到端 ' + fmt(stats(localStroke)));

  /* 2. 隧道 */
  let tunnel = process.env.TUNNEL;
  if (!tunnel) {
    try { tunnel = fs.readFileSync(path.join(ROOT, 'public-url.txt'), 'utf8').trim(); } catch (e) {}
  }
  if (tunnel) {
    const host = new URL(tunnel).hostname;
    const tport = 443;
    const tls = true;
    // 隧道走 https/wss，测试客户端需要 TLS 支持
    try {
      const { TunnelClient } = require('./tunnel-probe');
      const tp = new TunnelClient('T', host);
      await tp.connect();
      tp.send({ t: 'join', name: '公网探针', avatar: '🐼' });
      await tp.wait('joined', 20000);
      await sleep(400);
      const trtt = [];
      for (let i = 0; i < ROUNDS; i++) {
        tp.clear();
        const t0 = process.hrtime.bigint();
        tp.send({ t: 'ping', ts: Date.now() });
        await tp.once('pong', 20000);
        trtt.push(Number(process.hrtime.bigint() - t0) / 1e6);
        await sleep(60);
      }
      tp.close();
      console.log('\n【公网隧道】裸往返  ' + fmt(stats(trtt)));
      const delta = stats(trtt).p50 - stats(localPing).p50;
      console.log('【公网隧道】比本机回环多出 p50 ' + Math.round(delta) + ' ms');
      const tstroke = await measureStrokeTunnel(tunnel);
      if (tstroke) {
        console.log('【公网隧道】笔画端到端 ' + fmt(stats(tstroke)));
        console.log('【公网隧道】笔画比本机多出 p50 ' +
          Math.round(stats(tstroke).p50 - stats(localStroke).p50) + ' ms');
      }
    } catch (e) {
      console.log('\n隧道测量失败：' + e.message);
    }
  } else {
    console.log('\n（没有 public-url.txt，跳过隧道测量）');
  }

  if (srv) srv.kill();
  console.log('');
  process.exit(0);
})();

/** 隧道版笔画测量（用 TLS 客户端） */
async function measureStrokeTunnel(tunnel) {
  const { TunnelClient } = require('./tunnel-probe');
  const host = new URL(tunnel).hostname;
  const A = new TunnelClient('TA', host), B = new TunnelClient('TB', host);
  try {
    await A.connect();
    A.send({ t: 'join', name: '公网画手', avatar: '🐼' });
    const ja = await A.wait('joined', 20000);
    await B.connect();
    B.send({ t: 'join', name: '公网猜者', roomCode: ja.room.code, avatar: '🦊' });
    await B.wait('joined', 20000);
    await sleep(400);
    A.clear(); B.clear();
    A.send({ t: 'settings', rounds: 1, duration: 60 });
    await sleep(600);
    A.send({ t: 'start' });

    let drawer = null, wc = null;
    for (let i = 0; i < 400 && !drawer; i++) {
      for (const c of [A, B]) { const m = c.take('wordChoice'); if (m) { drawer = c; wc = m; break; } }
      if (!drawer) await sleep(25);
    }
    if (!drawer) { A.close(); B.close(); return null; }
    const peer = drawer === A ? B : A;
    drawer.clear(); peer.clear();
    drawer.send({ t: 'chooseWord', word: wc.words[0].w });
    await drawer.wait('drawerWord', 15000);
    await sleep(500);

    const lats = [];
    for (let i = 0; i < 15; i++) {
      peer.clear();
      const t0 = process.hrtime.bigint();
      drawer.send({ t: 'draw', op: 'begin', sid: 2000 + i, color: '#ef4444', w: 0.008, mode: 'pen', x: 0.3, y: 0.3 });
      await peer.once('draw', 20000);
      lats.push(Number(process.hrtime.bigint() - t0) / 1e6);
      await sleep(150);
    }
    A.close(); B.close();
    return lats;
  } catch (e) {
    A.close(); B.close();
    console.log('（隧道笔画测量失败：' + e.message + '）');
    return null;
  }
}
