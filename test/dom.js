'use strict';
/**
 * 前端 DOM 冒烟测试：在 jsdom 里真实执行 app.js，验证
 *   1) buildUI() 不抛错（元素 id 齐全）
 *   2) 词库主题 chips（含 🎲 随机 3 类 / 📅 每日主题 快捷项）
 *   3) 玩法限制开关
 *   4) 自定义词库导入
 *   5) 连击角标 / 词池进度 / 开天眼状态机
 *   6) 画作投票（星级交互 + 结算回显）
 *   7) 结算页称号、词库统计与最佳画作
 *   8) 反应表情条已移出绘图工具栏
 * 依赖：jsdom（安装在托管 node workspace）
 * 运行：NODE_PATH=<workspace>/node_modules node test/dom.js
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let fails = 0;
function T(name, ok, extra) {
  console.log((ok ? '  \u2713 ' : '  \u2717 ') + name + (extra ? '   -> ' + extra : ''));
  if (!ok) fails++;
}

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const cssText = fs.readFileSync(path.join(ROOT, 'public/style.css'), 'utf8');

const dom = new JSDOM(html, {
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  url: 'http://localhost:3000/'
});
const { window } = dom;

/* ---- 浏览器 API 打桩 ---- */
const ctxStub = new Proxy({}, { get: () => () => {} });
window.HTMLCanvasElement.prototype.getContext = () => ctxStub;
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.AudioContext = class {
  constructor() { this.currentTime = 0; this.destination = {}; }
  createOscillator() { return { type: '', frequency: { setValueAtTime() {} }, connect() {}, start() {}, stop() {} }; }
  createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
};
window.WebSocket = class { constructor() { this.readyState = 1; } send() {} close() {} };

console.log('\n=== 前端 DOM 冒烟测试 ===\n');

let bootErr = null;
try {
  // app.js 顶部是 'use strict'，严格模式下 eval 的声明不会挂到 window 上，
  // 所以在同一作用域里追加一行把内部函数导出来，供测试直接调用。
  window.eval(appJs + '\n;window.__api = { handle, buildUI, show, S, $, strokeVisible, blindActive, isMobileLayout, copyText, advanceReveal, predictTail, setCanvasBg };');
} catch (e) { bootErr = e; }
T('app.js 在真实 DOM 中初始化不报错', !bootErr, bootErr ? bootErr.message : 'buildUI + resizeCanvas 均正常');
if (bootErr) { console.log('\n1 项失败 ❌\n'); process.exit(1); }

const api = window.__api;
const handle = api.handle;

/* 记录前端发出的消息，用来断言交互是否真的上报了 */
const sent = [];
api.S.ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)) };

const $ = (id) => window.document.getElementById(id);
const chip = (cat) => window.document.querySelector('#theme-chips .chip[data-cat="' + cat + '"]');
const lchip = (k) => window.document.querySelector('#limit-chips .chip[data-limit="' + k + '"]');
const stars = () => [...window.document.querySelectorAll('#vote-stars .star')];

const cats = [
  { name: '动物', count: 53 }, { name: '食物', count: 46 },
  { name: '成语', count: 35 }, { name: '影视动漫', count: 26 }
];
const themeMeta = [
  { key: '__random3', name: '🎲 随机 3 类', desc: '开局随机挑 3 个分类' },
  { key: '__daily', name: '📅 每日主题', desc: '按日期生成' }
];
const limitMeta = [
  { key: 'singleColor', name: '只用一种颜色', desc: '' },
  { key: 'oneStroke', name: '一笔画完', desc: '' },
  { key: 'noEraser', name: '禁用橡皮', desc: '' }
];

const lobbyRoom = (over) => Object.assign({
  code: '1234', hostId: 'p1', state: 'lobby', round: 0, totalRounds: 3, duration: 80,
  themes: [], themesResolved: [], limits: {}, customCount: 0,
  pool: { total: 578, left: 578, used: 0, all: 578 },
  players: [{ id: 'p1', name: '阿甲', avatar: '🐼', score: 0, host: true, isDrawer: false }]
}, over || {});

/* ---- 1. 反应条已移出绘图工具栏 ---- */
T('反应表情条已移出 #tools（猜词的人也能互动）',
  !!$('react-bar') && !$('tools').contains($('react-bar')));
