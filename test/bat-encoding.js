'use strict';
/**
 * 批处理脚本健康检查（防回归）
 * 运行：node test/bat-encoding.js
 *
 * 为什么需要这个测试：
 *   cmd.exe 解析「含 UTF-8 中文 + 纯 LF 换行」的 .bat 时会错位吃字符，
 *   例如 title -> 'itle'、goto -> 'oto'，整个启动脚本静默失效。
 *   2026-09-21 就是这么坏的：桌面快捷方式 + start-game.bat 都是中文+LF，
 *   双击只报一串 "'oto' 不是内部或外部命令"，服务器根本起不来。
 *
 *   已用 4 组对照实验确认边界：
 *     纯 ASCII + LF   -> 正常
 *     纯 ASCII + CRLF -> 正常
 *     UTF-8中文 + LF  -> 坏
 *     UTF-8中文 + CRLF-> 正常
 *
 * 所以本测试守两条线：
 *   1) 仓库里每个 .bat 都必须是 CRLF（静态，快）
 *   2) 真的用 cmd 跑一个「中文 + CRLF」脚本，确认 cmd 没吃字符（动态，真实）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DESKTOP = path.join(os.homedir(), 'Desktop');

let fails = 0;
function T(name, ok, extra) {
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra ? '   -> ' + extra : ''));
  if (!ok) fails++;
}
function note(msg) { console.log('  · ' + msg); }

function countEol(buf) {
  let cr = 0, lf = 0;
  for (const b of buf) { if (b === 13) cr++; else if (b === 10) lf++; }
  return { cr, lf };
}
function hasNonAscii(buf) {
  for (const b of buf) if (b > 126 || b < 9) return true;
  return false;
}
function collect(dir, out, depth) {
  if ((depth || 0) > 2 || !fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collect(p, out, (depth || 0) + 1);
    else if (/\.(bat|cmd)$/i.test(e.name)) out.push(p);
  }
  return out;
}

console.log('\n=== 批处理脚本健康检查 ===\n');

/* ---------- 1) 静态：项目内所有 .bat 必须 CRLF ---------- */
const projectBats = collect(ROOT, []).filter((p) => !p.includes(path.sep + '.tmp' + path.sep));
T('找到项目内的 .bat 脚本', projectBats.length > 0, projectBats.length + ' 个');
const lfOnly = [];
const withCn = [];
for (const f of projectBats) {
  const buf = fs.readFileSync(f);
  const { cr, lf } = countEol(buf);
  if (hasNonAscii(buf)) withCn.push(path.basename(f));
  if (cr === 0 && lf > 0) lfOnly.push(path.basename(f));
}
T('所有 .bat 都是 CRLF 换行（纯 LF 会让 cmd 解析错位）', lfOnly.length === 0,
  lfOnly.length ? '纯LF: ' + lfOnly.join(', ') : projectBats.length + ' 个全部 CRLF');
note('含中文的脚本（这些尤其不能是纯 LF）：' + (withCn.join(', ') || '无'));

/* ---------- 2) 静态：桌面入口必须 CRLF 或纯 ASCII ---------- */
const desktopBats = [
  path.join(DESKTOP, '你画我猜-局域网.bat'),
  path.join(DESKTOP, '文件', '你画我猜-局域网.bat'),
  path.join(DESKTOP, '文件', '你画我猜.bat')
];
const exist = desktopBats.filter((p) => fs.existsSync(p));
T('桌面入口脚本存在', exist.length >= 1, exist.length + ' 个');
const risky = [];
for (const f of exist) {
  const buf = fs.readFileSync(f);
  const { cr } = countEol(buf);
  // 纯 ASCII 的文件即使被写成 LF 也安全（cmd 只在多字节字符上错位）
  if (hasNonAscii(buf) && cr === 0) risky.push(path.basename(path.dirname(f)) + '\\' + path.basename(f));
}
T('桌面入口「中文脚本」没有裸 LF（纯 ASCII 的不受此限）', risky.length === 0,
  risky.length ? '危险: ' + risky.join(', ') : exist.length + ' 个检查通过');

