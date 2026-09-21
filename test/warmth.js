'use strict';
/**
 * 猜词温度 回归测试
 * --------------------------------------------------------------
 * 覆盖：四层判断（很近 / 方向对 / 沾边）、额度递减与耗尽降级、
 *       原有 close 消息向后兼容、私有提示不广播、猜错仍进聊天、新回合额度重置。
 *
 * 线条平滑是客户端发送管线的滤波，跑在浏览器里，这里测不到 ——
 * 它由 test/responsive.js 的真浏览器路径覆盖（见报告说明）。
 *
 * 运行：node test/warmth.js     （或直接 node test/run-all.js）
 */
const path = require('path');
const { Client, sleep } = require('./client');
const { WORDS } = require(path.join(__dirname, '..', 'words'));

const PORT = Number(process.env.PORT) || 3299;

let fails = 0;
function T(name, ok, extra) {
  console.log((ok ? '  \u2713 ' : '  \u2717 ') + name + (extra ? '   -> ' + extra : ''));
  if (!ok) fails++;
}
async function waitOrNull(c, type, ms) {
  try { return await c.wait(type, ms); } catch (e) { return null; }
}

/** 和服务端 server.js 里的 minPart 保持一致：
 *  答案 ≤2 字时猜 1 个字就算「很近」，≥3 字时猜 2 个字。
 *  （原来这里写死 slice(0,2)：遇到 2 字答案会退化成「猜了整个答案」，
 *    测不到 hot 分支，然后被当成失败 —— 这就是本测试随机挂的根因。） */
function hotGuess(answer) {
  return answer.slice(0, answer.length <= 2 ? 1 : 2);
}

/** 和答案同分类、但不是答案、也不是答案子串的词
 *  （若挑到答案的子串，会命中「很近」而不是「方向对」，测试会随机挂） */
function sameCatWord(answer, cat) {
  const pool = WORDS.filter((w) =>
    w[1] === cat && w[0] !== answer && !answer.includes(w[0]));
  return pool.length ? pool[Math.floor(Math.random() * pool.length)][0] : null;
}
/** 字数相同、一个字都不重合、且**不同分类**的词
 *  （同分类会命中「方向对」而不是「沾边」，必须排除，否则测试随机挂） */
function sameLenOther(answer, cat) {
  const set = new Set([...answer]);
  const pool = WORDS.filter((w) =>
    w[0] !== answer && w[1] !== cat &&
    [...w[0]].length === [...answer].length &&
    ![...w[0]].some((c) => set.has(c)));
  return pool.length ? pool[0][0] : null;
}

/** 等到有人拿到候选词，返回 { drawer, guesser, choice } */
async function findDrawer(clients, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (const c of clients) {
      const m = c.take('wordChoice');
      if (m) return { drawer: c, guesser: c === clients[0] ? clients[1] : clients[0], choice: m };
    }
    await sleep(25);
  }
  return null;
}