T('反应按钮已渲染', $('react-bar').children.length >= 6, $('react-bar').children.length + ' 个');

/* ---- 2. 大厅：主题 chips ---- */
handle({
  t: 'joined',
  me: { id: 'p1', name: '阿甲', avatar: '🐼', host: true },
  cats, themeMeta, limitMeta,
  wordBank: { total: 578, categories: 20, byDiff: { 1: 202, 2: 233, 3: 143 } },
  room: lobbyRoom()
});
const themeChips = window.document.querySelectorAll('#theme-chips .chip');
T('大厅渲染出 2 个快捷主题 + 4 个分类主题', themeChips.length === 6, themeChips.length + ' 个');
T('快捷主题排在最前且标记为 special',
  themeChips[0].classList.contains('special') && /随机/.test(themeChips[0].textContent),
  themeChips[0].textContent);
T('分类主题带词数', /动物53/.test(chip('动物').textContent), chip('动物').textContent);
T('未选主题时提示全库规模', /578/.test($('theme-note').textContent), $('theme-note').textContent);

chip('动物').click();
chip('食物').click();
handle({ t: 'state', room: lobbyRoom({ themes: ['动物', '食物'], themesResolved: ['动物', '食物'], pool: { total: 99, left: 99, used: 0, all: 578 } }) });
T('选中分类后按钮高亮', chip('动物').classList.contains('on') && chip('食物').classList.contains('on'));
T('选中主题后显示收窄后的词库', /99/.test($('theme-note').textContent), $('theme-note').textContent);

/* ---- 3. 快捷主题与普通分类互斥 ---- */
sent.length = 0;
chip('__random3').click();
const randomMsg = sent.find((m) => m.t === 'settings' && m.themes);
T('点快捷主题会上报 __random3', !!randomMsg && randomMsg.themes.join() === '__random3',
  randomMsg ? randomMsg.themes.join() : '无');
T('快捷主题与普通分类互斥', !!randomMsg && !randomMsg.themes.includes('动物'));
handle({ t: 'state', room: lobbyRoom({ themes: ['__random3'], themesResolved: ['交通', '家居', '童话'], pool: { total: 78, left: 78, used: 0, all: 578 } }) });
T('快捷主题解析后显示具体分类', /交通 \+ 家居 \+ 童话/.test($('theme-note').textContent),
  $('theme-note').textContent);
T('快捷主题按钮高亮、分类按钮熄灭',
  chip('__random3').classList.contains('on') && !chip('动物').classList.contains('on'));

/* ---- 4. 玩法限制开关 ---- */
T('限制开关渲染出 3 项', window.document.querySelectorAll('#limit-chips .chip').length === 3);
T('默认全部关闭', /全部关闭/.test($('limit-note').textContent), $('limit-note').textContent);
sent.length = 0;
lchip('oneStroke').click();
const limMsg = sent.find((m) => m.t === 'settings' && m.limits);
T('点限制开关会上报 limits', !!limMsg && limMsg.limits.oneStroke === true,
  limMsg ? JSON.stringify(limMsg.limits) : '无');
handle({ t: 'state', room: lobbyRoom({ limits: { oneStroke: true } }) });
T('限制开启后显示在标题上', /一笔画完/.test($('limit-note').textContent), $('limit-note').textContent);
T('一笔画完时禁用清空与橡皮', $('tool-clear').disabled && $('tool-eraser').disabled);

/* ---- 4.5 换词次数设置项 ---- */
T('换词档位渲染出 3 个按钮', window.document.querySelectorAll('#seg-reroll button').length === 3);
sent.length = 0;
window.document.querySelector('#seg-reroll button[data-v="5"]').click();
const rrMsg = sent.find((m) => m.t === 'settings' && m.reroll);
T('点换词档位会上报 reroll', !!rrMsg && rrMsg.reroll === 5, rrMsg ? String(rrMsg.reroll) : '无');
handle({ t: 'state', room: lobbyRoom({ reroll: 5 }) });
T('换词档位高亮跟随房间设置',
  window.document.querySelector('#seg-reroll button[data-v="5"]').classList.contains('on'));
T('默认档位是 3 次',
  window.document.querySelector('#seg-reroll button[data-v="3"]').textContent === '3 次');