/* ---------- 3) 动态：真跑一个中文+CRLF 脚本，确认 cmd 不吃字符 ---------- */
const lab = path.join(ROOT, '.tmp', 'bat-lab');
fs.mkdirSync(lab, { recursive: true });

function runBat(file) {
  const r = spawnSync('cmd.exe', ['/c', file], { encoding: 'buffer', timeout: 15000 });
  const out = Buffer.concat([r.stdout || Buffer.alloc(0), r.stderr || Buffer.alloc(0)]);
  return out.toString('utf8');
}

const cnText = '你画我猜 · 局域网版';
const body = [
  '@echo off',
  'chcp 65001 >nul',
  'title ' + cnText,
  'echo MARK-CN-CRLF-OK',
  ''
].join('\r\n');
const goodBat = path.join(lab, 'cn_crlf.bat');
fs.writeFileSync(goodBat, Buffer.from(body, 'utf8'));
const goodOut = runBat(goodBat);
T('中文 + CRLF 的 .bat 能被 cmd 正确执行（title 不被吃字符）',
  /MARK-CN-CRLF-OK/.test(goodOut) && !/不是内部或外部命令|is not recognized/.test(goodOut),
  (goodOut.trim().split('\n').pop() || '').trim() || '(无输出)');

// 反向对照：中文 + LF 应当坏掉。这是「金丝雀」，若哪天 cmd 修了此行为，
// 只提示不判失败，避免测试因环境升级而误报。
const badBat = path.join(lab, 'cn_lf.bat');
fs.writeFileSync(badBat, Buffer.from(body.replace(/\r\n/g, '\n'), 'utf8'));
const badOut = runBat(badBat);
const badBroken = /不是内部或外部命令|is not recognized/.test(badOut);
note('金丝雀（中文 + LF）：' + (badBroken ? '如预期解析错位 ✓' : '本机 cmd 未复现该缺陷，可放宽此规则'));

/* ---------- 4) 动态：拿 start-game.bat 的副本验解析（不真起服务） ---------- */
// 直接跑 start-game.bat 会把服务器拉起来并阻塞，所以这里只做「语法级」复跑：
// 把最后启动 server.js 的那行换成 echo，并摘掉 netsh 防火墙写入，避免副作用。
const sgPath = path.join(ROOT, 'start-game.bat');
if (fs.existsSync(sgPath)) {
  const probe = fs.readFileSync(sgPath, 'utf8').split(/\r?\n/).map((l) => {
    const t = l.trim();
    if (/^netsh\b/i.test(t)) return 'rem netsh (skipped in test)';
    if (/^pause$/i.test(t)) return 'rem pause (skipped in test)';
    // 让端口占用检查必然「不命中」，好让脚本一路走到末尾
    if (/^netstat\b/i.test(t)) return 'cmd /c exit 1';
    if (/server\.js\s*$/.test(t)) return 'echo MARK-PARSED-TO-END';
    return l;
  });
  const probeBat = path.join(lab, 'start-game-probe.bat');
  fs.writeFileSync(probeBat, Buffer.from(probe.join('\r\n'), 'utf8'));

  const out = runBat(probeBat);
  const garbled = /'[^']{1,12}' (不是内部或外部命令|is not recognized)/.test(out);
  T('start-game.bat 复跑无 cmd 解析错位（无 "xxx 不是内部或外部命令"）', !garbled,
    garbled ? (out.match(/'[^']*' [^\n]*/) || [''])[0].trim() : '解析正常');
  T('start-game.bat 能完整执行到启动那一行', /MARK-PARSED-TO-END/.test(out),
    /MARK-PARSED-TO-END/.test(out) ? '已到达启动行' : '未能到达（可能被提前 exit）');
}

console.log('\n' + (fails === 0 ? '全部通过 ✅' : fails + ' 项失败 ❌') + '\n');
process.exit(fails === 0 ? 0 : 1);
