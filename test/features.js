'use strict';
/**
 * 第二批玩法集成测试（服务端行为）：
 *   1) 主题解析：📅 每日主题 / 🎲 随机 3 类
 *   2) 自定义词库导入：清洗规则、并入词池
 *   3) 限制玩法：只用一种颜色 / 一笔画完 / 禁用橡皮（服务端强制）
 *   4) 画作投票：打分、防重复、防自评、结算画作分
 * 用法：先以测试模式启动服务，再跑本脚本
 *   PORT=3100 TURN_END_DELAY=800 VOTE_WINDOW_MS=500 node server.js
 *   node test/features.js
 */
const { WORDS } = require('../words');
const { Client, sleep } = require('./client');
const picker = require('../picker');
picker.init(WORDS);

const CAT_COUNT = {};
for (const w of WORDS) CAT_COUNT[w[1]] = (CAT_COUNT[w[1]] || 0) + 1;

let fails = 0;
function T(name, ok, extra) {
  console.log((ok ? '  \u2713 ' : '  \u2717 ') + name + (extra ? '   -> ' + extra : ''));
  if (!ok) fails++;
}

/** 等服务器把画手指派出来 */
async function waitDrawer(clients, tries) {
  for (let i = 0; i < (tries || 200); i++) {
    for (const c of clients) {
      const wc = c.take('wordChoice');
      if (wc) return { drawer: c, wc };
    }
    await sleep(25);
  }
  return null;
}