/* ---- 5. 自定义词库导入 ---- */
sent.length = 0;
$('custom-words').value = '奶茶店, 开题答辩\n老王；图书馆三楼';
$('btn-custom-apply').click();
const cw = sent.find((m) => m.t === 'settings' && m.customWords);
T('自定义词按逗号/换行/分号正确切分', !!cw && cw.customWords.length === 4,
  cw ? cw.customWords.join(' / ') : '无');
handle({ t: 'state', room: lobbyRoom({ customCount: 4, pool: { total: 582, left: 582, used: 0, all: 578 } }) });
T('导入后显示自定义词数', /已导入 4 个词/.test($('custom-note').textContent), $('custom-note').textContent);
sent.length = 0;
$('btn-custom-clear').click();
T('清空按钮会清掉输入并上报空数组',
  $('custom-words').value === '' &&
  sent.some((m) => m.t === 'settings' && Array.isArray(m.customWords) && !m.customWords.length));

/* ---- 6. 对局中：连击角标 + 词池进度 ---- */
handle({
  t: 'state',
  room: lobbyRoom({
    state: 'playing', round: 2, totalRounds: 6, duration: 30, drawerId: 'p2',
    category: '食物', wordLen: 3, mask: '＿＿＿', endTime: 0,
    pool: { total: 578, left: 572, used: 6, all: 578 },
    players: [
      { id: 'p1', name: '阿甲', avatar: '🐼', score: 300, combo: 4, guessed: true, isDrawer: false, host: true },
      { id: 'p2', name: '阿乙', avatar: '🦊', score: 200, combo: 0, guessed: false, isDrawer: true, host: false }
    ]
  })
});
T('玩家列表显示连击角标', /🔥4/.test($('game-players').textContent), $('game-players').textContent.trim());
T('顶栏显示词池已出进度', /6\/578/.test($('round-info').textContent), $('round-info').textContent);

/* ---- 7. 开天眼提示 + 按钮状态机 ---- */
let hintErr = null;
try { handle({ t: 'hint', mask: '＿＿汤', category: '食物', byDrawer: '阿乙' }); } catch (e) { hintErr = e; }
T('开天眼提示消息不报错', !hintErr, hintErr ? hintErr.message : '');
T('提示内容标出是谁开的天眼', /开天眼/.test($('chat').textContent), $('chat').textContent.trim().slice(-30));
handle({ t: 'revealUsed', penalty: 15 });
T('开天眼按钮用后置灰并显示代价', $('tool-reveal').disabled && /-15/.test($('tool-reveal').textContent),
  $('tool-reveal').textContent);

/* ---- 7.6 报错提示不该跨页残留 ----
 * 回归：游戏里用「开天眼」到只剩一个字时服务端会回 error，
 * 旧代码无条件把每个 error 都写进 lobby-err 且切页不清，
 * 结果那行红字一直挂在大厅底部（用户截图发现）。 */
api.show('screen-game');
$('login-err').textContent = '';
$('lobby-err').textContent = '';
handle({ t: 'error', msg: '只剩一个字了，再揭示就没得猜啦' });
T('游戏页收到报错 → 不写进大厅错误栏', $('lobby-err').textContent === '',
  'lobby-err="' + $('lobby-err').textContent + '"');
T('游戏页收到报错 → 不写进登录错误栏', $('login-err').textContent === '',
  'login-err="' + $('login-err').textContent + '"');
T('游戏页收到报错 → 照常进聊天记录（用户看得到）',
  /只剩一个字了/.test($('chat').textContent), '聊天里有这行');

api.show('screen-lobby');
T('回到大厅 → 大厅错误栏是空的（修复前会残留游戏内的报错）',
  $('lobby-err').textContent === '', 'lobby-err="' + $('lobby-err').textContent + '"');

handle({ t: 'error', msg: '只有房主能改设置' });
T('大厅里收到报错 → 正常显示在大厅错误栏', /只有房主/.test($('lobby-err').textContent),
  'lobby-err="' + $('lobby-err').textContent + '"');

api.show('screen-game');
api.show('screen-lobby');
T('离开大厅再回来 → 上次的大厅报错被清掉（不留陈旧提示）',
  $('lobby-err').textContent === '', 'lobby-err="' + $('lobby-err').textContent + '"');

api.show('screen-login');
T('回到登录页 → 登录错误栏也是干净的', $('login-err').textContent === '',
  'login-err="' + $('login-err').textContent + '"');
api.show('screen-game');

