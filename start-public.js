'use strict';
/**
 * 公网联机一键启动器
 * --------------------------------------------------------------
 * 做四件事：
 *   1) 本地 3000 端口没服务就自动拉起 server.js；
 *   2) 启动 cloudflared 隧道，从输出里**自动抓取** trycloudflare 地址；
 *   3) 把地址大字打印 + 写进 public-url.txt + 复制到剪贴板；
 *   4) 隧道掉线自动重连（最多 5 次），Ctrl+C 一起退出。
 *
 * 用法：node start-public.js        或直接双击 start-public.bat
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3000;
const CF = path.join(ROOT, 'tools', 'cloudflared.exe');
const URL_FILE = path.join(ROOT, 'public-url.txt');
const MAX_RESTART = 5;
const URL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;
const HEALTH_INTERVAL = 30000;     // 心跳间隔
const HEALTH_FAIL_LIMIT = 2;       // 连续失败几次就重建隧道

let tunnel = null;
let serverProc = null;
let restarts = 0;
let lastUrl = null;
let quitting = false;
let healthTimer = null;
let healthFails = 0;
let healthyStreak = 0;
let logStream = null;

const line = (c) => console.log(String(c).repeat(64));
const stamp = () => new Date().toTimeString().slice(0, 8);

function info(msg) {
  const text = '  [' + stamp() + '] ' + msg;
  console.log(text);
  try { if (logStream) logStream.write(text + '\n'); } catch (e) {}
}

function writeLog(text) {
  try {
    if (!logStream) logStream = fs.createWriteStream(path.join(ROOT, 'tunnel.log'), { flags: 'a' });
    logStream.write('[' + new Date().toISOString() + '] ' + text + '\n');
  } catch (e) {}
}

/** 探一下隧道地址是不是真的通 */
async function probeUrl(url) {
  if (!url) return false;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 12000);
    const r = await fetch(url, { signal: ctl.signal, redirect: 'follow' });
    clearTimeout(t);
    return r.status >= 200 && r.status < 400;
  } catch (e) {
    return false;
  }
}

/** 心跳看门狗：进程还在但隧道实际已经断了的情况，只有主动探测才发现得了 */
function startHealthCheck() {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = setInterval(async () => {
    if (quitting || !lastUrl) return;
    const ok = await probeUrl(lastUrl);
    if (ok) {
      healthyStreak++;
      if (healthFails > 0) info('隧道已恢复正常。');
      healthFails = 0;
      // 连续健康一段时间后把重试次数清零，避免长期运行被累计上限卡死
      if (healthyStreak >= 3 && restarts > 0) { restarts = 0; healthyStreak = 0; }
      return;
    }
    healthFails++;
    healthyStreak = 0;
    info('隧道心跳失败（' + healthFails + '/' + HEALTH_FAIL_LIMIT + '）');
    if (healthFails >= HEALTH_FAIL_LIMIT) {
      healthFails = 0;
      info('隧道已不可达，正在重建…');
      writeLog('health check failed, rebuilding tunnel');
      try { if (tunnel) tunnel.kill(); else startTunnel(); } catch (e) { startTunnel(); }
    }
  }, HEALTH_INTERVAL);
}

function stopHealthCheck() {
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
}

/** 端口是否已在监听 */
function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = (v) => { try { s.destroy(); } catch (e) {} resolve(v); };
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
    s.setTimeout(1200, () => done(false));
  });
}

/** 写剪贴板（失败不影响主流程） */
function copyToClipboard(text) {
  try {
    const p = spawn('clip.exe', [], { stdio: ['pipe', 'ignore', 'ignore'] });
    p.on('error', () => {});
    p.stdin.end(text);
    return true;
  } catch (e) { return false; }
}

