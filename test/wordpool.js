'use strict';
/**
 * 选词引擎压测：三种方案对比重复率
 *   A 老词库(148) + 老算法  —— 用户实际体验到的「重复率过高」
 *   B 新词库(578) + 老算法  —— 只扩词库、不改逻辑的效果
 *   C 新词库(578) + v2 引擎 —— 本次交付方案
 * 运行：node test/wordpool.js
 */
const { WORDS, WORD_STATS } = require('../words');
const picker = require('../picker');
picker.init(WORDS);

/** 改造前的原始词库（148 词），用于还原「优化前」的真实基线 */
const LEGACY_WORDS = [
  '熊猫', '大象', '企鹅', '蝴蝶', '螃蟹', '蜗牛', '刺猬', '河马', '金鱼', '兔子',
  '长颈鹿', '变色龙', '猫头鹰', '海豚', '孔雀', '袋鼠', '章鱼', '骆驼', '松鼠', '斑马',
  '水母', '树懒', '犀牛', '考拉', '蜻蜓', '蝙蝠', '海星', '蜥蜴',
  '西瓜', '汉堡', '冰淇淋', '披萨', '蛋糕', '面条', '棒棒糖', '寿司', '煎蛋', '爆米花',
  '火锅', '珍珠奶茶', '三明治', '烤鸭', '糖葫芦', '泡面', '饺子', '月饼',
  '麻辣烫', '章鱼小丸子', '生日蛋糕', '满汉全席',
  '雨伞', '眼镜', '牙刷', '闹钟', '气球', '钥匙', '风筝', '吉他', '灯泡', '梯子',
  '扫把', '剪刀', '望远镜', '灭火器', '洗衣机', '显微镜', '缝纫机', '打印机', '电风扇',
  '计算器', '照相机', '旋转木马', '留声机', '打字机', '天平', '指南针',
  '跳绳', '游泳', '钓鱼', '拍照', '刷牙', '睡觉', '跑步', '吃饭', '打喷嚏', '滑冰',
  '化妆', '理发', '爬山', '打篮球', '骑自行车', '放风筝', '打太极拳', '走钢丝', '跳芭蕾',
  '翻跟头', '吹口哨',
  '太阳', '月亮', '彩虹', '雪人', '星星', '云朵', '火山', '龙卷风', '瀑布', '沙漠',
  '流星', '极光', '闪电', '冰山', '海市蜃楼', '日全食', '钟乳石', '沙尘暴',
  '医生', '厨师', '警察', '老师', '歌手', '农民', '宇航员', '魔术师', '消防员', '超人',
  '圣诞老人', '美人鱼', '木乃伊', '兵马俑', '自由女神像', '蒙娜丽莎', '机器人',
  '一箭双雕', '画蛇添足', '井底之蛙', '对牛弹琴', '守株待兔', '亡羊补牢', '火上浇油',
  '雪中送炭', '刻舟求剑', '自相矛盾', '愚公移山', '狐假虎威', '掩耳盗铃', '叶公好龙',
  '望梅止渴', '破釜沉舟'
];

const GAMES = 2000;
let fails = 0;
function T(name, ok, extra) {
  console.log((ok ? '  \u2713 ' : '  \u2717 ') + name + (extra ? '   -> ' + extra : ''));
  if (!ok) fails++;
}
const rnd = (n) => Math.floor(Math.random() * n);
const pct = (v) => (v * 100).toFixed(1) + '%';

/** 老算法：每次从指定词库均匀随机挑 3 个候选，再随机选一个（无任何记忆） */
function legacyGame(turns, bank) {
  const picked = [];
  for (let t = 0; t < turns; t++) {
    const idx = new Set();
    while (idx.size < 3) idx.add(rnd(bank.length));
    const cands = [...idx].map((i) => bank[i]);
    picked.push(cands[rnd(cands.length)]);
  }
  return picked;
}

/** v2：走真实 picker（含房间已用词、全局冷却、难度配比、分类去重） */
function v2Game(turns, themes) {
  const room = { settings: { themes: themes || [] }, usedWords: [], bag: null };
  const picked = [];
  for (let t = 0; t < turns; t++) {
    const choice = picker.pickWords(room, 3, [], null);
    const chosen = choice[rnd(choice.length)][0];
    picker.markUsed(room, chosen);
    picked.push(chosen);
  }
  return picked;
}

function run(gen, turns) {
  let repeatTotal = 0, gamesWithRepeat = 0, sumRate = 0;
  for (let g = 0; g < GAMES; g++) {
    const list = gen(turns);
    const uniq = new Set(list).size;
    const rep = list.length - uniq;
    repeatTotal += rep;
    sumRate += rep / list.length;
    if (rep > 0) gamesWithRepeat++;
  }
  return {
    turns,
    avgRepeat: repeatTotal / GAMES,
    avgRate: sumRate / GAMES,
    pRepeat: gamesWithRepeat / GAMES
  };
}

