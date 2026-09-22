'use strict';
/**
 * 极简 Chrome DevTools Protocol 驱动
 * --------------------------------------------------------------
 * 用本机已安装的 Chrome / Edge 做真实渲染验证（视口模拟、触摸模拟、截图），
 * 不依赖 playwright / puppeteer，也不用下载任何浏览器。
 *
 * Node 22 自带全局 WebSocket 与 fetch，所以这里几乎是零依赖。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];

function findBrowser() {
  for (const p of CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等子进程真正退出（超时也返回，避免卡死） */
function waitExit(proc, ms) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve(true);
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(false); } }, ms);
    proc.once('exit', () => { if (!done) { done = true; clearTimeout(t); resolve(true); } });
  });
}

/** 启动一个 headless 浏览器实例 */
async function launch(opts) {
  const exe = (opts && opts.exe) || findBrowser();
  if (!exe) throw new Error('没找到 Chrome / Edge，无法做真实渲染验证');

  const tmpRoot = path.join(__dirname, '..', '.tmp');
  // 清掉上次异常退出留下的 profile（一个能有二三十 MB，攒起来很吓人）
  let cleaned = 0;
  try {
    if (fs.existsSync(tmpRoot)) {
      for (const d of fs.readdirSync(tmpRoot)) {
        if (d.startsWith('chrome-')) {
          try {
            fs.rmSync(path.join(tmpRoot, d), { recursive: true, force: true });
            cleaned++;
          } catch (e) { /* 还被占着就留到下次，下面的 close() 也会再试 */ }
        }
      }
    }
  } catch (e) {}
  if (cleaned) console.log('  （清掉 ' + cleaned + ' 个上次残留的浏览器 profile）');

  const port = await freePort();
  const profile = (opts && opts.profile) || path.join(tmpRoot, 'chrome-' + port);

  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-features=Translate,MediaRouter',
    '--hide-scrollbars',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
    '--window-size=1440,900',
    'about:blank'
  ];

  const proc = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.on('error', () => {});

  // 等调试端口就绪
  const deadline = Date.now() + 25000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/json/version');
      if (r.ok) { ready = true; break; }
    } catch (e) {}
    await sleep(250);
  }
  if (!ready) {
    try { proc.kill(); } catch (e) {}
    throw new Error('浏览器调试端口没起来（可能被安全策略拦住）');
  }

  return {
    proc,
    port,
    exe,
    profile,
    async close() {
      try { proc.kill(); } catch (e) {}
      // 必须等进程真的退出再删：Windows 上 Chrome 还持有文件锁时 rmSync 会失败，
      // 旧写法把失败 catch 掉静默了，profile 就一个个攒下来（实测攒到 57 个 / 1.2GB）。
      await waitExit(proc, 5000);
      for (let i = 0; i < 6; i++) {
        try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
        if (!fs.existsSync(profile)) return;
        await sleep(250);
      }
      console.warn('  [warn] 临时 profile 没删干净（Chrome 可能还占着锁）：' + profile);
    }
  };
}