/* ---- 7.7 换房间要清空聊天记录 ----
 * 回归：房间被回收 → 回登录页 → 进新房间，还能看到上一局的聊天。
 * 只判「房间号变了才清」不够：新房间若又分到同一个 4 位号就会串进来。 */
const saySomething = (text) => handle({ t: 'chat', kind: 'chat', name: '阿甲', avatar: '🐼', text, time: 1 });

$('chat').innerHTML = '';
saySomething('上一局说的话');
T('构造前提：聊天区里确实有上一局的消息', /上一局说的话/.test($('chat').textContent));

api.show('screen-login');
T('回到登录页（已不在任何房间）→ 聊天记录被清空', $('chat').children.length === 0,
  $('chat').children.length + ' 条');

api.show('screen-lobby');
saySomething('旧房间的消息');
handle({ t: 'joined', me: { id: 'p1', name: '阿甲', avatar: '🐼', host: true },
         room: lobbyRoom({ code: '5678' }) });
T('进入另一个房间号 → 聊天记录被清空', !/旧房间的消息/.test($('chat').textContent),
  $('chat').textContent.trim().slice(0, 24) || '(空)');

saySomething('重连前说的话');
handle({ t: 'joined', me: { id: 'p1', name: '阿甲', avatar: '🐼', host: true },
         room: lobbyRoom({ code: '5678' }) });
T('重连回同一房间 → 聊天记录保留（不白丢历史）',
  /重连前说的话/.test($('chat').textContent),
  /重连前说的话/.test($('chat').textContent) ? '保留' : '被误清');

/* ---- 7.5 「一笔画完」锁板 ---- */
T('初始未锁板', !$('board').classList.contains('locked') && !$('lock-tip').classList.contains('show'));
handle({ t: 'boardLock', locked: true });
T('锁板后画板标记为 locked', $('board').classList.contains('locked'));
T('锁板后浮出提示条', $('lock-tip').classList.contains('show'));
T('猜词者看到的是「画手的一笔已用完」', /画手的一笔已用完/.test($('lock-tip').textContent),
  $('lock-tip').textContent);
handle({ t: 'boardLock', locked: false });
T('解锁后提示条与锁标记一起消失',
  !$('lock-tip').classList.contains('show') && !$('board').classList.contains('locked'));

/* 画手视角：文案不同，且房间状态里的 boardLocked 能同步过来 */
handle({
  t: 'turnStart', drawerId: 'p1', drawerName: '阿甲', drawerAvatar: '🐼',
  category: '物品', wordLen: 2, mask: '＿＿', duration: 30, endTime: 0,
  room: lobbyRoom({
    state: 'playing', drawerId: 'p1', boardLocked: true, limits: { oneStroke: true },
    players: [
      { id: 'p1', name: '阿甲', avatar: '🐼', score: 0, guessed: false, isDrawer: true, host: true },
      { id: 'p2', name: '阿乙', avatar: '🦊', score: 0, guessed: false, isDrawer: false, host: false }
    ]
  })
});
T('画手视角文案是「你的一笔已用完」', /你的一笔已用完/.test($('lock-tip').textContent),
  $('lock-tip').textContent);
T('turnStart 携带的 boardLocked 会被应用', $('board').classList.contains('locked'));

/* ---- 8. 画作投票 ---- */
handle({
  t: 'turnEnd', reason: 'allGuessed', word: '麻辣烫', drawerId: 'p2', drawerName: '阿乙',
  drawerGain: 95, allGuessed: true, strokes: [], voting: true, voteWindow: 3900,
  room: lobbyRoom({
    state: 'turnEnd', drawerId: 'p2',
    players: [
      { id: 'p1', name: '阿甲', avatar: '🐼', score: 300, guessed: true, isDrawer: false, host: true },
      { id: 'p2', name: '阿乙', avatar: '🦊', score: 295, guessed: false, isDrawer: true, host: false }
    ]
  })
});
T('非画手回合末看到投票区', $('vote-box').classList.contains('show'));
T('渲染出 5 颗星', stars().length === 5);
T('投票文案提示了画作分规则', /8 分/.test($('vote-sub').textContent), $('vote-sub').textContent);
sent.length = 0;
stars()[3].click();
const voteMsg = sent.find((m) => m.t === 'vote');
T('点第 4 颗星上报 4 星', !!voteMsg && voteMsg.stars === 4, voteMsg ? voteMsg.stars + ' 星' : '无');

