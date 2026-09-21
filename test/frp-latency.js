'use strict';
/**
 * frp 公网链路延迟测量
 * --------------------------------------------------------------
 * 走「本机 → 你自己的公网服务器:3000（frps 转发）→ 本机 server.js」
 * 用 WebSocket ping/pong 量真实往返，和本机回环做对比。
 *
 * 用法：FRP_HOST=你的服务器IP node test/frp-latency.js
 *      FRP_HOST=1.2.3.4 FRP_PORT=3000 ROUNDS=30 node test/frp-latency.js
 */
const { Client, sleep } = require('./client');

// 不写死服务器地址：仓库是公开的。必须显式传 FRP_HOST。
const HOST = process.env.FRP_HOST || '';
if (!HOST) {
  console.error('缺少目标地址。用法：FRP_HOST=<你的服务器IP> node test/frp-latency.js');
  process.exit(1);
}
const PORT = Number(process.env.FRP_PORT) || 3000;
const ROUNDS = Number(process.env.ROUNDS) || 30;
const BASELINE = Number(process.env.BASELINE_MS) || 355; // Cloudflare 隧道实测值

function stats(list) {
  if (!list.length) return null;
  const s = list.slice().sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return {
    n: s.length,
    min: Math.round(s[0]),
    p50: Math.round(q(0.5)),
    p90: Math.round(q(0.9)),
    max: Math.round(s[s.length - 1]),
    avg: Math.round(s.reduce((a, b) => a + b, 0) / s.length)
  };
}
const fmt = (s) =>
  s ? `min ${s.min} / p50 ${s.p50} / p90 ${s.p90} / max ${s.max} ms` : '无数据';

async function measurePing(host, port, tag) {
  const c = new Client(tag, port, host);
  await c.connect();
  c.send({ t: 'join', name: '探针' + tag, avatar: '🐼' });
  await c.wait('joined', 20000);
  await sleep(400);

  const rtts = [];
  for (let i = 0; i < ROUNDS; i++) {
    c.clear();
    const t0 = process.hrtime.bigint();
    c.send({ t: 'ping', ts: Date.now() });
    await c.once('pong', 20000);
    rtts.push(Number(process.hrtime.bigint() - t0) / 1e6);
    await sleep(60);
  }
  c.close();
  return rtts;
}

(async () => {
  console.log('\n=== frp 国内中转 · 链路延迟实测 ===\n');

  let local = null, remote = null;

  try {
    local = stats(await measurePing('127.0.0.1', PORT, 'L'));
    console.log(`【本机回环】裸往返    ${fmt(local)}`);
  } catch (e) {
    console.log(`【本机回环】失败：${e.message}（本地 server.js 没起？）`);
  }

  try {
    remote = stats(await measurePing(HOST, PORT, 'R'));
    console.log(`【frp 公网】裸往返    ${fmt(remote)}`);
  } catch (e) {
    console.log(`【frp 公网】失败：${e.message}`);
  }

  console.log('');
  if (remote) {
    const net = local ? remote.p50 - local.p50 : remote.p50;
    console.log(`公网链路净增（扣除回环）：p50 约 ${net} ms`);
    const delta = BASELINE - remote.p50;
    const pct = Math.round((delta / BASELINE) * 100);
    console.log(`对比 Cloudflare 隧道基线 ${BASELINE} ms：`);
    if (delta > 0) {
      console.log(`  ✅ 快了 ${delta} ms（降低 ${pct}%）`);
    } else {
      console.log(`  ⚠️ 慢了 ${-delta} ms（上升 ${-pct}%）`);
    }
    const lvl = remote.p50 < 80 ? '🟢 局域网级' : remote.p50 < 220 ? '🟡 公网可用' : '🔴 偏高';
    console.log(`  游戏内延迟指示器会显示：${lvl}`);
  }
  console.log('');
  process.exit(0);
})();