console.log('\n=== 选词引擎压测（每档 ' + GAMES + ' 局；一局 turns 回合 = turns 个词）===');
console.log('词库：' + WORD_STATS.total + ' 词 / ' + WORD_STATS.categories + ' 分类\n');
console.log('  回合   A 老库148+老算法        B 新库578+老算法        C 新库578+v2引擎');
console.log('        平均重复率  有重复的局    平均重复率  有重复的局    平均重复率  有重复的局');
for (const turns of [6, 12, 24, 60]) {
  const a = run((t) => legacyGame(t, LEGACY_WORDS), turns);
  const b = run((t) => legacyGame(t, WORDS.map((w) => w[0])), turns);
  const c = run((t) => v2Game(t), turns);
  const cell = (s) => pct(s.avgRate).padStart(8) + '   ' + pct(s.pRepeat).padStart(8) + '  ';
  console.log('  ' + String(turns).padStart(3) + '   ' + cell(a) + '   ' + cell(b) + '   ' + cell(c));
}

console.log('');

/* ---------------- 断言 ---------------- */
const A12 = run((t) => legacyGame(t, LEGACY_WORDS), 12);
const B12 = run((t) => legacyGame(t, WORDS.map((w) => w[0])), 12);
const C12 = run((t) => v2Game(t), 12);
const C24 = run((t) => v2Game(t), 24);
const C60 = run((t) => v2Game(t), 60);

T('优化前确实存在明显重复（还原用户反馈的场景）', A12.pRepeat > 0.3,
  '12 回合：' + pct(A12.pRepeat) + ' 的局出现重复，平均重复率 ' + pct(A12.avgRate));
T('只扩词库不改逻辑也能改善，但仍会重复', B12.pRepeat > 0.02,
  '12 回合：' + pct(B12.pRepeat) + ' 的局出现重复');
T('v2 在 12 回合内零重复（2000 局）', C12.avgRepeat === 0 && C12.pRepeat === 0,
  '重复率 ' + pct(C12.avgRate));
T('v2 在 24 回合内零重复（4 人 6 轮）', C24.avgRepeat === 0, '重复率 ' + pct(C24.avgRate));
T('v2 长局 60 回合重复率 < 1%', C60.avgRate < 0.01, '重复率 ' + pct(C60.avgRate));
T('v2 相比优化前降低一个数量级以上', C12.avgRate * 10 < A12.avgRate,
  pct(A12.avgRate) + ' → ' + pct(C12.avgRate));

/* ---------------- 候选质量 ---------------- */
const room = { settings: { themes: [] }, usedWords: [], bag: null };
let diffSpread = 0, catSpread = 0, N = 3000;
for (let i = 0; i < N; i++) {
  const c = picker.pickWords(room, 3, [], null);
  if (new Set(c.map((w) => w[2])).size === 3) diffSpread++;
  if (new Set(c.map((w) => w[1])).size === 3) catSpread++;
  c.forEach((w) => picker.markUsed(room, w[0]));
}
T('候选词始终覆盖易/中/难三档', diffSpread / N > 0.99, pct(diffSpread / N));
T('候选词始终来自三个不同分类', catSpread / N > 0.99, pct(catSpread / N));

/* ---------------- 主题限定 ---------------- */
const themeRoom = { settings: { themes: ['动物', '食物'] }, usedWords: [], bag: null };
let bad = 0;
for (let i = 0; i < 300; i++) {
  const c = picker.pickWords(themeRoom, 3, [], null);
  c.forEach((w) => { if (!['动物', '食物'].includes(w[1])) bad++; picker.markUsed(themeRoom, w[0]); });
}
T('限定主题后只出该主题的词', bad === 0, '越界 ' + bad + ' 次');
T('限定主题后池子耗尽自动重洗且不崩', themeRoom.recycledCount > 0 && themeRoom.usedWords.length > 0,
  '重洗 ' + themeRoom.recycledCount + ' 次');

/* ---------------- 换一批 ---------------- */
const rrRoom = { settings: { themes: [] }, usedWords: [], bag: null };
let overlap = 0;
for (let i = 0; i < 1000; i++) {
  const a = picker.pickWords(rrRoom, 3, [], null).map((w) => w[0]);
  const b = picker.pickWords(rrRoom, 3, a, null).map((w) => w[0]);
  if (b.some((w) => a.includes(w))) overlap++;
}
T('「换一批」不会重复上一批的候选词', overlap === 0, '重叠 ' + overlap + ' 次 / 1000');

/* ---------------- 全局软冷却 ---------------- */
picker.init(WORDS);
const g1 = { settings: { themes: [] }, usedWords: [], bag: null };
for (let i = 0; i < 40; i++) { const c = picker.pickWords(g1, 3, [], null); picker.markUsed(g1, c[0][0]); }
T('全局冷却队列记录最近出现过的词', picker.recentList().length === 40, picker.recentList().length + ' 词');

console.log('\n' + (fails === 0 ? '全部通过 ✅' : fails + ' 项失败 ❌') + '\n');
process.exit(fails === 0 ? 0 : 1);