function publishUrl(url) {
  lastUrl = url;
  try { fs.writeFileSync(URL_FILE, url + '\n', 'utf8'); } catch (e) {}
  const copied = copyToClipboard(url);
  console.log('');
  line('=');
  console.log('');
  console.log('   把这个地址发给朋友，他们用浏览器打开就能玩：');
  console.log('');
  console.log('        ' + url);
  console.log('');
  console.log('   （已' + (copied ? '复制到剪贴板' : '写入 public-url.txt') +
    '，也存了一份到 public-url.txt）');
  console.log('');
  line('=');
  console.log('');
  info('本地也可玩：http://localhost:' + PORT);
  info('每 ' + (HEALTH_INTERVAL / 1000) + ' 秒自动心跳检测；断了会自己重建');
  info('关闭本窗口 = 立即断线');
  console.log('');
  writeLog('tunnel url = ' + url);

  // 发布后先立刻探一次（隧道刚建立时可能还要几秒才生效），再进入周期性心跳
  setTimeout(async () => {
    if (quitting) return;
    if (await probeUrl(url)) info('隧道连通性正常 ✓');
    else info('隧道暂未就绪，心跳会继续重试…');
  }, 6000);
  startHealthCheck();
}

function startTunnel() {
  info('正在建立公网隧道…（首次约 3~8 秒）');
  writeLog('starting cloudflared');
  tunnel = spawn(CF, ['tunnel', '--url', 'http://localhost:' + PORT, '--no-autoupdate'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const onChunk = (buf) => {
    const text = buf.toString('utf8');
    if (lastUrl && text.indexOf(lastUrl) >= 0) return;   // 已发布过，忽略重复日志
    const m = text.match(URL_RE);
    if (m && m[0] !== lastUrl) publishUrl(m[0]);
  };
  tunnel.stdout.on('data', onChunk);
  tunnel.stderr.on('data', onChunk);

  tunnel.on('exit', (code) => {
    if (quitting) return;
    tunnel = null;
    if (restarts >= MAX_RESTART) {
      console.error('\n  [X] 隧道连续断开 ' + MAX_RESTART + ' 次，已停止重试。');
      console.error('      检查网络后重新双击 start-public.bat。\n');
      writeLog('give up after ' + MAX_RESTART + ' restarts');
      stopHealthCheck();
      return;
    }
    restarts++;
    info('隧道断开（code ' + code + '），2 秒后重连…（第 ' + restarts + '/' + MAX_RESTART + ' 次）');
    writeLog('cloudflared exited code=' + code + ' restart ' + restarts);
    setTimeout(() => { if (!quitting) startTunnel(); }, 2000);
  });
}

function shutdown() {
  if (quitting) return;
  quitting = true;
  stopHealthCheck();
  console.log('\n  正在关闭隧道…');
  writeLog('shutdown');
  try { if (tunnel) tunnel.kill(); } catch (e) {}
  setTimeout(() => {
    try { if (logStream) logStream.end(); } catch (e) {}
    process.exit(0);
  }, 600);
}

(async () => {
  console.log('');
  line('=');
  console.log('   你画我猜 · 公网联机启动器');
  line('=');
  console.log('');

  if (!fs.existsSync(CF)) {
    console.error('  [X] 找不到隧道程序：' + CF);
    console.error('      重新下载：');
    console.error('      curl -L -o tools\\cloudflared.exe "https://gh-proxy.com/https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"');
    process.exit(1);
  }

  const up = await portInUse(PORT);
  if (up) {
    info('端口 ' + PORT + ' 已有游戏服务在跑，直接复用。');
  } else {
    info('端口 ' + PORT + ' 空闲，正在启动游戏服务…');
    serverProc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore'
    });
    serverProc.unref();
    for (let i = 0; i < 20 && !(await portInUse(PORT)); i++) {
      await new Promise((r) => setTimeout(r, 300));
    }
    if (await portInUse(PORT)) info('游戏服务已就绪。');
    else { console.error('  [X] 游戏服务启动失败，先单独跑一下 server.js 看看报错。'); process.exit(1); }
  }

  startTunnel();
})();

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
