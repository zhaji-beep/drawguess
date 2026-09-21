'use strict';
/**
 * 你画我猜 · 启动选择器
 * --------------------------------------------------------------
 * 桌面双击 → 弹出中文菜单 → 选联机方式。
 * 15 秒不选，默认走【局域网联机】（断网也能用，最稳）。
 *
 * 用法：
 *   node launch.js            交互式菜单
 *   node launch.js --lan      直接局域网（本机起服，内网可玩）
 *   node launch.js --vps      直接打开公网地址（阿里云，朋友在外网用）
 *   node launch.js --tunnel   直接 Cloudflare 隧道（保底）
 *   node launch.js --dry      只打印菜单就退出（自检用）
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

const ROOT = __dirname;
const WAIT_MS = 15000;

/* 公网地址不写死在代码里（仓库是公开的，写死等于把你的服务器地址送出去）。
 * 从 deploy.local.json 读，该文件在 .gitignore 里；没配就显示「未配置」。
 * 想启用公网联机：把 deploy.example.json 复制成 deploy.local.json 再填自己的地址。 */
let VPS_URL = '';
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'deploy.local.json'), 'utf8'));
  VPS_URL = String(cfg.vpsUrl || '').trim();
} catch (e) { /* 没配就用不了公网联机，不影响局域网 */ }
const VPS_READY = /^https?:\/\//.test(VPS_URL);

const FRP_DIR = path.join(ROOT, 'frp');
const CLOUDFLARED = path.join(ROOT, 'tools', 'cloudflared.exe');

const arg = (process.argv[2] || '').toLowerCase();
const line = (c) => console.log(String(c).repeat(58));

function banner() {
  console.log('');
  line('=');
  console.log('   你画我猜 · 选择联机方式');
  line('=');
  console.log('');
  console.log('     [1]  局域网联机       本机起服，同路由器内可玩（断网也能用）');
  console.log('     [2]  公网联机         ' +
    (VPS_READY ? '自建服务器，朋友在外网用' : '未配置（见 deploy.example.json）'));
  console.log('     [3]  Cloudflare 隧道  保底方案，约 355ms');
  console.log('');
  console.log('   ' + Math.round(WAIT_MS / 1000) + ' 秒内没选择，自动走局域网联机。');
  console.log('');
}

function preflight() {
  const problems = [];
  if (!fs.existsSync(path.join(ROOT, 'server.js'))) problems.push('缺少 server.js');
  if (!fs.existsSync(CLOUDFLARED)) {
    problems.push('缺少 tools\\cloudflared.exe（Cloudflare 隧道需要，不影响 1/2）');
  }
  return problems;
}

function spawnNode(scriptRel) {
  const p = spawn(process.execPath, [path.join(ROOT, scriptRel)], {
    cwd: ROOT,
    stdio: 'inherit'
  });
  p.on('exit', (code) => process.exit(code || 0));
}

function startLan() {
  console.log('\n  → 正在启动【局域网联机】…\n');
  const p = spawn('cmd.exe', ['/c', path.join(ROOT, 'start-game.bat')], {
    cwd: ROOT,
    stdio: 'inherit'
  });
  p.on('exit', (code) => process.exit(code || 0));
}

function startVps() {
  if (!VPS_READY) {
    console.log('\n  [!] 还没配置公网地址，这条路走不了。');
    console.log('      做法：把 deploy.example.json 复制成 deploy.local.json，');
    console.log('            再把 vpsUrl 改成你自己服务器的地址（例如 http://你的IP:3000）。');
    console.log('      不想折腾的话：选 [1] 局域网联机，或 [3] Cloudflare 隧道。\n');
    const rl0 = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl0.question('   按回车关闭本窗口：', () => { rl0.close(); process.exit(0); });
    return;
  }
  console.log('\n  → 公网地址：' + VPS_URL);
  console.log('     正在为你打开浏览器…（若没自动打开，请手动复制上面的地址）\n');
  try {
    spawn('cmd.exe', ['/c', 'start', '', VPS_URL], { stdio: 'ignore' });
  } catch (e) { /* 忽略，地址已经打印在上面的提示里 */ }
  console.log('   （本机不用起服，游戏在阿里云服务器上常驻运行）');
  console.log('');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('   按回车关闭本窗口：', () => { rl.close(); process.exit(0); });
}

function startTunnel() {
  console.log('\n  → 正在启动【Cloudflare 隧道】…\n');
  spawnNode('start-public.js');
}

/** 把用户输入/参数归一成三种模式之一；认不出来就默认局域网（frps 已退休） */
function normalize(choice) {
  const c = String(choice == null ? '' : choice).trim().toLowerCase();
  if (c === '2' || c === 'vps' || c === 'public') return 'vps';
  if (c === '3' || c === 'tunnel' || c === 'cloudflare') return 'tunnel';
  if (c === '1' || c === 'lan') return 'lan';
  return 'lan';
}

function dispatch(choice) {
  const mode = normalize(choice);
  // 自检开关：只打印会走哪条路，不真的启动（供自动化测试用）
  if (process.env.LAUNCH_TEST) {
    console.log('  [自检] 将会启动：' + mode);
    process.exit(0);
  }
  if (mode === 'lan') startLan();
  else if (mode === 'tunnel') startTunnel();
  else startVps();
}

/* ---------------- 入口 ---------------- */
if (arg === '--dry') {
  banner();
  console.log('  [自检] 前置检查：' + (preflight().join('；') || '通过'));
  console.log('  [自检] 参数：--lan / --vps / --tunnel / --dry');
  console.log('  [自检] 公网地址：' + (VPS_READY ? VPS_URL : '未配置（deploy.local.json 里没有 vpsUrl）'));
  process.exit(0);
}
if (arg === '--lan') { dispatch('1'); }
else if (arg === '--vps' || arg === '--public') { dispatch('2'); }
else if (arg === '--tunnel') { dispatch('3'); }
else {
  banner();
  const problems = preflight();
  if (problems.length) {
    console.log('  [!] 注意：');
    for (const p of problems) console.log('      - ' + p);
    console.log('');
  }

  let decided = false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const timer = setTimeout(() => {
    if (decided) return;
    decided = true;
    console.log('\n  （超时未选择）');
    rl.close();
    dispatch('1');
  }, WAIT_MS);

  rl.question('  请输入 1 / 2 / 3 后回车（直接回车 = 1）：', (ans) => {
    if (decided) return;
    decided = true;
    clearTimeout(timer);
    rl.close();
    dispatch(ans);
  });
  rl.on('close', () => {
    if (decided) return;
    decided = true;
    clearTimeout(timer);
    dispatch('1');
  });
}