handle({ t: 'voted', stars: 4, count: 1 });
T('投票后锁定并回显', /你打了 4 星/.test($('vote-title').textContent), $('vote-title').textContent);
T('投票后星星不可再点', stars().every((b) => b.disabled));

handle({ t: 'voteResult', word: '麻辣烫', count: 2, avg: 4.5, drawerName: '阿乙', bonus: 36, stars: [4, 5] });
T('评分结果回显均分与画作分', /4\.5 星/.test($('vote-title').textContent) && /\+36/.test($('vote-sub').textContent),
  $('vote-title').textContent + ' / ' + $('vote-sub').textContent);

handle({
  t: 'turnEnd', reason: 'timeout', word: '奶茶', drawerId: 'p1', drawerName: '阿甲',
  drawerGain: 0, allGuessed: false, strokes: [], voting: true, voteWindow: 3900,
  room: lobbyRoom({
    state: 'turnEnd', drawerId: 'p1',
    players: [{ id: 'p1', name: '阿甲', avatar: '🐼', score: 300, guessed: false, isDrawer: true, host: true }]
  })
});
T('画手本人看不到投票区（不能给自己打分）', !$('vote-box').classList.contains('show'));

/* ---- 9. 结算页：称号 + 词库统计 + 最佳画作 ---- */
handle({
  t: 'gameEnd',
  ranking: [
    { rank: 1, id: 'p1', name: '阿甲', avatar: '🐼', score: 980, titles: ['🎨 神笔马良', '⚡ 神速首猜'] },
    { rank: 2, id: 'p2', name: '阿乙', avatar: '🦊', score: 760, titles: ['⭐ 全场最佳画作'] }
  ],
  wordStats: { played: 18, unique: 18, repeat: 0, poolUsed: 18, poolTotal: 578, recycled: 0, allTotal: 578 },
  bestDrawing: { word: '麻辣烫', avg: 4.5, count: 2, drawerName: '阿乙' },
  room: lobbyRoom({
    state: 'gameEnd', round: 6, totalRounds: 6, drawerId: null,
    players: [
      { id: 'p1', name: '阿甲', avatar: '🐼', score: 980, combo: 0, isDrawer: false, host: true },
      { id: 'p2', name: '阿乙', avatar: '🦊', score: 760, combo: 0, isDrawer: false, host: false }
    ]
  })
});
T('结算页渲染称号', /神笔马良/.test($('final-ranks').textContent) && /全场最佳画作/.test($('final-ranks').textContent),
  $('final-ranks').textContent.replace(/\s+/g, ' ').trim());
T('结算页显示零重复结论', /零重复/.test($('final-stats').textContent), $('final-stats').textContent.replace(/<[^>]+>/g, ' '));
T('结算页显示词库规模', /578/.test($('final-stats').textContent));
T('结算页评出全场最佳画作', /最佳画作/.test($('final-stats').textContent) && /麻辣烫/.test($('final-stats').textContent));
T('结算弹层已显示', $('ov-final').classList.contains('show'));

/* ---- 10. 新回合重置 ---- */
handle({ t: 'choosing', drawerId: 'p1', drawerName: '阿甲', drawerAvatar: '🐼', room: { state: 'choosing', players: [], hostId: 'p1' } });
T('新回合开天眼按钮重置', !$('tool-reveal').disabled, $('tool-reveal').textContent);
T('新回合画板锁重置', !$('board').classList.contains('locked') && !$('lock-tip').classList.contains('show'));
T('新回合投票区隐藏', !$('vote-box').classList.contains('show'));

