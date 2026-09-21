'use strict';
/**
 * 多设备 / 多视口真实渲染验证
 * --------------------------------------------------------------
 * 用本机 Chrome（headless + CDP）真的渲染页面，在 9 种视口下检查：
 *   · 设备识别与 data-layout 是否正确
 *   · 有没有横向溢出、画布尺寸是否正常
 *   · 手机版触摸目标是否够大、输入框字号是否 ≥16px（否则 iOS 聚焦会缩放）
 *   · 桌面/手机两套布局的排列方向是否真的换了
 * 并且真的派发触摸事件画一笔，验证「手机手指画图 → 另一端收到笔画」。
 *
 * 用法：node test/responsive.js          （自动起测试服务）
 *      PORT=3000 node test/responsive.js （复用已有服务）
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const net = require('net');
const cdp = require('./cdp');
const { Client } = require('./client');

const ROOT = path.join(__dirname, '..');
const SHOT_DIR = path.join(ROOT, 'screenshots', 'responsive');

let fails = 0;
function T(name, ok, extra) {
  console.log((ok ? '  \u2713 ' : '  \u2717 ') + name + (extra ? '   -> ' + extra : ''));
  if (!ok) fails++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';

/* 视口矩阵：覆盖桌面、平板、手机竖屏/横屏、极窄屏 */
const PROFILES = [
  { name: 'desktop-1440', w: 1440, h: 900, touch: false, mobile: false, expect: 'desktop', ua: null },
  { name: 'laptop-1280', w: 1280, h: 800, touch: false, mobile: false, expect: 'desktop', ua: null },
  { name: 'tablet-1024', w: 1024, h: 768, touch: true, mobile: true, expect: 'desktop', ua: UA_ANDROID },
  { name: 'ipad-768', w: 768, h: 1024, touch: true, mobile: true, expect: 'mobile', ua: UA_ANDROID },
  { name: 'iphone14-390', w: 390, h: 844, dpr: 3, touch: true, mobile: true, expect: 'mobile', ua: UA_IPHONE },
  { name: 'iphoneSE-375', w: 375, h: 667, dpr: 2, touch: true, mobile: true, expect: 'mobile', ua: UA_IPHONE },
  { name: 'android-360', w: 360, h: 640, dpr: 3, touch: true, mobile: true, expect: 'mobile', ua: UA_ANDROID },
  { name: 'narrow-320', w: 320, h: 568, dpr: 2, touch: true, mobile: true, expect: 'mobile', ua: UA_ANDROID },
  { name: 'landscape-844x390', w: 844, h: 390, dpr: 3, touch: true, mobile: true, expect: 'mobile', ua: UA_IPHONE }
];

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = (v) => { try { s.destroy(); } catch (e) {} resolve(v); };
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
    s.setTimeout(1000, () => done(false));
  });
}

