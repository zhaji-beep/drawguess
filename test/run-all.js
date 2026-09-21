'use strict';
/**
 * 一键跑全部测试
 *   node test/run-all.js
 * 会自动在测试端口拉起一个服务实例（TURN_END_DELAY=60 加速），跑完自动关掉。
 */
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const NODE = process.execPath;
const ROOT = path.join(__dirname, '..');
const TEST_PORT = 3299;
// 测试模式：加快回合结算、并把投票窗压到 1.2s（真实运行是 6.5s / 3.9s）
const TEST_ENV = { PORT: String(TEST_PORT), TURN_END_DELAY: '1500', VOTE_WINDOW_MS: '1200',
  SEAT_TTL_MS: '4000', ROOM_TTL_MS: '4000', RECONNECT_GRACE_MS: '800' };

function run(script, env) {
  return new Promise((resolve) => {
    const p = spawn(NODE, [path.join(__dirname, script)], {
      cwd: ROOT,
      env: Object.assign({}, process.env, env || {}),
      stdio: 'inherit'
    });
    p.on('exit', (code) => resolve(code === 0));
  });
}

function waitPort(port, timeoutMs) {
  const end = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => {
        if (Date.now() > end) return reject(new Error('服务未能在 ' + timeoutMs + 'ms 内启动'));
        setTimeout(tick, 150);
      });
    };
    tick();
  });
}

(async () => {
  const results = [];
  let server = null;
  try {
    server = spawn(NODE, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: Object.assign({}, process.env, TEST_ENV),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.on('data', () => {});
    server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
    await waitPort(TEST_PORT, 8000);

    results.push(['词库 & 选词引擎压测（12 项）', await run('wordpool.js')]);
    results.push(['桌面启动器自检（10 项）', await run('launcher.js')]);
    results.push(['批处理脚本健康检查（换行/编码防回归）', await run('bat-encoding.js')]);
    results.push(['首页标题回归（局域网/外网）', await run('title.js', { PORT: String(TEST_PORT) })]);
    results.push(['头像图标回归（emoji↔图片）', await run('avatars.js', { PORT: String(TEST_PORT) })]);
    results.push(['前端 DOM 冒烟（97 项）', await run('dom.js', {
      NODE_PATH: path.join(process.env.USERPROFILE || '', '.workbuddy-ai', 'binaries', 'node', 'workspace', 'node_modules')
    })]);
    results.push(['端到端回归（46 项）', await run('e2e.js', { PORT: String(TEST_PORT) })]);
    results.push(['v2 玩法集成（22 项）', await run('v2.js', { PORT: String(TEST_PORT) })]);
    results.push(['新玩法特性集成（40 项）', await run('features.js', { PORT: String(TEST_PORT) })]);
    results.push(['猜词温度回归（17 项）', await run('warmth.js', { PORT: String(TEST_PORT) })]);
    results.push(['接盘画回归（9 项）', await run('inherit.js', { PORT: String(TEST_PORT) })]);
    results.push(['断线重连回归（16 项）', await run('reconnect.js', { PORT: String(TEST_PORT) })]);
    results.push(['多设备真实渲染（99 项）', await run('responsive.js', { PORT: String(TEST_PORT) })]);
  } catch (e) {
    console.error('\n启动失败：' + e.message);
    results.push(['启动测试服务', false]);
  } finally {
    if (server) server.kill();
  }

  console.log('\n================ 汇总 ================');
  results.forEach(([name, ok]) => console.log('  ' + (ok ? '✅' : '❌') + '  ' + name));
  const bad = results.filter((r) => !r[1]).length;
  console.log('=====================================\n');
  process.exit(bad === 0 ? 0 : 1);
})();