(async () => {
  console.log('\n=== 猜词温度测试 ===\n');

  const A = new Client('A', PORT);
  await A.connect();
  A.send({ t: 'join', name: '甲', avatar: '🐼' });
  const ja = await A.wait('joined', 8000);
  const code = ja.room.code;
  T('A 建房成功', !!code, '房间 ' + code);

  const B = new Client('B', PORT);
  await B.connect();
  B.send({ t: 'join', name: '乙', avatar: '🦊', roomCode: code });
  await B.wait('joined', 8000);
  T('B 加入成功', true);

  A.clear(); B.clear();
  A.send({ t: 'settings', rounds: 2, duration: 120 });
  await sleep(300);
  A.send({ t: 'start' });

  const f1 = await findDrawer([A, B], 12000);
  T('服务端指派了画手', !!f1);
  if (!f1) { A.close(); B.close(); process.exit(1); }

  // 优先挑一个 ≥3 字的词，子串那档才测得到
  const pick = f1.choice.words.find((x) => [...x.w].length >= 3) || f1.choice.words[0];
  f1.drawer.clear(); f1.guesser.clear();
  f1.drawer.send({ t: 'chooseWord', word: pick.w });
  const dw = await f1.drawer.wait('drawerWord', 8000);
  const ts = await f1.guesser.wait('turnStart', 8000);
  const answer = dw.word;
  const cat = ts.category;
  console.log('    （本题：' + answer + ' / ' + cat + ' / ' + answer.length + ' 字）');

  /* ---- ① 很近：猜的是答案的一部分 ---- */
  // 1 字答案服务端不会判 hot（要求 w.length > 1），这种情况标为跳过而不是失败
  const hg = hotGuess(answer);
  if (answer.length > 1 && hg.length < answer.length) {
    f1.guesser.clear();
    f1.guesser.send({ t: 'guess', text: hg });
    const hot = await waitOrNull(f1.guesser, 'warm', 3000);
    T('① 子串命中 → 🔥 很近', hot && hot.level === 'hot',
      hot ? (hot.level + '  猜「' + hg + '」') : '无提示');
    T('① 原有 close 消息保留（向后兼容，e2e 依赖它）', !!f1.guesser.take('close'));
    T('① 私有提示不广播给画手', !f1.drawer.inbox.some((m) => m.t === 'warm'));
  } else {
    console.log('  · 本题答案「' + answer + '」太短，hot 分支不适用，跳过（不算失败）');
    T('① 原有 close 消息保留（向后兼容，e2e 依赖它）', true, '跳过');
    T('① 私有提示不广播给画手', true, '跳过');
  }

  /* ---- ② 方向对：同分类，额度 3 次递减 ---- */
  const sc = sameCatWord(answer, cat);
  let lastLeft = null;
  if (sc) {
    f1.guesser.clear();
    f1.guesser.send({ t: 'guess', text: sc });
    const w1 = await waitOrNull(f1.guesser, 'warm', 3000);
    T('② 同分类 → 🌤 方向对', w1 && w1.level === 'warm', w1 && ('猜「' + sc + '」'));
    T('② 首次返回剩余额度 = 2', w1 && w1.left === 2, w1 && ('left=' + w1.left));
    lastLeft = w1 ? w1.left : null;

    // 再连猜两次同分类，把额度打光
    for (let i = 0; i < 2; i++) {
      const w = sameCatWord(answer, cat);
      if (!w) break;
      f1.guesser.clear();
      f1.guesser.send({ t: 'guess', text: w });
      const m = await waitOrNull(f1.guesser, 'warm', 2000);
      if (m && m.level === 'warm') lastLeft = m.left;
    }
    T('② 额度递减到 0', lastLeft === 0, 'left=' + lastLeft);

    // 额度用尽后再猜同分类 → 不该再给「方向对」
    const w4 = sameCatWord(answer, cat);
    if (w4) {
      f1.guesser.clear();
      f1.guesser.send({ t: 'guess', text: w4 });
      const m4 = await waitOrNull(f1.guesser, 'warm', 1500);
      T('② 额度用尽后降级（不再返回「方向对」）', !m4 || m4.level !== 'warm',
        m4 ? ('level=' + m4.level) : '无提示');
    }
  } else {
    T('② 同分类 → 🌤 方向对', false, '词库里找不到同分类的别的词');
  }

  /* ---- ③ 沾边：字数对上（不含剧透，仍进聊天）---- */
  const sl = sameLenOther(answer, cat);
  if (sl) {
    f1.drawer.clear(); f1.guesser.clear();
    f1.guesser.send({ t: 'guess', text: sl });
    const c1 = await waitOrNull(f1.guesser, 'warm', 2000);
    T('③ 字数对上 → 🌥 沾边', c1 && c1.level === 'cool', c1 && c1.text);
    await sleep(250);
    T('③ 沾边档照常广播进聊天（没被私有提示吃掉）',
      f1.drawer.inbox.some((m) => m.t === 'chat' && m.text === sl), sl);
  } else {
    T('③ 字数对上 → 🌥 沾边', false, '词库里找不到等长且不重字的词');
  }

  /* ---- ③b 完全无关：无提示，但仍进聊天 ---- */
  f1.drawer.clear(); f1.guesser.clear();
  f1.guesser.send({ t: 'guess', text: 'zzzqqq' });
  await sleep(300);
  T('❄️ 无关猜测不给任何温度提示', !f1.guesser.inbox.some((m) => m.t === 'warm'));
  T('❄️ 无关猜测照常进聊天', f1.drawer.inbox.some((m) => m.t === 'chat' && m.text === 'zzzqqq'));

  /* ---- 新回合额度重置 ---- */
  f1.guesser.clear();
  f1.guesser.send({ t: 'guess', text: answer });
  T('猜中生效（用来推进回合）', !!(await waitOrNull(f1.guesser, 'correct', 5000)));

  const f2 = await findDrawer([A, B], 12000);
  T('自动进入第 2 回合', !!f2);
  if (f2) {
    const p2 = f2.choice.words.find((x) => [...x.w].length >= 3) || f2.choice.words[0];
    f2.drawer.clear(); f2.guesser.clear();
    f2.drawer.send({ t: 'chooseWord', word: p2.w });
    const dw2 = await f2.drawer.wait('drawerWord', 8000);
    const ts2 = await f2.guesser.wait('turnStart', 8000);
    const sc2 = sameCatWord(dw2.word, ts2.category);
    if (sc2) {
      f2.guesser.clear();
      f2.guesser.send({ t: 'guess', text: sc2 });
      const w2 = await waitOrNull(f2.guesser, 'warm', 3000);
      T('新回合额度重置（又拿到「方向对」，且 left=2）',
        w2 && w2.level === 'warm' && w2.left === 2, w2 && ('left=' + w2.left));
    } else {
      T('新回合额度重置', false, '第 2 回合找不到同分类词');
    }
  }

  A.close(); B.close();
  console.log('\n' + (fails === 0 ? '全部通过 ✅' : fails + ' 项失败 ❌') + '\n');
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => {
  console.error('\n测试异常：' + (e && e.stack || e));
  process.exit(1);
});
