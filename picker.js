'use strict';
/**
 * 你画我猜 · 选词引擎（v2）
 * --------------------------------------------------------------
 * 解决的问题：老版本每次从全库均匀随机抽 3 个词，重复率很高——
 *            2 人局 6 轮就要抽 12 个词，148 词库里撞车概率肉眼可见。
 *
 * 三层防重复：
 *   ① 房间级「已用词」硬排除 —— 本局出现过的词直接不进候选池；
 *   ② 跨房间「全局软冷却」    —— 最近 RECENT_MAX 个词权重降到 0.15，
 *      避免同一批人开新局又撞上刚画过的词；
 *   ③ 换一批 / 换题排除已展示候选 —— 不会「换了个寂寞」。
 *
 * 再叠加两个体验优化：
 *   · 难度配比：3 个候选尽量覆盖 易/中/难，避免三个都是「成语」；
 *   · 分类去重：优先来自不同分类，同一批候选里不出现同类词。
 *
 * 池子被刷空后不是简单重置，而是只保留最近 1/4 作为冷却、其余回收重洗，
 * 这样长局（几十回合）也不会突然回到「什么都可能重复」的状态。
 */

const RECENT_MAX = 80;          // 全局软冷却窗口大小
const COOLDOWN_WEIGHT = 0.15;   // 命中冷却窗口时的抽中权重
const BAG_REFILL_AT = 6;        // 剩余候选少于该值时触发重洗

let WORDS = [];
const recentGlobal = [];        // 最近出现过的词（尾部最新）

/** 注入词库（server.js 与测试脚本共用同一份） */
function init(words) {
  WORDS = Array.isArray(words) ? words : [];
  recentGlobal.length = 0;
}

function touchRecent(word) {
  const i = recentGlobal.indexOf(word);
  if (i >= 0) recentGlobal.splice(i, 1);
  recentGlobal.push(word);
  if (recentGlobal.length > RECENT_MAX) recentGlobal.shift();
}

/** 只读快照，供测试/调试查看冷却队列 */
const recentList = () => recentGlobal.slice();

/** 当前房间允许的词库范围
 *  优先级：主题筛选（effectiveThemes，由 server 解析，含「随机 3 类 / 每日主题」）
 *         → 再并上房主导入的自定义词（room.customPool）
 */
function poolFor(room) {
  let base = WORDS;
  const themes = room.effectiveThemes || (room.settings && room.settings.themes);
  if (themes && themes.length) {
    const set = new Set(themes);
    const sub = WORDS.filter((w) => set.has(w[1]));
    if (sub.length >= 12) base = sub;
  }
  const custom = room.customPool;
  if (custom && custom.length) {
    const have = new Set(base.map((w) => w[0]));
    return base.concat(custom.filter((w) => !have.has(w[0])));
  }
  return base;
}

/**
 * 构建/刷新候选池：排除本局已用词；池子见底时保留最近 1/4 作为冷却后重洗
 *
 * 触发重洗有两种情形：
 *   a) 剩余候选总数见底；
 *   b) 某一难度在词库里明明还有词，却已经被抽光（例如「困难」词只有 143 个，
 *      会先于简单/中等耗尽，若不重洗，后面几回合的候选就退化成「简单+中等」）。
 * @param {object} room
 * @param {function} [onRefill] 重洗回调 (room, { used, kept }) => void
 */
function ensureBag(room, onRefill) {
  const all = poolFor(room);
  const used = room.usedWords || (room.usedWords = []);
  const usedSet = new Set(used);
  let fresh = all.filter((w) => !usedSet.has(w[0]));

  const tierAll = { 1: 0, 2: 0, 3: 0 };
  for (const w of all) tierAll[w[2]]++;
  const tierFresh = { 1: 0, 2: 0, 3: 0 };
  for (const w of fresh) tierFresh[w[2]]++;
  const tierStarved = [1, 2, 3].some((d) => tierAll[d] >= 6 && tierFresh[d] < 3);

  if (fresh.length < BAG_REFILL_AT || (used.length >= 12 && tierStarved)) {
    const keepN = Math.max(3, Math.floor(used.length * 0.25));
    const keep = used.slice(-keepN);
    const keepSet = new Set(keep);
    room.usedWords = keep;
    room.recycledCount = (room.recycledCount || 0) + 1;
    fresh = all.filter((w) => !keepSet.has(w[0]));
    if (onRefill) onRefill(room, { used: used.length, kept: keep.length });
  }
  room.bag = fresh;
  return fresh;
}

/** 加权随机抽 1 个：优先不同分类，命中全局冷却的词降权 */
function weightedPick(list, usedCats) {
  if (!list.length) return null;
  const avail = list.filter((w) => !usedCats.has(w[1]));
  const src = avail.length ? avail : list;
  const weights = src.map((w) => (recentGlobal.indexOf(w[0]) >= 0 ? COOLDOWN_WEIGHT : 1));
  let sum = 0;
  for (const v of weights) sum += v;
  let r = Math.random() * sum;
  for (let i = 0; i < src.length; i++) {
    r -= weights[i];
    if (r <= 0) { usedCats.add(src[i][1]); return src[i]; }
  }
  const last = src[src.length - 1];
  usedCats.add(last[1]);
  return last;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 挑 n 个候选词
 * @param {object} room      房间对象（提供已用词 / 主题）
 * @param {number} n         候选数量
 * @param {string[]} exclude 额外排除（例如本回合已展示过的候选）
 * @param {function} [onRefill]
 */
function pickWords(room, n, exclude, onRefill) {
  const ex = new Set(exclude || []);
  let bag = ensureBag(room, onRefill).filter((w) => !ex.has(w[0]));
  if (bag.length < n) bag = ensureBag(room, onRefill);   // 排除后不够就放宽，保证出满 n 个

  const byD = { 1: [], 2: [], 3: [] };
  for (const w of bag) byD[w[2]].push(w);

  const out = [];
  const usedCats = new Set();

  // 第一步：难度各取一个（顺序随机），让候选有梯度
  for (const d of shuffle([1, 2, 3])) {
    if (out.length >= n) break;
    const w = weightedPick(byD[d], usedCats);
    if (w) out.push(w);
  }
  // 第二步：不够就从剩余池里补齐
  let guard = 0;
  while (out.length < n && guard++ < 40) {
    const chosen = new Set(out.map((w) => w[0]));
    const rest = bag.filter((w) => !chosen.has(w[0]));
    const w = weightedPick(rest, usedCats);
    if (!w) break;
    out.push(w);
  }
  return out;
}

/** 词真正被采用后调用：写入本局已用词 + 全局冷却队列 */
function markUsed(room, word) {
  if (!word) return;
  room.usedWords = room.usedWords || [];
  if (room.usedWords.indexOf(word) < 0) room.usedWords.push(word);
  if (room.bag) room.bag = room.bag.filter((w) => w[0] !== word);
  touchRecent(word);
}

/** 词池概况（大厅展示用） */
function poolStats(room) {
  const all = poolFor(room);
  const used = new Set(room.usedWords || []);
  let left = 0;
  for (const w of all) if (!used.has(w[0])) left++;
  return {
    total: all.length,
    left,
    used: used.size,
    all: WORDS.length,
    custom: (room.customPool || []).length,
    themes: room.effectiveThemes || (room.settings && room.settings.themes) || []
  };
}

module.exports = {
  init, pickWords, markUsed, poolStats, poolFor, touchRecent, recentList,
  RECENT_MAX, COOLDOWN_WEIGHT, BAG_REFILL_AT
};