(async () => {
  console.log('\n=== 玩法特性集成测试 ===\n');
  const A = new Client('A'), B = new Client('B'), C = new Client('C'), D = new Client('D');
  const all = [A, B, C, D];

  try {
    /* ============ 1. 主题解析 ============ */
    await A.connect();
    A.send({ t: 'join', name: '阿甲', avatar: '🐼' });
    const ja = await A.wait('joined');
    const code = ja.room.code;
    T('服务端下发快捷主题与限制项定义',
      ja.themeMeta && ja.themeMeta.length === 2 && ja.limitMeta && ja.limitMeta.length === 5,
      (ja.themeMeta || []).map((t) => t.name).join(' / ') + ' ｜ 限制：' +
      (ja.limitMeta || []).map((l) => l.name).join('、'));

    await B.connect(); B.send({ t: 'join', name: '阿乙', roomCode: code, avatar: '🦊' });
    await B.wait('joined');
    await sleep(120);

    A.clear();
    A.send({ t: 'settings', themes: ['__daily'] });
    await sleep(200);
    const d1 = await A.wait('state');
    const d2 = (await (async () => { A.send({ t: 'settings', rounds: 3 }); await sleep(150); return A.wait('state'); })());
    T('📅 每日主题解析出 3 个分类', d1.room.themesResolved.length === 3, d1.room.themesResolved.join('+'));
    T('每日主题在一天内稳定不变',
      d1.room.themesResolved.join() === d2.room.themesResolved.join());
    const dailySum = d1.room.themesResolved.reduce((a, c) => a + (CAT_COUNT[c] || 0), 0);
    T('词池规模等于所选分类词数之和', d1.room.pool.total === dailySum,
      d1.room.themesResolved.join('+') + ' = ' + d1.room.pool.total);

    A.clear();
    A.send({ t: 'settings', themes: ['__random3'] });
    await sleep(200);
    const r1 = await A.wait('state');
    A.send({ t: 'settings', rounds: 3 });
    await sleep(150);
    const r2 = await A.wait('state');
    T('🎲 随机 3 类解析出 3 个分类', r1.room.themesResolved.length === 3, r1.room.themesResolved.join('+'));
    T('随机主题在开局前保持稳定（不会每次刷新都变）',
      r1.room.themesResolved.join() === r2.room.themesResolved.join());
    T('随机主题与每日主题互斥',
      !r1.room.themes.includes('__daily') && r1.room.themes.includes('__random3'));

    /* ============ 2. 自定义词库导入 ============ */
    A.clear();
    A.send({ t: 'settings', themes: [], customWords: ['奶茶店', '开题答辩', '！！!', '  很长很长很长很长的词  ', '奶茶店'] });
    await sleep(250);
    const c1 = await A.wait('state');
    T('自定义词清洗：去符号/去重/限长 8 字',
      c1.room.customCount === 3, c1.room.customCount + ' 个（预期 3：奶茶店/开题答辩/很长很长很长很长）');
    T('自定义词并入词池', c1.room.pool.total === WORDS.length + c1.room.customCount,
      WORDS.length + ' + ' + c1.room.customCount + ' = ' + c1.room.pool.total);

    // picker 层：自定义词确实会被抽出来
    const pr = { settings: { themes: [] }, usedWords: [], bag: null, customPool: [['奶茶店', '自定义', 2], ['开题答辩', '自定义', 3]] };
    let customHits = 0;
    for (let i = 0; i < 200; i++) {
      const c = picker.pickWords(pr, 3, [], null);
      if (c.some((w) => w[1] === '自定义')) customHits++;
      c.forEach((w) => picker.markUsed(pr, w[0]));
    }
    T('自定义词会被真实抽进候选池', customHits > 0, '200 次抽词中命中 ' + customHits + ' 次');

    A.clear();
    A.send({ t: 'settings', customWords: [] });
    await sleep(200);
    const c2 = await A.wait('state');
    T('清空自定义词库生效', c2.room.customCount === 0 && c2.room.pool.total === WORDS.length);

    /* ============ 3. 限制玩法 ============ */
    A.clear(); B.clear();
    A.send({ t: 'settings', rounds: 1, duration: 30, themes: [], limits: { singleColor: true, noEraser: true } });
    await sleep(250);
    const s1 = await A.wait('state');
    T('限制开关下发到房间状态',
      s1.room.limits.singleColor === true && s1.room.limits.noEraser === true &&
      s1.room.limits.oneStroke === false && s1.room.limits.blindDraw === false,
      JSON.stringify(s1.room.limits));

    A.clear();
    A.send({ t: 'settings', limits: { blindDraw: true } });
    await sleep(220);
    const sB = await A.wait('state');
    T('盲画模式可以单独开启', sB.room.limits.blindDraw === true, JSON.stringify(sB.room.limits));
    A.send({ t: 'settings', limits: { blindDraw: false } });
    await sleep(180);
    A.clear();

    A.clear(); B.clear();
    A.send({ t: 'start' });
    const R = await waitDrawer([A, B]);
    if (!R) throw new Error('没有等到画手');
    const drawer = R.drawer;
    const guesser = R.drawer === A ? B : A;
    drawer.clear(); guesser.clear();
    drawer.send({ t: 'chooseWord', word: R.wc.words[0].w });
    await drawer.wait('drawerWord');

    drawer.send({ t: 'draw', op: 'begin', sid: 1, color: '#ef4444', w: 0.008, mode: 'pen', x: 0.2, y: 0.2 });
    await sleep(150);
    const d0 = guesser.take('draw');
    T('第一笔正常下发', !!d0 && d0.color === '#ef4444', d0 ? d0.color : '无');

    drawer.send({ t: 'draw', op: 'begin', sid: 2, color: '#3b82f6', w: 0.008, mode: 'pen', x: 0.4, y: 0.4 });
    await sleep(150);
    const d1s = guesser.take('draw');
    T('「只用一种颜色」把第二笔强制改回锁定色', !!d1s && d1s.color === '#ef4444',
      d1s ? '请求 #3b82f6 → 实际 ' + d1s.color : '无');

    drawer.clear();
    drawer.send({ t: 'draw', op: 'begin', sid: 3, color: '#ef4444', w: 0.02, mode: 'eraser', x: 0.5, y: 0.5 });
    const eEraser = await drawer.wait('error', 3000).catch(() => null);
    T('「禁用橡皮」被服务端拦下', !!eEraser && /橡皮/.test(eEraser.msg), eEraser ? eEraser.msg : '无');

    drawer.clear(); guesser.clear();
    drawer.send({ t: 'draw', op: 'clear' });
    await sleep(150);
    T('未开启「一笔画完」时清空画布正常', !!guesser.take('draw'));
    A.close(); B.close();

    /* ============ 4. 画作投票 ============ */
    const E = new Client('E'), F = new Client('F');
    await E.connect(); E.send({ t: 'join', name: '阿丙', avatar: '🐯' });
    const je = await E.wait('joined');
    const code2 = je.room.code;
    await F.connect(); F.send({ t: 'join', name: '阿丁', roomCode: code2, avatar: '🐨' });
    await F.wait('joined');
    await sleep(150);

    E.clear(); F.clear();
    E.send({ t: 'settings', rounds: 1, duration: 30, themes: [] });
    await sleep(200);
    E.send({ t: 'start' });
    const R2 = await waitDrawer([E, F]);
    if (!R2) throw new Error('投票局没有等到画手');
    const dr = R2.drawer;
    const gs = R2.drawer === E ? F : E;
    dr.clear(); gs.clear();
    dr.send({ t: 'chooseWord', word: R2.wc.words[0].w });
    const dw = await dr.wait('drawerWord');
    T('投票局画手拿到题目', !!dw.word, dw.word);

    gs.clear();
    gs.send({ t: 'guess', text: dw.word });
    const cor = await gs.wait('correct', 5000);
    T('投票局猜中结算', cor.gain > 0, '+' + cor.gain);
    const te = await gs.wait('turnEnd', 6000);
    T('回合末开启投票窗', te.voting === true && te.voteWindow > 0, '窗口 ' + te.voteWindow + 'ms');

    // 画手不能给自己打分
    dr.clear();
    dr.send({ t: 'vote', stars: 5 });
    T('画手不能给自己打分', await dr.expectNone('voted', 300));

    // 非法星级
    gs.clear();
    gs.send({ t: 'vote', stars: 9 });
    const eV = await gs.wait('error', 3000).catch(() => null);
    T('星级越界被拒绝', !!eV && /1~5/.test(eV.msg), eV ? eV.msg : '无');

    // 正常投票
    gs.clear(); dr.clear();
    gs.send({ t: 'vote', stars: 5 });
    const vd = await gs.wait('voted', 3000).catch(() => null);
    T('正常投票收到回执', !!vd && vd.stars === 5, vd ? vd.stars + ' 星' : '无');
    const vin = await dr.wait('voteIn', 3000).catch(() => null);
    T('有人评分会广播给其他人', !!vin && vin.count >= 1, vin ? vin.count + ' 人' : '无');

    // 重复投票
    gs.clear();
    gs.send({ t: 'vote', stars: 3 });
    const eV2 = await gs.wait('error', 3000).catch(() => null);
    T('重复评分被拒绝', !!eV2 && /已经评过/.test(eV2.msg), eV2 ? eV2.msg : '无');

    // 等投票窗关闭 → voteResult
    const vr = await dr.wait('voteResult', 6000).catch(() => null);
    T('投票窗关闭后广播评分结果', !!vr && vr.count === 1 && vr.avg === 5,
      vr ? vr.avg + ' 星 / ' + vr.count + ' 人' : '无');
    T('画手按均分拿到画作分', !!vr && vr.bonus === 40, vr ? '+' + vr.bonus : '无');

    // 自动打完剩下的回合，让游戏正常结算（1 轮 × 2 人 = 2 个回合）
    for (let t = 0; t < 1; t++) {
      const nxt = await waitDrawer([E, F], 240);
      if (!nxt) break;
      const d2 = nxt.drawer;
      const g2 = nxt.drawer === E ? F : E;
      d2.clear(); g2.clear();
      d2.send({ t: 'chooseWord', word: nxt.wc.words[0].w });
      const w2 = await d2.wait('drawerWord');
      g2.send({ t: 'guess', text: w2.word });
      await g2.wait('correct', 5000);
      await g2.wait('turnEnd', 6000);
    }

    const fin = await E.wait('gameEnd', 15000);
    T('结算包含最佳画作', !!fin.bestDrawing && fin.bestDrawing.word === dw.word,
      fin.bestDrawing ? fin.bestDrawing.word + ' ' + fin.bestDrawing.avg + ' 星' : '无');
    T('排行榜含画作分累计字段', fin.ranking.every((r) => typeof r.voteGainTotal === 'number'));
    T('结算称号包含全场最佳画作', fin.ranking.some((r) => (r.titles || []).some((x) => /最佳画作/.test(x))),
      fin.ranking.map((r) => r.name + '[' + (r.titles || []).join(',') + ']').join('  '));

    E.close(); F.close();

    /* ============ 5. 一笔画完（画板锁）+ 换词次数设置 ============ */
    const G = new Client('G'), H = new Client('H');
    await G.connect(); G.send({ t: 'join', name: '阿戊', avatar: '🐵' });
    const jg = await G.wait('joined');
    const code3 = jg.room.code;
    await H.connect(); H.send({ t: 'join', name: '阿己', roomCode: code3, avatar: '🐸' });
    await H.wait('joined');
    await sleep(150);

    G.clear(); H.clear();
    G.send({ t: 'settings', rounds: 1, duration: 30, limits: { oneStroke: true }, reroll: 5 });
    await sleep(250);
    const st3 = await G.wait('state');
    T('房主可调换词次数（2/3/5）', st3.room.reroll === 5, 'reroll=' + st3.room.reroll);
    T('换词档位越界会被夹住', await (async () => {
      G.send({ t: 'settings', reroll: 99 });
      await sleep(200);
      const s = await G.wait('state', 2000).catch(() => null);
      return !s || (s.room.reroll >= 0 && s.room.reroll <= 6);
    })());

    G.send({ t: 'settings', reroll: 5 });
    await sleep(200);
    G.clear(); H.clear();
    G.send({ t: 'start' });
    const R3 = await waitDrawer([G, H]);
    if (!R3) throw new Error('一笔画局没有等到画手');
    T('新回合换词额度取自房主设置', R3.wc.rerollLeft === 5, 'rerollLeft=' + R3.wc.rerollLeft);

    const dr3 = R3.drawer;
    const gs3 = R3.drawer === G ? H : G;
    dr3.clear(); gs3.clear();
    dr3.send({ t: 'chooseWord', word: R3.wc.words[0].w });
    await dr3.wait('drawerWord');
    dr3.clear(); gs3.clear();

    /* 画第一笔并抬笔 → 应立刻锁板 */
    dr3.send({ t: 'draw', op: 'begin', sid: 1, color: '#111827', w: 0.008, mode: 'pen', x: 0.1, y: 0.1 });
    dr3.send({ t: 'draw', op: 'pts', sid: 1, pts: [0.2, 0.2, 0.3, 0.3] });
    dr3.send({ t: 'draw', op: 'end', sid: 1 });
    const bl = await dr3.wait('boardLock', 3000).catch(() => null);
    T('一笔画完后服务端立刻广播锁板', !!bl && bl.locked === true, bl ? 'locked=' + bl.locked : '无');
    const blG = await gs3.wait('boardLock', 3000).catch(() => null);
    T('锁板状态同步给猜词者', !!blG && blG.locked === true);

    /* 新加入的人也能拿到锁板状态（重连/中途加入不会状态错乱） */
    const I = new Client('I');
    await I.connect(); I.send({ t: 'join', name: '阿庚', roomCode: code3, avatar: '🐷' });
    const ji = await I.wait('joined');
    T('中途加入的人能同步到锁板状态', ji.room.boardLocked === true, 'boardLocked=' + ji.room.boardLocked);
    I.close();

    /* 锁板后第二笔必须被拒 */
    dr3.clear();
    dr3.send({ t: 'draw', op: 'begin', sid: 2, color: '#111827', w: 0.008, mode: 'pen', x: 0.5, y: 0.5 });
    const e1 = await dr3.wait('error', 3000).catch(() => null);
    T('锁板后第二笔被服务端拒绝', !!e1 && /一笔/.test(e1.msg), e1 ? e1.msg : '无');

    /* 撤销 → 解锁，重新拿回这一笔 */
    dr3.clear(); gs3.clear();
    dr3.send({ t: 'draw', op: 'undo' });
    const bu = await dr3.wait('boardLock', 3000).catch(() => null);
    T('撤销后自动解锁', !!bu && bu.locked === false, bu ? 'locked=' + bu.locked : '无');
    dr3.clear();
    dr3.send({ t: 'draw', op: 'begin', sid: 3, color: '#111827', w: 0.008, mode: 'pen', x: 0.6, y: 0.6 });
    T('解锁后可以重新画一笔', await dr3.expectNone('error', 300));

    dr3.clear();
    dr3.send({ t: 'draw', op: 'clear' });
    const e2 = await dr3.wait('error', 3000).catch(() => null);
    T('「一笔画完」同时禁掉清空重画', !!e2 && /一笔/.test(e2.msg), e2 ? e2.msg : '无');
    G.close(); H.close();

  } catch (e) {
    T('测试流程', false, e.message);
  }

  all.forEach((c) => c.close());
  console.log('\n' + (fails === 0 ? '全部通过 ✅' : fails + ' 项失败 ❌') + '\n');
  process.exit(fails === 0 ? 0 : 1);
})();