/* ---- 11. 分享地址可复制（登录页） ---- */
const copied = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  T('分享地址带协议头，方便朋友直接粘贴', $('tip-url').textContent === 'http://localhost:3000',
    $('tip-url').textContent);
  T('分享地址旁有独立的复制按钮', !!$('btn-copy-url') && $('btn-copy-url').textContent === '复制');
  T('房间号与分享地址都可手动选中（body 上是 user-select:none）',
    /\.share-url\s*\{[^}]*user-select:\s*text/.test(cssText) &&
    /\.room-code\s*\{[^}]*user-select:\s*text/.test(cssText));

  /* 优先走 navigator.clipboard（https / localhost 安全上下文） */
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: (t) => { copied.push(t); return Promise.resolve(); } }
  });
  copied.length = 0;
  $('btn-copy-url').click();
  await sleep(30);
  T('点复制按钮 → 走 clipboard API 且内容正确',
    copied.length === 1 && copied[0] === 'http://localhost:3000', copied.join(' | '));
  T('复制成功后按钮给出反馈', /已复制/.test($('btn-copy-url').textContent), $('btn-copy-url').textContent);

  copied.length = 0;
  $('tip-url').click();
  await sleep(30);
  T('点地址本身也能复制', copied.length === 1 && copied[0] === 'http://localhost:3000');

  /* 非安全上下文（局域网 http://172.x.x.x:3000）应回退到 execCommand */
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
  let execUsed = 0;
  window.document.execCommand = (cmd) => { execUsed++; return cmd === 'copy'; };
  $('btn-copy-url').click();
  await sleep(30);
  T('局域网 http 场景自动回退到 execCommand 兜底', execUsed === 1, 'execCommand 调用 ' + execUsed + ' 次');
  T('兜底路径同样给出已复制反馈', /已复制/.test($('btn-copy-url').textContent), $('btn-copy-url').textContent);

  /* 房间号复制也走同一套逻辑 */
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  handle({
    t: 'joined',
    me: { id: 'p1', name: '阿甲', avatar: '🐼', host: true },
    cats, themeMeta, limitMeta,
    wordBank: { total: 578, categories: 20, byDiff: { 1: 202, 2: 233, 3: 143 } },
    room: lobbyRoom({ code: '8642' })
  });
  copied.length = 0;
  $('btn-copy').click();
  await sleep(30);
  T('房间号复制复用同一套逻辑', copied.length === 1 && copied[0] === '8642', copied.join(' | '));

  /* ---- 12. 盲画模式 ---- */
(function () {
  const S = api.S;
  const mk = (ageMs) => ({ sid: 1, pts: [0, 0, 0.5, 0.5], w: 0.01, color: '#000', mode: 'pen', bornAt: Date.now() - ageMs });
  const playing = () => { S.room = { state: 'playing' }; };

  playing();
  S.isDrawer = false; S.blindDraw = true;
  T('盲画模式：猜词者不受影响，笔迹正常可见', api.strokeVisible(mk(0)) === true);

  S.isDrawer = true;
  T('盲画模式：画手看不到刚画的笔迹', api.strokeVisible(mk(0)) === false);
  T('盲画模式：画手看不到正在画的那一笔（盲画状态生效）', api.blindActive() === true);
  T('盲画模式：3 秒前的笔迹会显形', api.strokeVisible(mk(3500)) === true);
  T('盲画模式：服务端下发的历史笔迹直接可见',
    api.strokeVisible({ sid: 9, pts: [0, 0, 1, 1], w: 0.01, mode: 'pen' }) === true);

  S.blindDraw = false;
  T('关掉盲画后画手恢复可见', api.strokeVisible(mk(0)) === true && api.blindActive() === false);

  /* 角标显示逻辑 */
  S.blindDraw = true; S.isDrawer = true; S.room = { state: 'playing' };
  api.handle({
    t: 'turnStart', drawerId: 'p1', drawerName: '阿甲', drawerAvatar: '🐼',
    category: '物品', wordLen: 2, mask: '＿＿', duration: 30, endTime: 0,
    room: lobbyRoom({
      state: 'playing', drawerId: 'p1', limits: { blindDraw: true },
      players: [
        { id: 'p1', name: '阿甲', avatar: '🐼', score: 0, guessed: false, isDrawer: true, host: true },
        { id: 'p2', name: '阿乙', avatar: '🦊', score: 0, guessed: false, isDrawer: false, host: false }
      ]
    })
  });
  T('盲画模式：画手看到提示角标', $('blind-badge').classList.contains('show'),
    $('blind-badge').textContent);
  T('角标文案说明了延迟秒数', /3 秒/.test($('blind-badge').textContent), $('blind-badge').textContent);

  S.isDrawer = false;
  api.handle({
    t: 'turnStart', drawerId: 'p2', drawerName: '阿乙', drawerAvatar: '🦊',
    category: '物品', wordLen: 2, mask: '＿＿', duration: 30, endTime: 0,
    room: lobbyRoom({
      state: 'playing', drawerId: 'p2', limits: { blindDraw: true },
      players: [
        { id: 'p1', name: '阿甲', avatar: '🐼', score: 0, guessed: false, isDrawer: false, host: true },
        { id: 'p2', name: '阿乙', avatar: '🦊', score: 0, guessed: false, isDrawer: true, host: false }
      ]
    })
  });
  T('盲画模式：猜词者不显示角标', !$('blind-badge').classList.contains('show'));
})();

