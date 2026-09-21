/* ==================================================================
 *  你画我猜 · 浏览器兼容层 + 设备识别
 * ------------------------------------------------------------------
 *  这个文件必须最先加载，而且要跑在**老浏览器**上，所以刻意写成 ES5：
 *  不用箭头函数、不用 const/let、不用模板字符串、不用 ?. / ??。
 *
 *  职责：
 *    1) 补齐老内核缺失的能力（ResizeObserver / Element.remove / flex gap 探测等）
 *    2) 自动识别设备类型，把结果写到 <html data-layout="mobile|desktop">
 *       —— 页面样式全部由这个属性驱动，不再依赖媒体查询，JS 与 CSS 判断口径一致
 *    3) 处理移动端视口高度（地址栏伸缩、软键盘弹出）与安全区
 * ================================================================== */
(function () {
  'use strict';

  var d = document;
  var html = d.documentElement;
  var win = window;

  /* ================================================================
   *  一、老内核补丁
   * ================================================================ */
  if (!Object.assign) {
    Object.assign = function (t) {
      for (var i = 1; i < arguments.length; i++) {
        var s = arguments[i];
        if (!s) continue;
        for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) t[k] = s[k];
      }
      return t;
    };
  }
  if (!Array.prototype.includes) {
    Array.prototype.includes = function (v) { return this.indexOf(v) !== -1; };
  }
  if (!String.prototype.includes) {
    String.prototype.includes = function (v) { return this.indexOf(v) !== -1; };
  }
  if (!String.prototype.startsWith) {
    String.prototype.startsWith = function (v, p) { return this.substr(p || 0, v.length) === v; };
  }
  if (!String.prototype.padStart) {
    String.prototype.padStart = function (n, p) {
      var s = String(this);
      p = p === undefined ? ' ' : String(p);
      while (s.length < n) s = p + s;
      return s;
    };
  }
  if (!Array.from) {
    Array.from = function (a) { return Array.prototype.slice.call(a); };
  }
  if (!Element.prototype.remove) {
    Element.prototype.remove = function () { if (this.parentNode) this.parentNode.removeChild(this); };
  }
  if (!Element.prototype.matches) {
    Element.prototype.matches = Element.prototype.msMatchesSelector ||
      Element.prototype.webkitMatchesSelector || function (s) {
        var m = (this.document || this.ownerDocument).querySelectorAll(s);
        var i = 0;
        while (m[i] && m[i] !== this) i++;
        return !!m[i];
      };
  }
  if (!win.requestAnimationFrame) {
    win.requestAnimationFrame = function (cb) { return win.setTimeout(function () { cb(Date.now()); }, 16); };
    win.cancelAnimationFrame = function (id) { win.clearTimeout(id); };
  }
  /* ResizeObserver：iOS 13 / 老 Android WebView 没有，用 window.resize 兜底 */
  if (!win.ResizeObserver) {
    win.ResizeObserver = function (cb) {
      this._cb = cb;
      this._targets = [];
      var self = this;
      this._onResize = function () {
        for (var i = 0; i < self._targets.length; i++) {
          cb([{ target: self._targets[i], contentRect: self._targets[i].getBoundingClientRect() }], self);
        }
      };
      if (!win.__dgROPatched) {
        win.__dgROPatched = [];
        win.addEventListener('resize', function () {
          for (var i = 0; i < win.__dgROPatched.length; i++) win.__dgROPatched[i]._onResize();
        });
        win.addEventListener('orientationchange', function () {
          setTimeout(function () {
            for (var i = 0; i < win.__dgROPatched.length; i++) win.__dgROPatched[i]._onResize();
          }, 250);
        });
      }
      win.__dgROPatched.push(this);
    };
    win.ResizeObserver.prototype.observe = function (el) {
      if (this._targets.indexOf(el) < 0) this._targets.push(el);
    };
    win.ResizeObserver.prototype.unobserve = function (el) {
      var i = this._targets.indexOf(el);
      if (i >= 0) this._targets.splice(i, 1);
    };
    win.ResizeObserver.prototype.disconnect = function () { this._targets = []; };
    win.ResizeObserver.__dgPolyfill = true;      // 标记：这是兜底实现，不是原生
  }

  /* ================================================================
   *  二、设备识别
   * ================================================================ */
  var ua = navigator.userAgent || '';
  var platform = navigator.platform || '';
  var maxTouch = navigator.maxTouchPoints || navigator.msMaxTouchPoints || 0;

  var isTouch = ('ontouchstart' in win) || maxTouch > 0;
  var isIOS = /iPad|iPhone|iPod/.test(ua) ||
    (platform === 'MacIntel' && maxTouch > 1);            // iPadOS 13+ 伪装成 Mac
  var isAndroid = /Android/i.test(ua);
  var isHarmony = /HarmonyOS|OpenHarmony|ArkWeb/i.test(ua);
  var isWeChat = /MicroMessenger/i.test(ua);
  var isMobileUA = /Mobile|Android|iPhone|iPad|iPod|Windows Phone|HarmonyOS|MicroMessenger|QQBrowser|UCBrowser|Quark|Via|MiuiBrowser|HeyTapBrowser|HuaweiBrowser|VivoBrowser|OppoBrowser|baidubrowser|SamsungBrowser|SogouMobileBrowser|LieBaoFast|MQQBrowser/i.test(ua);
  var isStandalone = (win.navigator.standalone === true) ||
    (win.matchMedia && win.matchMedia('(display-mode: standalone)').matches);

  /* 内核特征，用于定位兼容问题（不是用来做分支的） */
  var engine = 'unknown';
  if (/Trident|MSIE/.test(ua)) engine = 'trident';
  else if (/Edg\//.test(ua)) engine = 'edge';
  else if (/OPR\/|Opera/.test(ua)) engine = 'opera';
  else if (/Firefox\//.test(ua)) engine = 'gecko';
  else if (/Chrome\/|CriOS/.test(ua)) engine = 'blink';
  else if (/Safari\//.test(ua)) engine = 'webkit';

  var DEVICE = {
    touch: isTouch,
    ios: isIOS,
    android: isAndroid,
    harmony: isHarmony,
    wechat: isWeChat,
    mobileUA: isMobileUA,
    standalone: isStandalone,
    engine: engine,
    dpr: win.devicePixelRatio || 1
  };

  /* ---- 布局模式：auto / mobile / desktop（用户可手动覆盖并记住） ---- */
  var MODE_KEY = 'dg_layout_mode';

  function readMode() {
    try {
      var v = win.localStorage.getItem(MODE_KEY);
      return (v === 'mobile' || v === 'desktop') ? v : 'auto';
    } catch (e) { return 'auto'; }
  }
  function writeMode(m) {
    try { win.localStorage.setItem(MODE_KEY, m); } catch (e) {}
  }

  /* auto 的判定口径：
   *   ① 触摸设备且短边 ≤ 500px —— 覆盖手机横竖屏（横屏时宽度会超过断点）
   *   ② 窗口宽度 ≤ 880px       —— 覆盖窄窗口、平板竖屏
   *   其余走桌面布局（平板横屏、笔记本、外接显示器）
   */
  function autoLayout() {
    var w = win.innerWidth || html.clientWidth || 0;
    var h = win.innerHeight || html.clientHeight || 0;
    var shortSide = Math.min(w || 9999, h || 9999);
    if (isTouch && shortSide <= 500) return 'mobile';
    if (w && w <= 880) return 'mobile';
    return 'desktop';
  }

  function resolveLayout() {
    var mode = readMode();
    return (mode === 'mobile' || mode === 'desktop') ? mode : autoLayout();
  }

  var currentLayout = '';

  function applyLayout(force) {
    var layout = resolveLayout();
    if (layout === currentLayout && !force) return;
    currentLayout = layout;
    html.setAttribute('data-layout', layout);
    html.setAttribute('data-device', isTouch ? 'touch' : 'mouse');
    html.setAttribute('data-engine', engine);
    if (isIOS) html.setAttribute('data-ios', '1');
    if (isWeChat) html.setAttribute('data-wechat', '1');
    setVH();
    if (typeof win.DG_ON_LAYOUT === 'function') {
      try { win.DG_ON_LAYOUT(layout, DEVICE); } catch (e) {}
    }
  }

  /* ================================================================
   *  三、视口高度 / 安全区
   *     移动端地址栏会伸缩、软键盘会顶起视口，100vh 在手机上不可靠。
   *     这里算出真实可视高度写进 --vh，CSS 用 calc(var(--vh) * 100) 消费。
   * ================================================================ */
  function setVH() {
    var h = 0;
    if (win.visualViewport && win.visualViewport.height) {
      h = win.visualViewport.height;
    } else {
      h = win.innerHeight || html.clientHeight || 0;
    }
    if (!h) return;
    html.style.setProperty('--vh', (h * 0.01) + 'px');
    html.style.setProperty('--app-h', h + 'px');
  }

  /* ================================================================
   *  四、能力探测（DOM 就绪后跑，因为要插入元素测量）
   * ================================================================ */
  function supportsFlexGap() {
    try {
      var box = d.createElement('div');
      box.style.cssText = 'display:flex;flex-direction:column;row-gap:1px;position:absolute;left:-9999px;top:0;visibility:hidden';
      var a = d.createElement('div');
      var b = d.createElement('div');
      a.style.height = '1px';
      b.style.height = '1px';
      box.appendChild(a);
      box.appendChild(b);
      d.body.appendChild(box);
      var ok = box.scrollHeight === 3;      // 1 + gap1 + 1；不支持 gap 时为 2
      box.parentNode.removeChild(box);
      return ok;
    } catch (e) { return true; }
  }

  function probe() {
    var gapOk = supportsFlexGap();
    html.setAttribute('data-flexgap', gapOk ? '1' : '0');
    if (!gapOk) html.className += ' no-flex-gap';
  }

  /* ================================================================
   *  五、对外接口
   * ================================================================ */
  win.DG = {
    device: DEVICE,
    get layout() { return currentLayout; },
    get mode() { return readMode(); },
    setMode: function (m) {
      writeMode(m);
      applyLayout(true);
      return resolveLayout();
    },
    /* 在 mobile / desktop 之间切换（auto 时基于当前实际布局取反） */
    toggle: function () {
      var next = currentLayout === 'mobile' ? 'desktop' : 'mobile';
      return win.DG.setMode(next);
    },
    resetMode: function () { return win.DG.setMode('auto'); },
    autoLayout: autoLayout,
    refresh: function () { applyLayout(true); },
    isMobile: function () { return currentLayout === 'mobile'; }
  };

  /* ---- 立即定布局（在 <head> 里同步执行，避免首屏闪一下桌面版） ---- */
  applyLayout(true);

  /* ---- 尺寸变化 / 旋转 / 软键盘 ---- */
  var rt = null;
  function onResize() {
    if (rt) clearTimeout(rt);
    rt = setTimeout(function () { setVH(); applyLayout(); }, 80);
  }
  win.addEventListener('resize', onResize);
  win.addEventListener('orientationchange', function () { setTimeout(function () { setVH(); applyLayout(); }, 260); });
  if (win.visualViewport) {
    win.visualViewport.addEventListener('resize', setVH);
    win.visualViewport.addEventListener('scroll', setVH);
  }

  if (d.readyState === 'loading') {
    d.addEventListener('DOMContentLoaded', function () { probe(); setVH(); });
  } else {
    probe();
  }
})();
