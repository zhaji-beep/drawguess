/* 你画我猜 · 端到端测试（模拟两个真实 WebSocket 客户端走完整局） */
const http = require('http');
const crypto = require('crypto');
const PORT = Number(process.env.PORT) || 3000, HOST = process.env.HOST || '127.0.0.1';

let fails = 0;
function T(name, ok, extra) {
  console.log((ok ? '  \u2713 ' : '  \u2717 ') + name + (extra ? '   -> ' + extra : ''));
  if (!ok) fails++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- 客户端帧编解码 ---- */
function encFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  const mask = crypto.randomBytes(4);
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = 0x80 | len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 0x80 | 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
  head[0] = 0x80 | opcode;
  const body = Buffer.alloc(len);
  for (let i = 0; i < len; i++) body[i] = data[i] ^ mask[i & 3];
  return Buffer.concat([head, mask, body]);
}
function decFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0], b1 = buf[1];
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) === 0x80;
  let len = b1 & 0x7f, off = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = buf.readUInt32BE(6); off = 10; }
  let mask = null;
  if (masked) { if (buf.length < off + 4) return null; mask = buf.slice(off, off + 4); off += 4; }
  if (buf.length < off + len) return null;
  const p = Buffer.from(buf.slice(off, off + len));
  if (mask) for (let i = 0; i < p.length; i++) p[i] ^= mask[i & 3];
  return { opcode, payload: p, total: off + len };
}

class Client {
  constructor(tag) { this.tag = tag; this.inbox = []; this.waiters = []; }  connect() {
    return new Promise((res, rej) => {
      const key = crypto.randomBytes(16).toString('base64');
      const req = http.request({
        port: PORT, host: HOST,
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' }
      });
      req.on('upgrade', (r, socket, head) => {
        this.socket = socket; this.buf = Buffer.alloc(0);
        if (head && head.length) this.buf = head;
        socket.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.drain(); });
        socket.on('error', () => {});
        socket.on('close', () => { this.dead = true; });
        res(this);
      });
      req.on('error', rej);
      req.end();
    });
  }
  drain() {
    for (;;) {
      const f = decFrame(this.buf);
      if (!f) break;
      this.buf = this.buf.slice(f.total);
      if (f.opcode === 0x1) {
        let m; try { m = JSON.parse(f.payload.toString('utf8')); } catch (e) { continue; }
        this.onMsg(m);
      } else if (f.opcode === 0x9) {
        this.socket.write(encFrame(0xa, Buffer.alloc(0)));
      } else if (f.opcode === 0x8) {
        this.socket.destroy();
      }
    }
  }
  onMsg(m) {
    this.inbox.push(m);
    const i = this.waiters.findIndex((w) => w.type === m.t);
    if (i >= 0) { const w = this.waiters.splice(i, 1)[0]; clearTimeout(w.timer); w.res(m); }
  }
  waitFor(type, timeout) {
    const hit = this.inbox.find((m) => m.t === type);
    if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      const w = { type, res };
      w.timer = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        rej(new Error(this.tag + ' 等待 ' + type + ' 超时'));
      }, timeout || 8000);
      this.waiters.push(w);
    });
  }
  take(type) {
    const i = this.inbox.findIndex((m) => m.t === type);
    return i >= 0 ? this.inbox.splice(i, 1)[0] : null;
  }
  /** 清空历史消息。跨阶段（上一回合→下一回合）时务必调用，否则 waitFor 会命中旧消息造成假通过 */
  clear() { this.inbox.length = 0; }
  send(o) { this.socket.write(encFrame(0x1, JSON.stringify(o))); }
  close() { try { this.socket.destroy(); } catch (e) {} }
}