/* ---- 13. 延迟显示 + 远端笔画抗抖动 ---- */
(function () {
  const S = api.S;

  // pong → 延迟读数（滑动平均）
  S.pingMs = 0;
  const t0 = Date.now() - 360;
  api.handle({ t: 'pong', ts: t0, server: Date.now() });
  T('pong 会算出往返延迟并显示', S.pingMs > 300 && S.pingMs < 420 && /ms/.test($('ping').textContent),
    '读数 ' + $('ping').textContent);
  T('高延迟标红（公网偏高）', $('ping').className.indexOf('bad') >= 0, $('ping').className);
  S.pingMs = 0;
  api.handle({ t: 'pong', ts: Date.now() - 20, server: Date.now() });
  T('低延迟标绿（局域网级）', $('ping').className.indexOf('good') >= 0, $('ping').className);

  // 远端笔画渐进显形：一次收到一大批点，不应该瞬间全画出来
  S.strokes = [];
  S.strokeMap.clear();
  api.handle({ t: 'draw', op: 'begin', sid: 77, color: '#ef4444', w: 0.01, mode: 'pen', x: 0.1, y: 0.1 });
  const big = [];
  for (let i = 0; i < 120; i++) big.push(0.1 + i * 0.005, 0.1 + i * 0.003);
  api.handle({ t: 'draw', op: 'pts', sid: 77, pts: big });
  const st = S.strokeMap.get(77);
  T('收到整批点后，已显形点数远小于总点数（没有瞬移）',
    st.revealed !== undefined && st.revealed < 40, 'revealed=' + st.revealed + ' / total=' + (st.pts.length / 2));
  T('远端笔画不被标记为本地（会走平滑）', !st.local);

  // 自己画的笔迹标记为 local，不参与平滑（本地回显必须即时）
  S.strokes = [
    { sid: 88, pts: [0, 0, 1, 1, 2, 2], w: 0.01, mode: 'pen', local: true },      // 本地
    { sid: 89, pts: [0, 0, 1, 1, 2, 2], w: 0.01, mode: 'pen', revealed: 1 }      // 远端
  ];
  const before = S.strokes[0].revealed;
  api.advanceReveal();
  T('本地笔迹不参与平滑（revealed 保持原样）', S.strokes[0].revealed === before,
    'local.revealed=' + S.strokes[0].revealed);
  T('远端笔迹的 revealed 会向前推进', S.strokes[1].revealed > 1,
    'remote.revealed=' + S.strokes[1].revealed.toFixed(2));
  // 落后极多时应当全速追平，不会越拖越远
  S.strokes = [{ sid: 90, pts: new Array(1200).fill(0.5), w: 0.01, mode: 'pen', revealed: 1 }];
  api.advanceReveal();
  T('落后过多时直接追平（防止延迟越积越大）', S.strokes[0].revealed === 600,
    'revealed=' + S.strokes[0].revealed);

  /* ---- 外推预测：只在活跃接收 + 已追平时才猜，且长度有上限 ---- */
  const mkStroke = (over) => Object.assign({
    sid: 91, w: 0.01, mode: 'pen', color: '#ef4444',
    pts: [0.10, 0.10, 0.20, 0.10, 0.30, 0.10],   // 水平向右移动
    revealed: 3, lastAt: Date.now()
  }, over || {});

  const tail = api.predictTail(mkStroke());
  T('活跃接收且已追平时会外推', Array.isArray(tail) && tail.length === 2,
    tail ? '预测点 x=' + tail[0].toFixed(3) + ' y=' + tail[1].toFixed(3) : 'null');
  T('外推方向沿最近线段继续（向右）', tail && tail[0] > 0.30 && Math.abs(tail[1] - 0.10) < 0.001);
  T('外推长度不超过上限', tail && (tail[0] - 0.30) <= 0.035 + 1e-6,
    '外推长度 ' + (tail ? (tail[0] - 0.30).toFixed(4) : '-'));

  T('停笔超过 320ms 后不再外推',
    api.predictTail(mkStroke({ lastAt: Date.now() - 600 })) === null);
  T('还没追平真实数据时不外推',
    api.predictTail(mkStroke({ revealed: 1 })) === null);
  T('几乎没移动的笔迹不猜（避免抖动乱甩）',
    api.predictTail(mkStroke({ pts: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1] })) === null);
  T('本地笔迹不参与外推（自己画的不需要猜）',
    api.predictTail(mkStroke({ local: true })) === null);
  T('点数太少时不猜', api.predictTail(mkStroke({ pts: [0.1, 0.1, 0.2, 0.2] })) === null);

  /* ---- 平滑速率随延迟自适应 ---- */
  S.pingMs = 10;                     // 局域网
  S.strokes = [{ sid: 92, pts: new Array(60).fill(0.5), w: 0.01, mode: 'pen', revealed: 1 }];
  api.advanceReveal();
  const lowRttStep = S.strokes[0].revealed;
  S.pingMs = 350;                    // 公网隧道
  S.strokes = [{ sid: 93, pts: new Array(60).fill(0.5), w: 0.01, mode: 'pen', revealed: 1 }];
  api.advanceReveal();
  const highRttStep = S.strokes[0].revealed;
  T('局域网追得更快（少引入额外延迟）', lowRttStep > highRttStep,
    '低延迟 ' + lowRttStep.toFixed(2) + ' vs 高延迟 ' + highRttStep.toFixed(2));
})();