/** 单个页面会话 */
class Page {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message || JSON.stringify(m.error)));
        else resolve(m.result);
      } else if (m.method) {
        const h = this.handlers.get(m.method);
        if (h) h(m.params);
      }
    });
  }

  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP 超时：' + method));
        }
      }, 25000);
    });
  }

  on(method, fn) { this.handlers.set(method, fn); }

  /** 在每次页面脚本执行前注入（用来模拟老浏览器缺失的 API） */
  async addInitScript(script) {
    const r = await this.send('Page.addScriptToEvaluateOnNewDocument', { source: script });
    this._initScripts = this._initScripts || [];
    this._initScripts.push(r.identifier);
    return r.identifier;
  }

  /**
   * 模拟老内核环境：删掉这些 API 后页面必须仍能正常工作
   *   PointerEvent   —— iOS 13 以下 / Android WebView 55 以下没有
   *   ResizeObserver —— iOS 13.2 以下 / WebView 64 以下没有
   *   visualViewport —— 老内核没有，--vh 必须能退回 innerHeight
   *   navigator.clipboard —— 非安全上下文没有，复制必须能退回 execCommand
   */
  async injectLegacyEnv() {
    return this.addInitScript(`
      (function () {
        function kill(name, obj) {
          try { Object.defineProperty(obj || window, name, { value: undefined, configurable: true, writable: true }); } catch (e) {}
        }
        kill('PointerEvent');
        kill('ResizeObserver');
        kill('visualViewport');
        kill('clipboard', navigator);
        kill('IntersectionObserver');
        window.__dgLegacyInjected = true;
      })();
    `);
  }

  /** 模拟设备：尺寸 + DPR + 触摸 */
  async emulate(cfg) {
    this.touchEnabled = !!cfg.touch;
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: cfg.w, height: cfg.h,
      deviceScaleFactor: cfg.dpr || 1,
      mobile: !!cfg.mobile
    });
    await this.send('Emulation.setTouchEmulationEnabled', {
      enabled: !!cfg.touch,
      maxTouchPoints: cfg.touch ? 5 : 1
    });
    if (cfg.ua) await this.send('Emulation.setUserAgentOverride', { userAgent: cfg.ua });
  }

  async goto(url) {
    const loaded = new Promise((res) => {
      this.on('Page.loadEventFired', () => res());
      setTimeout(res, 12000);
    });
    await this.send('Page.navigate', { url });
    await loaded;
    await sleep(500);            // 给 compat.js / app.js 一点执行时间
  }

  /** 在页面里求值，返回 JSON 化的结果 */
  async eval(fnOrExpr) {
    const expr = typeof fnOrExpr === 'function'
      ? '(' + fnOrExpr.toString() + ')()'
      : fnOrExpr;
    const r = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true
    });
    if (r.exceptionDetails) {
      throw new Error('页面求值出错：' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description
        || r.exceptionDetails.text));
    }
    return r.result.value;
  }

  async screenshot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }

  /** 真实触摸事件序列（走浏览器输入管线，不是直接调 JS） */
  async touchStroke(points) {
    await this.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: points[0][0], y: points[0][1], id: 1 }]
    });
    for (let i = 1; i < points.length; i++) {
      await this.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: points[i][0], y: points[i][1], id: 1 }]
      });
      await sleep(16);
    }
    await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }

  async click(selector) {
    const sel = JSON.stringify(selector);
    // 先滚进可视区——手机上按钮常在首屏之外，不滚就点不到
    await this.eval(`(function(){
      var el = document.querySelector(${sel});
      if (el && el.scrollIntoView) { try { el.scrollIntoView({ block: 'center' }); } catch (e) { el.scrollIntoView(); } }
      return true;
    })()`);
    await sleep(220);
    const box = await this.eval(`(function(){
      var el = document.querySelector(${sel});
      if (!el) return null;
      var r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, top: r.top };
    })()`);
    if (!box) throw new Error('找不到元素：' + selector);
    if (box.y < 0 || box.y > (await this.eval('window.innerHeight'))) {
      throw new Error('元素仍不在可视区，无法点击：' + selector + ' y=' + Math.round(box.y));
    }
    if (this.touchEnabled) {
      // 开着触摸模拟时鼠标事件不会触发 click，必须派发真触摸点按
      await this.send('Input.dispatchTouchEvent', {
        type: 'touchStart', touchPoints: [{ x: box.x, y: box.y, id: 1 }]
      });
      await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }
    await sleep(180);
    return box;
  }

  /** 轮询等待页面条件成立 */
  async waitFor(expr, timeout) {
    const end = Date.now() + (timeout || 8000);
    for (;;) {
      if (await this.eval('(function(){ return !!(' + expr + '); })()')) return true;
      if (Date.now() > end) return false;
      await sleep(80);
    }
  }

  async type(selector, text) {
    await this.click(selector);
    await this.eval(`(function(){
      var el = document.querySelector(${JSON.stringify(selector)});
      el.value = ${JSON.stringify(text)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(80);
  }

  close() { try { this.ws.close(); } catch (e) {} }
}

/** 连接（或新建）一个页面 */
async function openPage(inst) {
  // 复用已存在的 about:blank 页
  const list = await (await fetch('http://127.0.0.1:' + inst.port + '/json/list')).json();
  let target = list.find((t) => t.type === 'page');
  if (!target) {
    await fetch('http://127.0.0.1:' + inst.port + '/json/new?about:blank', { method: 'PUT' });
    await sleep(400);
    const list2 = await (await fetch('http://127.0.0.1:' + inst.port + '/json/list')).json();
    target = list2.find((t) => t.type === 'page');
  }
  if (!target) throw new Error('拿不到页面调试地址');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('连接页面调试通道失败')));
  });
  const page = new Page(ws);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  return page;
}

module.exports = { launch, openPage, findBrowser, sleep };
