'use strict';
/**
 * 桌面启动器自检：验证 launch.js 的菜单、前置检查与分支兜底
 * 用 LAUNCH_TEST=1 让它只打印"会走哪条路"，不真的启动服务。
 * 运行：node test/launcher.js
 */
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;

let fails = 0;
function T(name, ok, extra) {
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra ? '   -> ' + extra : ''));
  if (!ok) fails++;
}

/** 跑一次 launch.js，可选喂入 stdin */
function run(args, stdin) {
  return new Promise((resolve) => {
    const p = spawn(NODE, [path.join(ROOT, 'launch.js')].concat(args || []), {
      cwd: ROOT,
      env: Object.assign({}, process.env, { LAUNCH_TEST: '1' }),
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString('utf8'); });
    p.stderr.on('data', (d) => { out += d.toString('utf8'); });
    p.on('exit', (code) => resolve({ out, code }));
    if (stdin !== undefined) p.stdin.end(stdin);
    else p.stdin.end();
  });
}

(async () => {
  console.log('\n=== 桌面启动器自检 ===\n');

  const dry = await run(['--dry']);
  T('--dry 打印中文菜单', /你画我猜 · 选择联机方式/.test(dry.out));
  T('菜单含三个选项',
    /\[1\]\s+局域网联机/.test(dry.out) &&
    /\[2\]\s+公网联机/.test(dry.out) &&
    /\[3\]\s+Cloudflare 隧道/.test(dry.out),
    (dry.out.match(/\[\d\]\s+\S+/g) || []).join(' '));
  T('提示了超时默认行为（局域网）', /自动走局域网联机/.test(dry.out));
  T('前置检查已打印', /前置检查：/.test(dry.out),
    (dry.out.match(/前置检查：.*/) || [''])[0]);
  T('--dry 打印公网地址状态（已配置则打印地址，未配置则说明原因）',
    /公网地址：(\s*https?:\/\/\S+|未配置)/.test(dry.out),
    (dry.out.match(/公网地址：.*/) || [''])[0]);

  const p1 = await run([], '1\n');
  T('输入 1 → 走局域网', /将会启动：lan/.test(p1.out));

  const p2 = await run([], '2\n');
  T('输入 2 → 走公网', /将会启动：vps/.test(p2.out));

  const p3 = await run([], '3\n');
  T('输入 3 → 走 Cloudflare 隧道', /将会启动：tunnel/.test(p3.out));

  const pg = await run([], '乱七八糟\n');
  T('乱输入 → 兜底走局域网', /将会启动：lan/.test(pg.out));

  const pe = await run([], '');
  T('直接关掉输入 → 兜底走局域网', /将会启动：lan/.test(pe.out));

  const a1 = await run(['--lan']);
  T('--lan 参数直通', /将会启动：lan/.test(a1.out));

  const a2 = await run(['--vps']);
  T('--vps 参数直通', /将会启动：vps/.test(a2.out));

  const a2b = await run(['--public']);
  T('--public 作为别名 → 也走公网', /将会启动：vps/.test(a2b.out));

  const a3 = await run(['--tunnel']);
  T('--tunnel 参数直通', /将会启动：tunnel/.test(a3.out));

  console.log('\n' + (fails === 0 ? '全部通过 ✅' : fails + ' 项失败 ❌') + '\n');
  process.exit(fails === 0 ? 0 : 1);
})();
