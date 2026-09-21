'use strict';
/**
 * 头像图标回归测试
 * 运行：node test/avatars.js      （需要 127.0.0.1:PORT 上已有服务，默认 3299）
 *
 * 背景：头像原来是 Unicode emoji 字符，由操作系统自己的 emoji 字体渲染，
 *       导致 Windows / 安卓 / iOS 上长得不一样。现已改成微软 Fluent Emoji
 *       的矢量图（MIT），全平台一致。
 *       本测试守住「emoji 与图片文件一一对应、文件真的存在、HTTP 取得到」
 *       这几条，避免以后加了新头像忘了放图，或者图放错名字。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const PORT = Number(process.env.PORT || 3299);
const ROOT = path.join(__dirname, '..');
const AV_DIR = path.join(ROOT, 'public', 'avatars');

let fails = 0;
function T(name, ok, extra) {
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra ? '   -> ' + extra : ''));
  if (!ok) fails++;
}

function head(p, headers) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'GET', headers: headers || {} }, (res) => {
      res.resume();
      resolve({ status: res.statusCode, type: res.headers['content-type'] || '', cache: res.headers['cache-control'] || '' });
    });
    req.on('error', () => resolve({ status: 0, type: '', cache: '' }));
    req.end();
  });
}

(async () => {
  console.log('\n=== 头像图标回归 ===\n');

  /* ---------- 从 app.js 里把两张表抠出来 ---------- */
  const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const avMatch = /const AVATARS = \[([^\]]*)\]/.exec(src);
  if (!avMatch) { T('能从 app.js 解析出 AVATARS', false, '没找到'); console.log('\n1 项失败 ❌\n'); process.exit(1); }
  const avatars = avMatch[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);

  const mapMatch = /const AVATAR_FILE = \{([\s\S]*?)\n\};/.exec(src);
  if (!mapMatch) { T('能从 app.js 解析出 AVATAR_FILE 映射表', false, '没找到'); console.log('\n1 项失败 ❌\n'); process.exit(1); }
  const map = {};
  for (const m of mapMatch[1].matchAll(/'([^']+)'\s*:\s*'([^']+)'/g)) map[m[1]] = m[2];

  T('AVATARS 有 18 个头像', avatars.length === 18, avatars.length + ' 个');
  T('映射表条目数与 AVATARS 一致', Object.keys(map).length === avatars.length,
    Object.keys(map).length + ' vs ' + avatars.length);

  /* ---------- 一一对应 ---------- */
  const missing = avatars.filter((a) => !map[a]);
  T('每个头像都有对应的图片文件', missing.length === 0, missing.length ? '缺: ' + missing.join(' ') : '18/18 齐全');

  const orphan = Object.keys(map).filter((k) => !avatars.includes(k));
  T('映射表里没有多余/失效的条目', orphan.length === 0, orphan.length ? '多余: ' + orphan.join(' ') : '无');

  /* ---------- 文件真的存在且是合法 SVG ---------- */
  const files = fs.existsSync(AV_DIR) ? fs.readdirSync(AV_DIR).filter((f) => f.endsWith('.svg')) : [];
  T('public/avatars/ 存在且非空', files.length > 0, files.length + ' 个 svg');

  const bad = [];
  for (const [emoji, name] of Object.entries(map)) {
    const p = path.join(AV_DIR, name + '.svg');
    if (!fs.existsSync(p)) { bad.push(name + '(缺文件)'); continue; }
    const head = fs.readFileSync(p, 'utf8').slice(0, 200);
    if (!head.includes('<svg')) bad.push(name + '(不是SVG)');
  }
  T('每个映射的 SVG 文件都存在且格式正确', bad.length === 0, bad.length ? bad.join(', ') : '18/18 通过');

  const used = new Set(Object.values(map));
  const unusedFiles = files.filter((f) => !used.has(f.replace(/\.svg$/, '')));
  T('public/avatars/ 里没有多余的 svg 文件', unusedFiles.length === 0,
    unusedFiles.length ? '多余: ' + unusedFiles.join(', ') : '无');

  /* ---------- app.js 里不该再有「直接把 emoji 当文字渲染头像」的残留 ---------- */
  const leftovers = (src.match(/esc\(\s*\w+\.avatar/g) || []);
  T('app.js 里没有残留的「emoji 文字渲染头像」', leftovers.length === 0,
    leftovers.length ? leftovers.join(' ') + ' 处' : '全部走 avatarImg()');

  T('选头像格用的是 avatarImg() 而不是 textContent',
    /b\.innerHTML\s*=\s*avatarImg\(/.test(src), /b\.innerHTML\s*=\s*avatarImg\(/.test(src) ? 'OK' : '没找到');

  /* ---------- 未知头像要有兜底，不能渲染成空白 ---------- */
  T('avatarImg 对未知 emoji 有文字兜底',
    /function avatarImg[\s\S]{0,220}return esc\(/.test(src), '有 fallback 分支');

  /* ---------- HTTP：真的能取到，且带长缓存 ---------- */
  const probe = map[avatars[0]];
  const r1 = await head('/avatars/' + probe + '.svg');
  T('HTTP 能取到头像 SVG', r1.status === 200 && /image\/svg\+xml/.test(r1.type),
    'HTTP ' + r1.status + '  ' + r1.type);
  T('头像带长缓存（immutable），避免每次刷新重下',
    /immutable/.test(r1.cache), r1.cache || '(无)');

  const r2 = await head('/app.js');
  T('非头像资源仍是 no-cache（改动只影响 /avatars/）',
    r2.status === 200 && !/immutable/.test(r2.cache), r2.cache || '(无)');

  console.log('\n' + (fails === 0 ? '全部通过 ✅' : fails + ' 项失败 ❌') + '\n');
  process.exit(fails === 0 ? 0 : 1);
})();
