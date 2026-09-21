'use strict';
/**
 * 联机诊断 —— 一次跑完，把「该看的信息」全打出来
 * --------------------------------------------------------------
 * 用法：双击 诊断.bat   或   node doctor.js
 *
 * 它会回答这几个问题：
 *   1. 这台机器的公网 IP 是什么？（和配置里填的对不对）
 *   2. 这台机器自己有没有公网 IP？（能不能直接当房主）
 *   3. 配置里那个服务器地址，7000 / 3000 端口通不通？
 *   4. 本地游戏服务在跑吗？
 */
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');

const ROOT = __dirname;
const FRP_CFG = path.join(ROOT, 'frp', 'frpc.toml');
const GAME_PORT = 3000;
const line = (c) => console.log(String(c).repeat(64));
const ok = (s) => '✅ ' + s;
const bad = (s) => '❌ ' + s;
const warn = (s) => '⚠️  ' + s;

function tcp(host, port, ms) {
  return new Promise((r) => {
    const s = new Date();
    const c = net.connect({ host, port });
    const d = (v) => { try { c.destroy(); } catch (e) {} r(v); };
    c.on('connect', () => d(Date.now() - s));
    c.on('error', (e) => d(e.code));
    c.setTimeout(ms || 4000, () => d('timeout'));
  });
}

function fetchJson(url) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 8000 }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function readCfg() {
  try {
    const t = fs.readFileSync(FRP_CFG, 'utf8');
    const m = t.match(/serverAddr\s*=\s*"([^"]*)"/);
    const p = t.match(/serverPort\s*=\s*(\d+)/);
    return { addr: m ? m[1].trim() : '', port: p ? Number(p[1]) : 7000 };
  } catch (e) { return { addr: '', port: 7000 }; }
}

(async () => {
  console.log('');
  line('=');
  console.log('   你画我猜 · 联机诊断');
  line('=');
  console.log('');

  /* ---- 1. 本机网卡 ---- */
  console.log('【1】本机网卡地址');
  const nics = os.networkInterfaces();
  const locals = [];
  for (const name in nics) {
    for (const a of nics[name]) {
      if (a.family !== 'IPv4' || a.internal) continue;
      locals.push({ name, ip: a.address, mask: a.netmask });
      console.log('    ' + name.padEnd(30) + a.address.padEnd(18) + '掩码 ' + a.netmask);
    }
  }
  console.log('');

  /* ---- 2. 本机公网 IP ---- */
  console.log('【2】本机出口公网 IP（问外部服务）');
  const info = await fetchJson('http://ip-api.com/json/?lang=zh-CN');
  let myPublic = '';
  if (info && info.query) {
    myPublic = info.query;
    console.log('    公网 IP：' + info.query);
    console.log('    归属　：' + (info.country || '?') + ' ' + (info.regionName || '') + ' ' + (info.city || ''));
    console.log('    运营商：' + (info.isp || '?') + '   AS' + (info.as || '?'));
  } else {
    console.log('    ' + warn('查不到（网络受限或被代理拦了）'));
  }
  console.log('');

  /* ---- 3. 判断本机是不是公网 IP ---- */
  console.log('【3】这台机器自己有没有公网 IP？');
  const isPrivate = (ip) => /^(10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip);
  const hasPublic = locals.some((l) => !isPrivate(l.ip));
  if (hasPublic) {
    console.log('    ' + ok('有公网 IP！可以让朋友直接连这台机器（不用服务器）'));
    locals.filter((l) => !isPrivate(l.ip)).forEach((l) => console.log('      → http://' + l.ip + ':' + GAME_PORT));
  } else {
    console.log('    ' + bad('没有公网 IP（都是内网地址）'));
    console.log('       → 所以游戏不能直接被外网访问，需要中转');
    if (myPublic) console.log('       → 出口公网 IP 是 ' + myPublic + '（那是路由器/运营商的，不是你机器上的）');
  }
  console.log('');

  /* ---- 4. 配置里填的服务器 ---- */
  const cfg = readCfg();
  console.log('【4】frpc.toml 里填的服务器');
  console.log('    serverAddr = ' + (cfg.addr || '（没填）'));
  console.log('    serverPort = ' + cfg.port);
  console.log('');

  if (!cfg.addr || cfg.addr.indexOf('你的服务器') >= 0) {
    console.log('    ' + warn('还没填服务器地址，没法测'));
  } else {
    const same = myPublic && cfg.addr === myPublic;
    console.log('【5】连通性测试');
    if (same) {
      console.log('    ' + warn('注意：这个地址 = 本机的出口公网 IP！'));
      console.log('       说明你填的是「自己家宽带的公网 IP」，不是一台云服务器。');
      console.log('       这种用法要求：');
      console.log('         · 游戏跑在那条宽带的电脑上');
      console.log('         · 路由器做了端口映射（外部 3000 → 内网电脑 3000）');
      console.log('       如果你现在这台机器就在那条宽带里，那就不用 frp，直接端口映射。');
      console.log('');
    }
    const r7 = await tcp(cfg.addr, cfg.port);
    const r3 = await tcp(cfg.addr, GAME_PORT);
    const r22 = await tcp(cfg.addr, 22);
    const fmt = (r) => (typeof r === 'number' ? r + ' ms  ' + ok('通') : r === 'timeout' ? '超时 ' + bad('不通') : r + ' ' + bad('不通'));
    console.log('    ' + String(cfg.port).padEnd(6) + '（frp 控制）  ' + fmt(r7));
    console.log('    ' + String(GAME_PORT).padEnd(6) + '（游戏）       ' + fmt(r3));
    console.log('    ' + '22'.padEnd(6) + '（SSH）        ' + fmt(r22));
    console.log('');

    if (typeof r7 === 'number') {
      console.log('    ' + ok('frp 服务端在跑！可以直接双击 start-frp.bat 开玩'));
    } else if (typeof r22 === 'number') {
      console.log('    ' + warn('SSH 通但 7000 不通 → 服务器能连上，但 frps 没启动或安全组没放行 7000'));
      console.log('       上服务器执行：./frps-linux-amd64 -c frps.toml');
    } else {
      console.log('    ' + bad('连 SSH 都不通 → 三选一：'));
      console.log('       a) 安全组/防火墙没放行任何端口（阿里云控制台 → 安全组 → 入方向）');
      console.log('       b) 实例没启动 / 欠费停机');
      console.log('       c) 这个 IP 根本不是一台服务器（比如是家用宽带的 IP，且没做端口映射）');
    }
  }
  console.log('');

  /* ---- 6. 本地游戏服务 ---- */
  console.log('【6】本地游戏服务');
  const g = await tcp('127.0.0.1', GAME_PORT);
  console.log('    127.0.0.1:' + GAME_PORT + '  ' + (typeof g === 'number' ? ok('在跑') : bad('没在跑') + '（双击 start-game.bat）'));
  console.log('');

  line('=');
  console.log('');
})();