/** 登录页在某个视口下的体检 */
async function auditLogin(page, p, base) {
  await page.emulate(p);
  await page.goto(base + '/');
  const r = await page.eval(`(function(){
    var html = document.documentElement;
    var card = document.querySelector('.login-card');
    var tip  = document.getElementById('tip-url');
    var toggles = document.querySelectorAll('.js-layout-toggle');
    var cr = card ? card.getBoundingClientRect() : null;
    return {
      layout: html.getAttribute('data-layout'),
      device: html.getAttribute('data-device'),
      engine: html.getAttribute('data-engine'),
      flexgap: html.getAttribute('data-flexgap'),
      vh: getComputedStyle(html).getPropertyValue('--vh').trim(),
      innerW: window.innerWidth,
      scrollW: html.scrollWidth,
      bodyScrollW: document.body.scrollWidth,
      cardW: cr ? Math.round(cr.width) : 0,
      cardRight: cr ? Math.round(cr.right) : 0,
      tip: tip ? tip.textContent : '',
      toggleCount: toggles.length,
      toggleText: toggles.length ? toggles[0].textContent : '',
      hint: (document.getElementById('layout-hint') || {}).textContent || '',
      hasCompat: typeof window.DG === 'object',
      hasSheetHandle: !!document.getElementById('sheet-handle'),
      loginActive: document.getElementById('screen-login').classList.contains('active')
    };
  })()`);

  const label = p.name;
  T(label + ' · 布局识别为' + p.expect, r.layout === p.expect, 'data-layout=' + r.layout);
  T(label + ' · 无横向溢出', r.scrollW <= r.innerW + 1 && r.bodyScrollW <= r.innerW + 1,
    'scrollWidth ' + r.scrollW + ' vs viewport ' + r.innerW);
  T(label + ' · 登录卡片没有超出视口', r.cardRight <= r.innerW + 1, '卡片右边界 ' + r.cardRight);
  T(label + ' · compat.js 已生效', r.hasCompat === true && !!r.vh, '--vh=' + r.vh + ' engine=' + r.engine);
  T(label + ' · 分享地址完整显示', /^https?:\/\//.test(r.tip), r.tip);
  T(label + ' · 布局切换按钮可用', r.toggleCount >= 1 && /切换/.test(r.toggleText), r.toggleText);
  if (p.expect === 'mobile') {
    T(label + ' · 触摸设备识别正确', r.device === 'touch', r.device);
  }
  return r;
}

/** 进游戏页体检 */
async function auditGame(page, p) {
  return page.eval(`(function(){
    var q = function(s){ return document.querySelector(s); };
    var side = q('.side'), stage = q('.stage'), canvas = q('#board');
    var wrap = q('.canvas-wrap'), input = q('#input-guess');
    var sr = side.getBoundingClientRect(), tr = stage.getBoundingClientRect();
    var cr = canvas.getBoundingClientRect();
    function minSize(sel){
      var els = Array.prototype.slice.call(document.querySelectorAll(sel));
      var min = 9999, worst = '';
      els.forEach(function(el){
        var b = el.getBoundingClientRect();
        if (b.width < 1 || b.height < 1) return;
        var m = Math.min(b.width, b.height);
        if (m < min) { min = m; worst = sel; }
      });
      return min === 9999 ? null : Math.round(min);
    }
    return {
      stageTop: Math.round(tr.top), stageLeft: Math.round(tr.left),
      sideTop: Math.round(sr.top), sideLeft: Math.round(sr.left),
      stacked: sr.top >= tr.bottom - 2,
      sideBySide: sr.left < tr.left,
      canvasW: Math.round(cr.width), canvasH: Math.round(cr.height),
      canvasPx: canvas.width + 'x' + canvas.height,
      dprUsed: (cr.width ? (canvas.width / cr.width).toFixed(2) : 0),
      inputFont: input ? parseFloat(getComputedStyle(input).fontSize) : 0,
      toolBtn: minSize('.tool-btn'), wsize: minSize('.wsize'),
      reactBtn: minSize('.react-btn'), colorDot: minSize('.color-dot'),
      btnSm: minSize('#screen-game .btn.sm'),
      handleVisible: (function(){ var h = q('#sheet-handle'); if (!h) return false;
        return getComputedStyle(h).display !== 'none'; })(),
      scrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
      boardTouchAction: getComputedStyle(canvas).touchAction,
      overflows: document.documentElement.scrollWidth > window.innerWidth + 1
    };
  })()`);
}

(async () => {
  console.log('\n=== 多设备真实渲染验证（headless Chrome + CDP）===\n');

  const exe = cdp.findBrowser();
  if (!exe) {
    console.log('  ⚠ 没找到 Chrome / Edge，跳过真实渲染验证\n');
    process.exit(0);
  }
  console.log('  浏览器：' + exe + '\n');

  /* ---- 服务：优先复用 env PORT，否则自己起一个 ---- */
  let serverProc = null;
  let PORT = Number(process.env.PORT) || 0;
  if (!PORT || !(await portOpen(PORT))) {
    PORT = await freePort();
    serverProc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { PORT: String(PORT), TURN_END_DELAY: '1200', VOTE_WINDOW_MS: '800' }),
      stdio: 'ignore'
    });
    for (let i = 0; i < 40 && !(await portOpen(PORT)); i++) await sleep(200);
  }
  const base = 'http://127.0.0.1:' + PORT;
  console.log('  测试服务：' + base + '\n');

  let inst = null, page = null;
  try {
    inst = await cdp.launch();
    page = await cdp.openPage(inst);
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    /* ---------- 一、登录页 9 种视口 ---------- */
    console.log('  ── 登录页视口矩阵 ──');
    const seen = {};
    for (const p of PROFILES) {
      seen[p.name] = await auditLogin(page, p, base);
      await page.screenshot(path.join(SHOT_DIR, 'login-' + p.name + '.png'));
    }

    /* ---------- 二、flex gap 探测 ---------- */
    T('flex gap 能力探测已执行', seen['desktop-1440'].flexgap === '0' || seen['desktop-1440'].flexgap === '1',
      'data-flexgap=' + seen['desktop-1440'].flexgap);

    /* ---------- 三、手动切换布局 ---------- */
    console.log('\n  ── 手动切换布局 ──');
    await page.emulate(PROFILES[4]);                  // 手机视口
    await page.goto(base + '/');
    await page.click('.js-layout-toggle');
    await sleep(400);
    let after = await page.eval('document.documentElement.getAttribute("data-layout")');
    T('手机上可手动切到电脑版', after === 'desktop', 'data-layout=' + after);
    await page.screenshot(path.join(SHOT_DIR, 'login-forced-desktop-on-phone.png'));
    await page.eval('window.DG.resetMode()');
    await sleep(300);
    after = await page.eval('document.documentElement.getAttribute("data-layout")');
    T('恢复自动识别后回到手机版', after === 'mobile', 'data-layout=' + after);

    /* ---------- 四、进游戏页 ---------- */
    console.log('\n  ── 游戏页（手机视口 390×844）──');
    await page.emulate(PROFILES[4]);
    await page.goto(base + '/');
    await page.type('#input-name', '手机甲');
    await page.click('#btn-create');
    await sleep(900);
    const lobby = await page.eval(`(function(){
      return {
        active: document.getElementById('screen-lobby').classList.contains('active'),
        code: (document.getElementById('lobby-code')||{}).textContent || '',
        chips: document.querySelectorAll('#theme-chips .chip').length,
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1
      };
    })()`);
    T('手机上能创建房间进大厅', lobby.active && /^\d{4}$/.test(lobby.code), '房间号 ' + lobby.code);
    T('大厅主题按钮在手机上正常渲染', lobby.chips >= 20, lobby.chips + ' 个');
    T('大厅无横向溢出', !lobby.overflow);
    await page.screenshot(path.join(SHOT_DIR, 'lobby-phone.png'));

    /* 第二个玩家用 Node 客户端，避免依赖第二个浏览器 */
    const B = new Client('B', PORT);
    await B.connect();
    B.send({ t: 'join', name: '电脑乙', roomCode: lobby.code, avatar: '🦊' });
    await B.wait('joined');
    await sleep(300);
    await page.click('#btn-start');
    const entered = await page.waitFor('document.getElementById("screen-game").classList.contains("active")', 8000);
    T('手机上进入游戏页', entered);
    await sleep(600);
    let game = await auditGame(page, PROFILES[4]);
    T('手机版：画布在面板上方（纵向堆叠）', game.stacked && !game.sideBySide,
      'stage.top=' + game.stageTop + ' side.top=' + game.sideTop);
    T('手机版：画布尺寸正常', game.canvasW > 200 && game.canvasH > 100,
      game.canvasW + '×' + game.canvasH + ' css / ' + game.canvasPx + ' 位图');
    T('手机版：devicePixelRatio 已压到 ≤2（性能）', parseFloat(game.dprUsed) <= 2.01, 'dpr=' + game.dprUsed);
    T('手机版：输入框字号 ≥16px（iOS 不会聚焦缩放）', game.inputFont >= 16, game.inputFont + 'px');
    T('手机版：底部折叠条可见', game.handleVisible === true);
    T('手机版：工具栏按钮 ≥40px', game.toolBtn >= 40, game.toolBtn + 'px');
    T('手机版：粗细按钮 ≥40px', game.wsize >= 40, game.wsize + 'px');
    T('手机版：表情按钮 ≥40px', game.reactBtn >= 40, game.reactBtn + 'px');
    T('手机版：颜色圆点 ≥28px', game.colorDot >= 28, game.colorDot + 'px');
    T('手机版：小按钮高度 ≥34px', game.btnSm >= 34, game.btnSm + 'px');
    T('手机版：游戏页无横向溢出', !game.overflows, 'scrollWidth ' + game.scrollW + ' vs ' + game.innerW);
    T('画布已设置 touch-action:none（防止画图时页面滚动）', game.boardTouchAction === 'none', game.boardTouchAction);
    await page.screenshot(path.join(SHOT_DIR, 'game-phone.png'));

    /* ---------- 五、真触摸画一笔 ---------- */
    console.log('\n  ── 真触摸绘制 ──');
    let drew = false;
    for (let turn = 0; turn < 4 && !drew; turn++) {
      // 等本回合的画手是谁
      let browserDrawer = false, wordChoice = null;
      for (let i = 0; i < 160; i++) {
        if (await page.eval(`document.getElementById('ov-choose').classList.contains('show')`)) {
          browserDrawer = true; break;
        }
        const wc = B.take('wordChoice');
        if (wc) { wordChoice = wc; break; }
        await sleep(50);
      }
      if (browserDrawer) {
        // 浏览器是画手：选词 → 真手指画一笔 → 看对面是否收到
        await page.click('.word-pick');
        await sleep(500);
        const box = await page.eval(`(function(){
          var r = document.getElementById('board').getBoundingClientRect();
          return { x: r.left, y: r.top, w: r.width, h: r.height };
        })()`);
        B.clear();
        const pts = [];
        for (let i = 0; i <= 10; i++) {
          pts.push([box.x + box.w * (0.2 + 0.06 * i), box.y + box.h * (0.5 + 0.02 * i)]);
        }
        await page.touchStroke(pts);
        await sleep(600);
        const ops = B.inbox.filter((m) => m.t === 'draw').map((m) => m.op);
        T('触摸事件真的画出了笔画并同步到对手', ops.indexOf('begin') >= 0 && ops.indexOf('end') >= 0,
          '对手收到 draw: ' + ops.join(','));
        T('触摸笔画坐标在画布范围内（0~1 归一化）',
          B.inbox.some((m) => m.t === 'draw' && m.op === 'begin' && m.x > 0 && m.x < 1 && m.y > 0 && m.y < 1),
          (function () {
            const b = B.inbox.find((m) => m.t === 'draw' && m.op === 'begin');
            return b ? 'x=' + b.x.toFixed(3) + ' y=' + b.y.toFixed(3) : '无';
          })());
        await page.screenshot(path.join(SHOT_DIR, 'game-phone-drawing.png'));
        drew = true;
      } else if (wordChoice) {
        // 电脑是画手：让它出题，然后让浏览器按已知答案猜中，好进入下一回合
        B.clear();
        B.send({ t: 'chooseWord', word: wordChoice.words[0].w });
        const dw = await B.wait('drawerWord', 8000).catch(() => null);
        if (!dw) break;
        await sleep(400);
        await page.type('#input-guess', dw.word);
        await page.click('#btn-send');
        await B.wait('turnEnd', 8000).catch(() => null);
        await sleep(2400);                 // 等下一回合的选词下发
      } else {
        break;
      }
    }
    if (!drew) T('触摸事件真的画出了笔画并同步到对手', false, '4 个回合内浏览器都没当上画手');

    /* ---------- 六、桌面视口下的游戏页 ---------- */
    console.log('\n  ── 游戏页（桌面视口 1440×900）──');
    await page.emulate(PROFILES[0]);
    await sleep(700);
    game = await auditGame(page, PROFILES[0]);
    T('桌面版：侧栏与舞台左右并排', game.sideBySide && !game.stacked,
      'side.left=' + game.sideLeft + ' stage.left=' + game.stageLeft);
    T('桌面版：画布尺寸正常', game.canvasW > 600 && game.canvasH > 300,
      game.canvasW + '×' + game.canvasH);
    T('桌面版：折叠条隐藏', game.handleVisible === false);
    T('桌面版：无横向溢出', !game.overflows);
    await page.screenshot(path.join(SHOT_DIR, 'game-desktop.png'));

    /* 桌面→手机 实时切换（不刷新页面） */
    await page.emulate(PROFILES[4]);
    await sleep(700);
    const swapped = await auditGame(page, PROFILES[4]);
    T('视口变窄后自动切成手机版（无需刷新）', swapped.stacked && !swapped.sideBySide,
      'stage.top=' + swapped.stageTop + ' side.top=' + swapped.sideTop);
    T('切换后画布重新量算，没有溢出', swapped.canvasW > 200 && !swapped.overflows,
      swapped.canvasW + '×' + swapped.canvasH);
    await page.screenshot(path.join(SHOT_DIR, 'game-switched-to-phone.png'));

    /* ---------- 七、老内核降级（模拟 iOS 12 / 老 Android WebView） ---------- */
    console.log('\n  ── 老内核降级（删掉 PointerEvent / ResizeObserver / visualViewport / clipboard）──');
    const legacy = await cdp.openPage(inst);
    try {
      await legacy.injectLegacyEnv();
      await legacy.emulate(PROFILES[4]);            // 手机视口 + 触摸
      await legacy.goto(base + '/');

      const env = await legacy.eval(`(function(){
        return {
          injected: !!window.__dgLegacyInjected,
          hasPointerEvent: typeof window.PointerEvent !== 'undefined',
          hasVV: typeof window.visualViewport !== 'undefined',
          hasClipboard: !!(navigator.clipboard && navigator.clipboard.writeText),
          roIsPolyfill: !!(window.ResizeObserver && window.ResizeObserver.__dgPolyfill),
          layout: document.documentElement.getAttribute('data-layout'),
          vh: getComputedStyle(document.documentElement).getPropertyValue('--vh').trim(),
          hasDG: typeof window.DG === 'object',
          overflow: document.documentElement.scrollWidth > window.innerWidth + 1
        };
      })()`);
      T('降级环境已注入（PointerEvent / visualViewport / clipboard 确实不存在）',
        env.injected && !env.hasPointerEvent && !env.hasVV && !env.hasClipboard,
        'PointerEvent=' + env.hasPointerEvent + ' visualViewport=' + env.hasVV +
        ' clipboard=' + env.hasClipboard);
      T('缺失的 ResizeObserver 被 compat 兜底实现接管', env.roIsPolyfill === true,
        'roIsPolyfill=' + env.roIsPolyfill);
      T('老内核下 compat.js 仍能识别设备并定布局', env.hasDG && env.layout === 'mobile',
        'data-layout=' + env.layout);
      T('老内核下 --vh 回退到 innerHeight 仍算得出来', !!env.vh && parseFloat(env.vh) > 0, '--vh=' + env.vh);
      T('老内核下登录页无横向溢出', !env.overflow);
      await legacy.screenshot(path.join(SHOT_DIR, 'legacy-login.png'));

      /* 复制必须退回 execCommand */
      const copyRes = await legacy.eval(`(function(){
        var btn = document.getElementById('btn-copy-url');
        if (!btn) return { err: 'no button' };
        var used = 0;
        var orig = document.execCommand;
        document.execCommand = function (c) { used++; return true; };
        btn.click();
        return { used: used, text: btn.textContent };
      })()`);
      await sleep(200);
      const copyText2 = await legacy.eval(`document.getElementById('btn-copy-url').textContent`);
      T('老内核无 clipboard API 时复制退回 execCommand',
        copyRes.used >= 1, 'execCommand 调用 ' + copyRes.used + ' 次，按钮文案「' + copyText2 + '」');

      /* 进游戏，验证触摸回退路径真的能画 */
      await legacy.type('#input-name', '老内核甲');
      await legacy.click('#btn-create');
      await legacy.waitFor('document.getElementById("screen-lobby").classList.contains("active")', 8000);
      const lcode = await legacy.eval('document.getElementById("lobby-code").textContent');
      T('老内核下能创建房间', /^\d{4}$/.test(lcode), '房间号 ' + lcode);

      const LB = new Client('LB', PORT);
      await LB.connect();
      LB.send({ t: 'join', name: '对照乙', roomCode: lcode, avatar: '🐼' });
      await LB.wait('joined');
      await sleep(400);
      await legacy.click('#btn-start');
      T('老内核下能进入游戏页',
        await legacy.waitFor('document.getElementById("screen-game").classList.contains("active")', 8000));

      let legacyDrew = false;
      for (let turn = 0; turn < 4 && !legacyDrew; turn++) {
        let browserDrawer = false, wc = null;
        for (let i = 0; i < 160; i++) {
          if (await legacy.eval(`document.getElementById('ov-choose').classList.contains('show')`)) {
            browserDrawer = true; break;
          }
          const m = LB.take('wordChoice');
          if (m) { wc = m; break; }
          await sleep(50);
        }
        if (browserDrawer) {
          await legacy.click('.word-pick');
          await sleep(500);
          const box = await legacy.eval(`(function(){
            var r = document.getElementById('board').getBoundingClientRect();
            return { x: r.left, y: r.top, w: r.width, h: r.height };
          })()`);
          LB.clear();
          const pts = [];
          for (let i = 0; i <= 8; i++) pts.push([box.x + box.w * (0.25 + 0.05 * i), box.y + box.h * (0.4 + 0.03 * i)]);
          await legacy.touchStroke(pts);      // 真触摸 → 走 touch 回退分支
          await sleep(600);
          const ops = LB.inbox.filter((m) => m.t === 'draw').map((m) => m.op);
          T('老内核（无 PointerEvent）下触摸画图仍然可用',
            ops.indexOf('begin') >= 0 && ops.indexOf('end') >= 0, '对手收到 draw: ' + ops.join(','));
          await legacy.screenshot(path.join(SHOT_DIR, 'legacy-drawing.png'));
          legacyDrew = true;
        } else if (wc) {
          LB.clear();
          LB.send({ t: 'chooseWord', word: wc.words[0].w });
          const dw = await LB.wait('drawerWord', 8000).catch(() => null);
          if (!dw) break;
          await sleep(400);
          await legacy.type('#input-guess', dw.word);
          await legacy.click('#btn-send');
          await LB.wait('turnEnd', 8000).catch(() => null);
          await sleep(2400);
        } else break;
      }
      if (!legacyDrew) T('老内核（无 PointerEvent）下触摸画图仍然可用', false, '4 个回合内没当上画手');

      /* 老内核下视口变化也要能重排（ResizeObserver 缺失，靠 resize 事件兜底） */
      await legacy.emulate(PROFILES[0]);
      await sleep(800);
      const afterResize = await legacy.eval(`(function(){
        var s = document.querySelector('.side').getBoundingClientRect();
        var t = document.querySelector('.stage').getBoundingClientRect();
        return { sideBySide: s.left < t.left, canvasW: Math.round(document.getElementById('board').getBoundingClientRect().width) };
      })()`);
      T('老内核下拉伸窗口能重排成桌面版（ResizeObserver 兜底生效）',
        afterResize.sideBySide && afterResize.canvasW > 600,
        'sideBySide=' + afterResize.sideBySide + ' 画布宽 ' + afterResize.canvasW);
      LB.close();
    } finally {
      legacy.close();
    }

    /* ================= 邀请链接：?room= =================
     * ⚠️ cdp.openPage() 复用的是**同一个标签页**，不是新开一个。
     * 所以不能"用浏览器建房、再用另一个页去加入" —— 建房那页会被导航走，
     * WS 断开 → 房间因最后一人离开被回收 → 再加入就报「房间不存在」。
     * 这里改用 WebSocket 客户端建房，浏览器只用同一个页面走完整条路径。 */
    const invitePort = Number(new URL(base).port);
    const inviter = new Client('邀请房主', invitePort);
    await inviter.connect();
    inviter.send({ t: 'join', name: '邀请房主', avatar: '🐼' });
    const inviterRoom = (await inviter.wait('joined', 8000)).room.code;

    const invitee = await cdp.openPage(inst);
    try {
      // ① 没存昵称：只自动填房间号 + 提示起名字
      await invitee.goto(base + '/');
      await invitee.eval("try{localStorage.removeItem('dg_name')}catch(e){}");
      await invitee.goto(base + '/?room=' + inviterRoom);
      await sleep(700);
      const st1 = await invitee.eval(`(function(){
        var c = document.getElementById('input-code');
        var t = document.getElementById('invite-tip');
        var cr = document.querySelector('.credit');
        var q = document.getElementById('credit-qq');
        return { code: c ? c.value : '', tip: t ? t.textContent : '',
                 credit: cr ? cr.textContent.replace(/\\s+/g, ' ').trim() : '',
                 qq: q ? q.textContent.trim() : '' };
      })()`);
      T('邀请链接自动填好房间号（朋友不用手输 4 位数字）', st1.code === inviterRoom,
        '填到「' + st1.code + '」');
      T('并提示「起个名字就能进」', String(st1.tip).indexOf(inviterRoom) >= 0,
        String(st1.tip).trim());
      T('登录页显示开发者署名（炸鸡 / QQ）',
        /炸鸡/.test(st1.credit) && /3627690979/.test(st1.credit), st1.credit);
      T('QQ 号是可点一下复制的元素', st1.qq === '3627690979', st1.qq);

      // ② 存过昵称：点开就进房，一个按钮都不用点
      await invitee.eval("try{localStorage.setItem('dg_name','邀请乙')}catch(e){}");
      await invitee.goto(base + '/?room=' + inviterRoom);
      await invitee.waitFor(
        'document.getElementById("screen-lobby").classList.contains("active")', 8000
      ).catch(() => null);
      const st2 = await invitee.eval(`(function(){
        return {
          active: document.getElementById('screen-lobby').classList.contains('active'),
          code: (document.getElementById('lobby-code')||{}).textContent || '',
          url: (document.getElementById('invite-url')||{}).textContent || ''
        };
      })()`);
      T('存过昵称 → 点开链接直接进房', st2.active && st2.code === inviterRoom,
        '进到房间 ' + st2.code);
      T('房间里给出可复制的邀请链接（带房间号）',
        String(st2.url).indexOf('room=' + inviterRoom) >= 0, String(st2.url).trim());
    } finally {
      invitee.close();
      inviter.close();
    }

    B.close();
  } catch (e) {
    T('真实渲染验证流程', false, e.message);
  } finally {
    if (page) page.close();
    if (inst) await inst.close();
    if (serverProc) { try { serverProc.kill(); } catch (e) {} }
  }

  console.log('\n  截图目录：' + SHOT_DIR);
  console.log('\n' + (fails === 0 ? '全部通过 ✅' : fails + ' 项失败 ❌') + '\n');
  process.exit(fails === 0 ? 0 : 1);
})();
