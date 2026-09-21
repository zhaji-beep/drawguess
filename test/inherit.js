'use strict';
/**
 * 「接盘画」回归测试
 * --------------------------------------------------------------
 * 规则：回合开始**不清空画布**，下一位画手要接着上一轮的残留画。
 *       清空可以（必须给出口），但代价 -10 分。
 *
 * 覆盖：
 *   · 默认关闭时不继承（第 2 回合不该收到任何 fill）
 *   · 开启后第 2 回合收到 fill，且内容是上一轮的笔迹
 *   · 开启后会给一条「接盘画」系统提示
 *   · 清空残留扣 10 分，且不会扣成负数（分数不足时夹到 0）
 *
 * 运行：node test/inherit.js   （或 node test/run-all.js）
 */
const { Client, sleep } = require('./client');

const PORT = Number(process.env.PORT) || 3299;

let fails = 0;
function T(name, ok, extra) {
  console.log((ok ? '  \u2713 ' : '  \u2717 ') + name + (extra ? '   -> ' + extra : ''));
  if (!ok) fails++;
}
/** wait 超时会 reject，这里统一转成 null */
const waitOrNull = (c, type, ms) => c.wait(type, ms).then((m) => m, () => null);

async function waitDrawer(cs, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    for (const c of cs) {
      const m = c.take('wordChoice');
      if (m) return { drawer: c, choice: m };
    }
    await sleep(25);
  }
  return null;
}
const peerOf = (cs, c) => (c === cs[0] ? cs[1] : cs[0]);

/** 跑一局两回合；返回第 2 回合开始时观察到的现象 */
async function play(tag, inherit) {
  const A = new Client(tag + 'A', PORT);
  await A.connect();
  A.send({ t: 'join', name: tag + '甲', avatar: '🐼' });
  const ja = await A.wait('joined', 8000);

  const B = new Client(tag + 'B', PORT);
  await B.connect();
  B.send({ t: 'join', name: tag + '乙', avatar: '🦊', roomCode: ja.room.code });
  await B.wait('joined', 8000);
  const cs = [A, B];

  A.clear(); B.clear();
  if (inherit) {
    A.send({ t: 'settings', limits: { inherit: true } });
    await sleep(250);
  }
  A.send({ t: 'settings', rounds: 3, duration: 120 });
  await sleep(250);
  A.send({ t: 'start' });

  /* ---------- 第 1 回合 ---------- */
  const f1 = await waitDrawer(cs, 12000);
  if (!f1) return { fail: '第 1 回合没指派画手' };
  const p1 = peerOf(cs, f1.drawer);
  f1.drawer.clear(); p1.clear();
  f1.drawer.send({ t: 'chooseWord', word: f1.choice.words[0].w });
  const dw1 = await f1.drawer.wait('drawerWord', 8000);
  await p1.wait('turnStart', 8000);

  // 画一笔（走真实协议）
  f1.drawer.send({ t: 'draw', op: 'begin', sid: 11, color: '#ef4444', w: 0.01, mode: 'pen', x: 0.2, y: 0.3 });
  f1.drawer.send({ t: 'draw', op: 'pts', sid: 11, pts: [0.25, 0.35, 0.3, 0.4] });
  f1.drawer.send({ t: 'draw', op: 'end', sid: 11 });
  await sleep(200);

  // 猜中 → 第 1 回合结束
  p1.send({ t: 'guess', text: dw1.word });
  await waitOrNull(p1, 'correct', 6000);

  /* ---------- 第 2 回合：观察点 ---------- */
  const f2 = await waitDrawer(cs, 12000);
  if (!f2) return { fail: '第 2 回合没指派画手' };
  const d2 = f2.drawer, g2 = peerOf(cs, d2);
  A.clear(); B.clear();
  d2.send({ t: 'chooseWord', word: f2.choice.words[0].w });
  await waitOrNull(d2, 'drawerWord', 8000);
  await sleep(400);

  const fills = d2.inbox.filter((m) => m.t === 'draw' && m.op === 'fill');
  const gfills = g2.inbox.filter((m) => m.t === 'draw' && m.op === 'fill');
  const sys = d2.inbox.filter((m) => m.t === 'chat' && /接盘画/.test(m.text || ''));
  const ts2 = d2.inbox.find((m) => m.t === 'turnStart');
  const before = ts2 ? (ts2.room.players.find((p) => p.id === ts2.room.drawerId) || {}).score : null;

  return { A, B, d2, g2, fills, gfills, sys, before };
}

(async () => {
  console.log('\n=== 接盘画测试 ===\n');

  /* ========== 场景 1：默认关闭 ========== */
  const off = await play('关', false);
  if (off.fail) { T(off.fail, false); }
  else {
    T('默认关闭：第 2 回合不继承画布（两端都没收到 fill）',
      off.fills.length === 0 && off.gfills.length === 0,
      '画手 ' + off.fills.length + ' 条 / 猜者 ' + off.gfills.length + ' 条');
    T('默认关闭：没有「接盘画」系统提示', off.sys.length === 0);
  }
  if (off.A) { off.A.close(); off.B.close(); }

  /* ========== 场景 2：开启 ========== */
  const on = await play('开', true);
  if (on.fail) { T(on.fail, false); }
  else {
    T('开启后：第 2 回合画手收到 fill（画布带着上一轮的残留）',
      on.fills.length === 1, '收到 ' + on.fills.length + ' 条');
    const st = on.fills[0] && on.fills[0].strokes;
    T('填充内容就是上一轮那一笔',
      Array.isArray(st) && st.length === 1 && st[0].sid === 11 && st[0].pts.length >= 6,
      'strokes=' + (Array.isArray(st) ? st.length : '?') + ' sid=' + (st && st[0] && st[0].sid));
    T('开启后：猜词者同样能看到残留', on.gfills.length === 1,
      '收到 ' + on.gfills.length + ' 条');
    T('开启后：给出「接盘画」系统提示', on.sys.length === 1,
      on.sys[0] && on.sys[0].text);

    /* ---- 清空要扣 10 分，且不能扣成负数 ---- */
    const d2 = on.d2;
    d2.clear();
    d2.send({ t: 'draw', op: 'clear' });
    await sleep(400);
    const stMsg = d2.inbox.find((m) => m.t === 'state');
    const after = stMsg ? (stMsg.room.players.find((p) => p.id === stMsg.room.drawerId) || {}).score : null;
    const erased = d2.inbox.some((m) => m.t === 'chat' && /擦掉/.test(m.text || ''));
    const cleared = d2.inbox.some((m) => m.t === 'draw' && m.op === 'clear');
    T('清空残留会广播一次 clear', cleared);
    T('清空残留给出扣分提示', erased);
    T('清空残留扣 10 分（分数不足时夹到 0，不会变负）',
      after === Math.max(0, (on.before || 0) - 10),
      'before=' + on.before + ' after=' + after);
  }
  if (on.A) { on.A.close(); on.B.close(); }

  console.log('\n' + (fails === 0 ? '全部通过 ✅' : fails + ' 项失败 ❌') + '\n');
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => {
  console.error('\n测试异常：' + ((e && e.stack) || e));
  process.exit(1);
});
