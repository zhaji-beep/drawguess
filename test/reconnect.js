'use strict';
/**
 * 断线重连回归测试
 * --------------------------------------------------------------
 * 背景：移动端切后台 / 息屏、桌面切标签久了、网络切换，都会让 WebSocket 被系统掐掉。
 *       以前断线 = 整局作废（只提示刷新页面），现在要做到「回来还能接上」。
 *
 * 覆盖：
 *   1. 断线后房间不会消失，其他人能看到「掉线了」
 *   2. 用同一个 pid 重连 → 复用同一个玩家 id
 *   3. 分数、连击等局内状态全部恢复
 *   4. 其他人收到「重新连接上了」
 *   5. 席位过期后重连退化成新玩家（不会无限期占着旧身份）
 *   6. 房间空了不立刻回收，但超过 ROOM_TTL 后确实被回收
 *
 * 运行：node test/reconnect.js   （或 node test/run-all.js）
 * 需要服务端带短 TTL 启动：SEAT_TTL_MS=4000 ROOM_TTL_MS=4000
 */
const { Client, sleep } = require('./client');

const PORT = Number(process.env.PORT) || 3299;
const SEAT_TTL = Number(process.env.SEAT_TTL_MS) || 4000;
const ROOM_TTL = Number(process.env.ROOM_TTL_MS) || 4000;
const GRACE = Number(process.env.RECONNECT_GRACE_MS) || 800;

let fails = 0;
function T(name, ok, extra) {
  console.log((ok ? '  \u2713 ' : '  \u2717 ') + name + (extra ? '   -> ' + extra : ''));
  if (!ok) fails++;
}
const waitOrNull = (c, type, ms) => c.wait(type, ms).then((m) => m, () => null);

async function findDrawer(cs, ms) {
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
async function joinRoom(name, avatar, pid, roomCode) {
  const c = new Client(name, PORT);
  await c.connect();
  c.send({ t: 'join', name, avatar, pid, roomCode: roomCode || null });
  const j = await c.wait('joined', 8000);
  return { c, j };
}

(async () => {
  console.log('\n=== 断线重连测试 ===\n');

  /* ---------- 建房 + 拿分 ---------- */
  const A = await joinRoom('甲', '🐼', 'pid-A');
  const roomCode = A.j.room.code;
  T('建房成功', /^\d{4}$/.test(roomCode), '房间 ' + roomCode);

  const B = await joinRoom('乙', '🦊', 'pid-B', roomCode);
  T('两人 id 不同', A.j.me.id !== B.j.me.id, A.j.me.id + ' / ' + B.j.me.id);

  A.c.clear(); B.c.clear();
  A.c.send({ t: 'settings', rounds: 3, duration: 120 });
  await sleep(250);
  A.c.send({ t: 'start' });

  const f = await findDrawer([A.c, B.c], 12000);
  T('服务端指派了画手', !!f);
  if (!f) { A.c.close(); B.c.close(); process.exit(1); }

  const drawer = f.drawer;
  const guesser = f.drawer === A.c ? B.c : A.c;
  const guesserId = f.drawer === A.c ? B.j.me.id : A.j.me.id;
  const guesserPid = f.drawer === A.c ? 'pid-B' : 'pid-A';

  drawer.clear(); guesser.clear();
  drawer.send({ t: 'chooseWord', word: f.choice.words[0].w });
  const dw = await drawer.wait('drawerWord', 8000);
  await guesser.wait('turnStart', 8000);

  drawer.clear();
  guesser.clear();
  guesser.send({ t: 'guess', text: dw.word });
  await waitOrNull(guesser, 'correct', 6000);
  const st = await waitOrNull(drawer, 'state', 4000);
  const scoreBefore = st ? (st.room.players.find((p) => p.id === guesserId) || {}).score : null;
  T('断线前该玩家已有分数', typeof scoreBefore === 'number' && scoreBefore > 0, 'score=' + scoreBefore);

  /* ---------- 模拟掉线（切后台被系统掐掉） ---------- */
  guesser.close();
  await sleep(GRACE + 400);            // 宽限期过了才会广播「掉线了」
  const leaveMsg = drawer.inbox.find((m) => m.t === 'chat' && /掉线/.test(m.text || ''));
  T('超过宽限期后才广播「掉线了」（不是「离开了房间」）', !!leaveMsg, leaveMsg && leaveMsg.text);
  T('另一方仍能收到房间状态（房间没被回收）', drawer.inbox.some((m) => m.t === 'state'));

  /* ---------- 用同一个 pid 重连 ---------- */
  drawer.clear();
  const back = await joinRoom('回来了', '🦊', guesserPid, roomCode);
  T('重连成功（收到 joined）', !!back.j);
  T('复用同一个玩家 id', back.j.me.id === guesserId, back.j.me.id + ' vs ' + guesserId);
  const scoreAfter = (back.j.room.players.find((p) => p.id === guesserId) || {}).score;
  T('分数完整恢复', scoreAfter === scoreBefore, scoreBefore + ' → ' + scoreAfter);
  await sleep(300);
  T('其他人看到「重新连接上了」',
    drawer.inbox.some((m) => m.t === 'chat' && /重新连接/.test(m.text || '')));

  /* ---------- 闪断：宽限期内回来，应该完全没有存在感 ---------- */
  drawer.clear();
  back.c.close();
  await sleep(Math.floor(GRACE / 3));           // 远小于宽限期
  const flash = await joinRoom('闪断', '🦊', guesserPid, roomCode);
  await sleep(GRACE + 300);                     // 等过原来的宽限点
  const chats = drawer.inbox.filter((m) => m.t === 'chat');
  T('宽限期内重连：不广播「掉线了」',
    !chats.some((m) => /掉线/.test(m.text || '')),
    chats.map((m) => m.text).join(' / ') || '(没有聊天消息)');
  T('宽限期内重连：也不广播「重新连接上了」（无感恢复）',
    !chats.some((m) => /重新连接/.test(m.text || '')));
  T('无感恢复后 id 依然一致', flash.j.me.id === guesserId,
    flash.j.me.id + ' vs ' + guesserId);

  /* ---------- 席位过期 → 退化成新玩家 ---------- */
  flash.c.close();
  drawer.clear();
  await sleep(SEAT_TTL + 600);
  const late = await joinRoom('迟到', '🐨', guesserPid, roomCode);
  T('席位过期后重连 = 新身份（不会无限期占着旧 id）',
    late.j.me.id !== guesserId, late.j.me.id);
  late.c.close();

  /* ---------- 房间延迟回收 ---------- */
  drawer.close();
  await sleep(400);
  const early = await joinRoom('早到', '🐵', null, roomCode);
  T('房间空了也不会立刻回收（重连窗口还在）', /^\d{4}$/.test(early.j.room.code),
    '房间 ' + early.j.room.code);
  early.c.close();

  await sleep(ROOM_TTL + 800);
  const dead = new Client('晚到', PORT);
  await dead.connect();
  dead.send({ t: 'join', name: '晚到', avatar: '🐵', roomCode });
  const err = await waitOrNull(dead, 'error', 5000);
  T('超过回收窗口后房间确实被回收', !!err && /不存在/.test(err.msg || ''), err && err.msg);
  dead.close();

  console.log('\n' + (fails === 0 ? '全部通过 ✅' : fails + ' 项失败 ❌') + '\n');
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => {
  console.error('\n测试异常：' + ((e && e.stack) || e));
  process.exit(1);
});
