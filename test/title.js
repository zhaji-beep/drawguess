'use strict';
/**
 * 首页标题回归测试
 * 运行：node test/title.js        （需要 127.0.0.1:PORT 上已有服务，默认 3299）
 *
 * 需求：同一份代码既跑在本机（局域网）也跑在阿里云（公网），
 *       局域网访问显示「你画我猜 · 局域网联机」，公网访问显示「你画我猜 · 外网联机」。
 *       判定依据是请求的 Host 头：私网地址 / localhost 算局域网，其余算外网。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3299);
const ROOT = path.join(__dirname, '..');

let fails = 0;
function T(name, ok, extra) {
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra ? '   -> ' + extra : ''));
  if (!ok) fails++;
}

const TITLE_LAN = '你画我猜 · 局域网联机';
const TITLE_WAN = '你画我猜 · 外网联机';

/** 带自定义 Host 头请求首页，返回 <title> 内容 */
function fetchTitle(hostHeader) {
  return new Promise((resolve) => {
    const headers = {};
    if (hostHeader !== undefined) headers.Host = hostHeader;
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/', method: 'GET', headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        const m = /<title>([^<]*)<\/title>/.exec(body);
        resolve({ status: res.statusCode, title: m ? m[1] : null });
      });
    });
    req.on('error', (e) => resolve({ status: 0, title: null, err: e.message }));
    req.end();
  });
}

function fetchBody(p) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
    }).on('error', () => resolve({ status: 0, buf: Buffer.alloc(0) }));
  });
}

(async () => {
  console.log('\n=== 首页标题回归 ===\n');

  /* ---------- 局域网：私网地址 / localhost ---------- */
  const lanHosts = [
    '127.0.0.1:' + PORT, 'localhost:' + PORT,
    '172.16.26.194:' + PORT, '192.168.30.10:' + PORT,
    '10.0.0.5:' + PORT, '172.31.9.9:' + PORT,   // 172.16/12 的上边界
    '[::1]:' + PORT
  ];
  for (const h of lanHosts) {
    const r = await fetchTitle(h);
    T('局域网 Host「' + h + '」→ 局域网联机', r.title === TITLE_LAN, r.title || '(取不到)');
  }
  const noHost = await fetchTitle(undefined);
  T('没带 Host 头 → 兜底按局域网', noHost.title === TITLE_LAN, noHost.title || '(取不到)');

  /* ---------- 外网：公网 IP / 域名 / 隧道域名 ---------- */
  const wanHosts = [
    '203.0.113.10:3000',         // 公网 IP（TEST-NET-3，文档专用段）
    'game.example.com:3000',     // 域名
    'abc-xyz.trycloudflare.com', // Cloudflare 隧道
    '8.8.8.8:3000',
    '172.32.0.1:3000'            // 172.16/12 之外，属公网
  ];
  for (const h of wanHosts) {
    const r = await fetchTitle(h);
    T('外网 Host「' + h + '」→ 外网联机', r.title === TITLE_WAN, r.title || '(取不到)');
  }

  /* ---------- index.html 里写死的默认标题 ---------- */
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const staticTitle = (/<title>([^<]*)<\/title>/.exec(html) || [])[1];
  T('index.html 的默认标题是局域网版（直接用文件打开也合理）',
    staticTitle === TITLE_LAN, staticTitle || '(没找到)');

  /* ---------- 只有首页换标题，其余静态资源原样发 ---------- */
  const appRes = await fetchBody('/app.js');
  const localApp = fs.readFileSync(path.join(ROOT, 'public', 'app.js'));
  T('app.js 原样返回（未被标题替换逻辑影响）',
    appRes.status === 200 && Buffer.compare(appRes.buf, localApp) === 0,
    'HTTP ' + appRes.status + '  ' + appRes.buf.length + 'B vs 本地 ' + localApp.length + 'B');

  console.log('\n' + (fails === 0 ? '全部通过 ✅' : fails + ' 项失败 ❌') + '\n');
  process.exit(fails === 0 ? 0 : 1);
})();