(async () => {
  console.log('\n=== 你画我猜 · 端到端测试 ===\n');
  const A = new Client('A'), B = new Client('B');
  let code = null;

  /** 等服务器指派画手，返回 {drawer, guesser, words, rerollLeft}；不自动选词 */
  async function waitDrawer(rounds) {
    for (let i = 0; i < (rounds || 60); i++) {
      await sleep(100);
      let wc = A.take('wordChoice');
      if (wc) return { drawer: A, guesser: B, words: wc.words, rerollLeft: wc.rerollLeft };
      wc = B.take('wordChoice');
      if (wc) return { drawer: B, guesser: A, words: wc.words, rerollLeft: wc.rerollLeft };
    }
    return null;
  }

  try {
    await A.connect();
    A.send({ t: 'join', name: '小明', avatar: '🐼' });
    const ja = await A.waitFor('joined');
    code = ja.room.code;
    T('A 创建房间', /^\d{4}$/.test(code), '房间号 ' + code);
    T('A 被设为房主', ja.me.host === true);
    T('A 拿到自己的 id', !!ja.me.id);

    // 单人不能开始
    A.send({ t: 'start' });
    const soloErr = await A.waitFor('error', 3000);
    T('单人时不允开始游戏', /至少/.test(soloErr.msg), soloErr.msg);

    await B.connect();
    B.send({ t: 'join', name: '小红', roomCode: code, avatar: '🦊' });
    const jb = await B.waitFor('joined');
    T('B 用房间号加入', jb.room.code === code);
    T('B 不是房主', jb.me.host === false);

    const st = await A.waitFor('state');
    T('A 收到 B 加入后的房间状态', st.room.players.length === 2, st.room.players.map((p) => p.name).join('/'));

    A.send({ t: 'settings', rounds: 1, duration: 30 });
    await sleep(150);
    const st2 = A.inbox.filter((m) => m.t === 'state').pop();
    T('房主改设置生效（1 轮）', st2 && st2.room.totalRounds === 1);
    T('换词次数作为房间设置下发（默认 3）', st2 && st2.room.reroll === 3,
      st2 ? 'reroll=' + st2.room.reroll : '无');

    A.inbox.length = 0; B.inbox.length = 0;
    A.send({ t: 'start' });

    /* ---------- 第 1 回合 ---------- */
    const R1 = await waitDrawer(60);
    T('服务器指派了画手并下发选词', !!R1,
      R1 ? R1.drawer.tag + ' 作画，候选 ' + R1.words.map((w) => w.w + '(' + w.d + ')').join(' / ') : '无');
    if (!R1) throw new Error('没有画手，流程中断');
    const drawer = R1.drawer, guesser = R1.guesser;
    drawer.name = drawer === A ? '小明' : '小红';
    guesser.name = guesser === A ? '小明' : '小红';
    T('候选词 3 个且都标了难度', R1.words.length === 3 && R1.words.every((w) => ['简单', '中等', '困难'].includes(w.d)));

    /* ----- 换一批（默认额度 3 次，房主可在 2/3/5 之间调） ----- */
    T('换词额度默认 3 次', R1.rerollLeft === 3, 'rerollLeft=' + R1.rerollLeft);
    drawer.clear();
    drawer.send({ t: 'reroll' });
    const rr1 = await drawer.waitFor('wordChoice', 4000);
    T('第一次「换一批」生效，额度减到 2', rr1.rerollLeft === 2 && rr1.rerolled === true && rr1.words.length === 3);
    drawer.clear();
    drawer.send({ t: 'reroll' });
    const rr2 = await drawer.waitFor('wordChoice', 4000);
    T('第二次「换一批」后额度减到 1', rr2.rerollLeft === 1);
    drawer.clear();
    drawer.send({ t: 'reroll' });
    const rr3 = await drawer.waitFor('wordChoice', 4000);
    T('第三次「换一批」后额度用尽', rr3.rerollLeft === 0);
    drawer.clear();
    drawer.send({ t: 'reroll' });
    const rrErr = await drawer.waitFor('error', 4000);
    T('额度用尽后再换词被拒绝', /用完/.test(rrErr.msg), rrErr.msg);
    const afterErr = drawer.take('wordChoice');
    T('被拒绝时不会下发新词', !afterErr);

    /* ----- 非法自定义词 ----- */
    drawer.clear();
    drawer.send({ t: 'customWord', word: '！！!' });
    const cErr = await drawer.waitFor('error', 4000);
    T('纯符号的自定义词被拦下', /不行/.test(cErr.msg), cErr.msg);

    drawer.send({ t: 'chooseWord', word: rr3.words[0].w });

    const ts1 = await guesser.waitFor('turnStart');
    T('猜者收到 turnStart（含题长与分类）', ts1.wordLen > 0 && !!ts1.category, ts1.category + ' ' + ts1.wordLen + '字');
    T('猜者拿不到答案明文', ts1.word === undefined);
    T('猜者初始提示为占位符', /^[＿ ]+$/.test(ts1.mask), JSON.stringify(ts1.mask));

    drawer.send({ t: 'draw', op: 'begin', sid: 1, color: '#ef4444', w: 0.008, mode: 'pen', x: 0.2, y: 0.2 });
    drawer.send({ t: 'draw', op: 'pts', sid: 1, pts: [0.3, 0.3, 0.4, 0.5] });
    drawer.send({ t: 'draw', op: 'end', sid: 1 });
    await sleep(180);
    const dv = guesser.take('draw');
    T('绘画笔画实时同步到猜者', dv && dv.op === 'begin' && dv.color === '#ef4444');

    // 先拿答案，后面测接近提示要用
    const dw = await drawer.waitFor('drawerWord');
    const answer = dw.word;
    T('画手收到自己的题目', !!answer, answer);

    // 猜错的普通消息
    drawer.inbox.length = 0;
    guesser.send({ t: 'guess', text: '完全不对的东西' });
    const wrongMsg = await drawer.waitFor('chat');
    T('错误猜测广播为聊天消息', wrongMsg.kind === 'chat', wrongMsg.text);
    if (answer.length > 1) {
      guesser.inbox.length = 0;
      guesser.send({ t: 'guess', text: answer.slice(0, Math.min(2, answer.length - 1)) });
      const closeMsg = await guesser.waitFor('close', 3000);
      T('部分命中给猜者"接近了"私有提示', !!closeMsg, answer.slice(0, 2));
      T('"接近了"不广播给别人', !drawer.inbox.some((m) => m.t === 'close'));
    }

    // 画手不能发言
    guesser.inbox.length = 0;
    drawer.send({ t: 'guess', text: '我是画手我说话' });
    await sleep(200);
    T('画手在回合内无法发言', !guesser.inbox.some((m) => m.t === 'chat' && m.name === drawer.name));

    // 猜对
    guesser.inbox.length = 0; drawer.inbox.length = 0;
    guesser.send({ t: 'guess', text: answer });
    const cor = await guesser.waitFor('correct');
    T('正确猜测被判定为猜中', cor.rank === 1 && cor.gain > 0, '+' + cor.gain + ' 分');
    const corAll = await drawer.waitFor('correct', 3000);
    T('猜中广播给所有人', !!corAll);

    const te1 = await drawer.waitFor('turnEnd');
    T('全员猜中后立即结束回合', te1.reason === 'allGuessed' && te1.allGuessed === true, '答案「' + te1.word + '」');
    T('画手获得分数', te1.drawerGain > 0, '+' + te1.drawerGain + ' 分');
    T('回合结束带回画布数据', Array.isArray(te1.strokes) && te1.strokes.length >= 1, te1.strokes.length + ' 条笔画');

    /* ---------- 第 2 回合 ---------- */
    A.inbox.length = 0; B.inbox.length = 0;
    const R2 = await waitDrawer(140);
    T('自动进入第 2 回合', !!R2, R2 ? R2.drawer.tag + ' 作画' : '超时');
    T('第 2 回合换了画手', !!R2 && R2.drawer !== drawer, R2 ? R2.drawer.tag : '-');

    if (R2) {
      const drawer2 = R2.drawer, guesser2 = R2.guesser;
      T('新回合换词额度按房主设置重置', R2.rerollLeft === 3, 'rerollLeft=' + R2.rerollLeft);
      drawer2.clear(); guesser2.clear();

      /* ----- 自定义出题 ----- */
      drawer2.send({ t: 'customWord', word: '大黄鸭' });
      const ts2 = await guesser2.waitFor('turnStart');
      const dw2 = await drawer2.waitFor('drawerWord');
      T('自定义出题生效', dw2.word === '大黄鸭', dw2.word);
      T('自定义词按字数折算难度', dw2.diff === '中等', '「大黄鸭」3 字 → ' + dw2.diff);
      T('自定义词分类标为「自定义」', ts2.category === '自定义', ts2.category);
      T('猜者只看到字数占位符', ts2.wordLen === 3 && /^[＿ ]+$/.test(ts2.mask), JSON.stringify(ts2.mask));

      guesser2.send({ t: 'guess', text: dw2.word });
      const cor2 = await guesser2.waitFor('correct');
      T('自定义词同样能判中', cor2.gain > 0, '+' + cor2.gain + ' 分');
      const te2 = await drawer2.waitFor('turnEnd');
      T('第 2 回合正常结算', te2.word === '大黄鸭', '答案「' + te2.word + '」');
    }

    /* ---------- 结算 ---------- */
    const fin = await A.waitFor('gameEnd', 12000);
    T('1 轮结束后游戏结算', fin.ranking.length === 2, fin.ranking.map((r) => r.name + ':' + r.score).join('  '));
    T('排行榜按分数降序', fin.ranking[0].score >= fin.ranking[1].score);
    T('存在获胜者', fin.ranking[0].rank === 1);

    /* ---------- 房间不存在 ---------- */
    const C = new Client('C');
    await C.connect();
    C.send({ t: 'join', name: '路人', roomCode: '0000' });
    const err = await C.waitFor('error', 3000);
    T('加入不存在的房间会报错', /不存在/.test(err.msg), err.msg);
    C.close();

    /* ---------- 断线 ---------- */
    B.close();
    await sleep(400);
    const stAfter = A.inbox.filter((m) => m.t === 'state').pop();
    // 原来这条结尾带着 `|| true`，永远通过 —— 等于没测。
    // 现在真的验：断线的人要么已从玩家列表里消失（房间还有人），
    // 要么整间房已经回收（就剩他自己时）。
    T('玩家断线后房间状态更新',
      !stAfter || stAfter.room.players.every((p) => p.name !== '小红'),
      stAfter ? '还在房里: ' + stAfter.room.players.map((p) => p.name).join('/') : '房间已回收');

  } catch (e) {
    T('测试流程', false, e.message);
  }

  A.close(); B.close();
  console.log('\n' + (fails === 0 ? '全部通过 ✅' : fails + ' 项失败 ❌') + '\n');
  process.exit(fails === 0 ? 0 : 1);
})();