/* ---- 14. 画布底色（画白色物体用） ---- */
(function () {
  const S = api.S;
  const cv = $('board');

  T('画布底色默认是白色', S.bg === '#ffffff' && cv.style.background === 'rgb(255, 255, 255)' ||
    S.bg === '#ffffff', 'S.bg=' + S.bg);

  api.setCanvasBg('#2b2f38');
  T('换成深色底后 canvas 样式跟着变', S.bg === '#2b2f38' &&
    (cv.style.background === '#2b2f38' || cv.style.background === 'rgb(43, 47, 56)'),
    'style.background=' + cv.style.background);
  T('深色底对应的选择器被选中',
    (function () {
      const on = $('bgs').querySelector('.bg-dot.on');
      return !!on && on.dataset.bg === '#2b2f38';
    })());

  api.setCanvasBg('#e9eef4');
  T('浅灰底也能切', S.bg === '#e9eef4', 'S.bg=' + S.bg);

  api.setCanvasBg('#ff00ff');
  T('非法底色被拒绝，回落白色', S.bg === '#ffffff', 'S.bg=' + S.bg);

  // 收到服务端下发的底色要同步
  api.handle({ t: 'draw', op: 'bg', bg: '#2b2f38' });
  T('收到 op:bg 会同步底色（画手改了，猜词者也跟着变）', S.bg === '#2b2f38', 'S.bg=' + S.bg);

  // 迟到者收到 fill 时底色也要带上
  api.handle({ t: 'draw', op: 'fill', strokes: [], bg: '#e9eef4' });
  T('迟到者收到 fill 时会同步底色', S.bg === '#e9eef4', 'S.bg=' + S.bg);

  api.setCanvasBg('#ffffff');
})();

/* ---- 15. 限制开关连点不再"关不掉" ---- */
(function () {
  const S = api.S;
  const box = $('limit-chips');
  if (!box || !box.children.length) {
    T('限制开关已渲染', false, 'limit-chips 是空的，无法测连点');
    return;
  }
  const chip = box.querySelector('[data-limit="oneStroke"]');
  if (!chip) { T('找到「一笔画完」开关', false); return; }

  chip.classList.remove('on');
  chip.click();                                  // 第一下：开
  const afterFirst = chip.classList.contains('on');
  chip.click();                                  // 第二下：立刻关（不等服务端回包）
  const afterSecond = chip.classList.contains('on');

  T('连点两下：第一下变开', afterFirst === true);
  T('连点两下：第二下能关掉（修复前会卡在开）', afterSecond === false,
    '第二下之后 on=' + afterSecond);
})();

window.close();
  console.log('\n' + (fails === 0 ? '全部通过 ✅' : fails + ' 项失败 ❌') + '\n');
  process.exit(fails === 0 ? 0 : 1);
})();
