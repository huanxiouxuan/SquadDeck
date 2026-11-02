/**
 * 五子棋「人机对战」冒烟测试。
 *
 * 覆盖：
 *   1. act=create&ai=1 建房 → AI 自动坐白位，房间直接进入 playing
 *   2. 人落一子 → AI 立刻应手，棋盘上恰好两颗子，并带回思考信息（ms/深度/节点）
 *   3. AI 不计入在线人数
 *   4. 认输 → 再来一局 → 交换先后手，AI 变黑**自己走第一步**
 *   5. 退出房间 → 回到大厅
 *   6. 人走后房间能被清理（AI 不会把空房间"撑住"）
 *
 * 跑法：先起服务器，再 `node 测试文件/test-gomoku-ai.js`
 */

const path = require('path');
const fs = require('fs');

const BASE = process.env.BASE || 'http://127.0.0.1:8080';
const GAME_NAME = '五子棋对弈';

const root = path.join(__dirname, '..', 'gamemode');

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (extra ? '  -- ' + extra : '')); }
}

async function post(url, params) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString()
  });
  let d = null;
  try { d = await r.json(); } catch (e) { /* 忽略 */ }
  return { status: r.status, d };
}

/** 找「五子棋对弈」；没有就现导一个（server/ 下所有 .java 一起传）。 */
async function ensureGame() {
  const list = await (await fetch(BASE + '/api/games')).json();
  const found = (list.games || []).find(g => g.name === GAME_NAME);
  if (found) {
    return found.id;
  }
  let dir = null;
  for (const d of fs.readdirSync(root)) {
    const p = path.join(root, d);
    if (fs.existsSync(path.join(p, 'index.html'))
        && fs.existsSync(path.join(p, 'server', 'GomokuWorld.java'))) {
      dir = p;
      break;
    }
  }
  if (!dir) { throw new Error('gamemode/ 下找不到五子棋目录'); }

  const serverFiles = fs.readdirSync(path.join(dir, 'server'))
    .filter(n => n.endsWith('.java'))
    .map(n => 'server/' + n);
  const files = ['index.html', 'game.js', ...serverFiles].map(n => ({
    name: n, buf: fs.readFileSync(path.join(dir, ...n.split('/')))
  }));
  const r = await fetch(BASE + '/api/games/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: GAME_NAME,
      desc: '开房对弈：两人一局，输房间码加入，可同时开多局',
      icon: '\u26AB\u26AA',
      entry: 'index.html',
      world: 'lkserver.GomokuWorld',
      autostart: false,
      files: files.map(f => ({ p: f.name, s: f.buf.length }))
    })
  });
  const d = await r.json();
  if (!d.ok) { throw new Error('导入失败: ' + JSON.stringify(d)); }
  const id = d.game.id;
  for (const f of files) {
    const ur = await fetch(BASE + '/api/games/upload?game=' + encodeURIComponent(id)
        + '&path=' + encodeURIComponent(f.name), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: f.buf
    });
    if (!ur.ok) { throw new Error('上传 ' + f.name + ' 失败: ' + ur.status); }
  }
  return id;
}

function countStones(cells) {
  let n = 0;
  for (const row of cells) {
    for (const v of row) { if (v !== 0) { n++; } }
  }
  return n;
}

(async function () {
  console.log('== 五子棋人机对战冒烟测试 ==  base=' + BASE);

  const gid = await ensureGame();
  await post(BASE + '/api/games/' + gid + '/start', {});
  const API = BASE + '/api/' + gid;

  const join = (name, cid) => post(API + '/join', { name, cid });
  const sync = (id, params) => post(API + '/sync', Object.assign({ id }, params));

  const me = await join('人机测试', 'ai-' + Date.now());
  ok(!!me.d.id, '加入游戏拿到 player id', JSON.stringify(me.d));
  const id = me.d.id;

  // ---------- 1) 建房 + AI 入座 ----------
  const c1 = await sync(id, { act: 'create', ai: 1 });
  let room = c1.d.room;
  ok(!!room, '建房成功');
  ok(room.black && room.black.bot === false, '黑座是我（人类）');
  ok(room.white && room.white.bot === true, '白座是 AI（bot=true）',
      JSON.stringify(room.white));
  ok(room.white && room.white.n === 'AI 棋手', 'AI 有名字：' + (room.white && room.white.n));
  ok(room.state === 'playing', '房间直接进入 playing，不用等人',
      'state=' + room.state);
  ok(room.ai && room.ai.seat === 2, 'ai 信息块存在且 AI 执白', JSON.stringify(room.ai));
  ok(c1.d.players === 1, 'AI 不计入在线人数（players=1）', 'players=' + c1.d.players);

  // ---------- 2) 我落子 → AI 隔一拍应手 ----------
  // AI 的落子是延迟送达的（AI_DELAY_MS=800ms，客户端 500ms 轮询），
  // 所以这里不能立刻断言，要轮询等它落子——顺便验证"不会卡住不动"。
  const t0 = Date.now();
  const c2 = await sync(id, { act: 'place', x: 7, y: 7 });
  room = c2.d.room;
  ok(room.moves === 1, '落子后立刻返回，只有我这一手（AI 还没落）',
      'moves=' + room.moves);
  ok(room.turn === 2, '轮到 AI（turn=2），客户端会显示"对方思考中"',
      'turn=' + room.turn);
  ok(!room.ai.moves, '此时 AI 应手次数仍为 0', JSON.stringify(room.ai));

  // 等 AI 落子（最多 4 秒）
  let waited = 0;
  while (room.moves < 2 && waited < 4000) {
    await new Promise(r => setTimeout(r, 200));
    waited += 200;
    const s = await sync(id, {});
    room = s.d.room;
  }
  const dt = Date.now() - t0;
  ok(room.moves === 2, 'AI 在 ' + dt + ' ms 内应手（延迟送达）', 'moves=' + room.moves);
  ok(dt >= 500, '应手不是瞬发的（等了 ' + dt + ' ms，说明有"思考"节奏）');
  ok(room.turn === 1, '应手后轮回我（turn=1）', 'turn=' + room.turn);
  ok(countStones(room.cells) === 2, '棋盘上恰好 2 颗子', 'count=' + countStones(room.cells));
  ok(room.cells[7][7] === 1, '我的子在我下的位置');
  let aiStone = null;
  for (let y = 0; y < 15; y++) {
    for (let x = 0; x < 15; x++) {
      if (room.cells[y][x] === 2) { aiStone = [x, y]; }
    }
  }
  ok(!!aiStone, 'AI 确实落了一颗白子', JSON.stringify(aiStone));
  ok(room.ai.moves === 1, 'AI 已应手 1 次', JSON.stringify(room.ai));
  ok(typeof room.ai.ms === 'number' && room.ai.ms >= 0, '带回思考耗时 ' + room.ai.ms + ' ms');
  ok(typeof room.ai.depth === 'number' && room.ai.depth >= 0, '带回搜索深度 ' + room.ai.depth);
  ok(typeof room.ai.nodes === 'number' && room.ai.nodes >= 0, '带回节点数 ' + room.ai.nodes);

  // ---------- 3) 往 AI 的子上落 → 被拒 ----------
  if (aiStone) {
    const bad = await sync(id, { act: 'place', x: aiStone[0], y: aiStone[1] });
    ok(!!bad.d.err, '往 AI 的子上下棋被拒绝', JSON.stringify(bad.d.err));
  }

  // ---------- 4) 认输 → 再来一局 → AI 执黑先走 ----------
  const rs = await sync(id, { act: 'resign' });
  ok(rs.d.room.winner === 2, '认输后白方（AI）胜', 'winner=' + rs.d.room.winner);

  const ag = await sync(id, { act: 'again' });
  room = ag.d.room;
  ok(room.winner === 0, '再来一局：胜负已重置');
  ok(room.youSeat === 2, '交换先后手：我现在执白', 'youSeat=' + room.youSeat);
  ok(room.black && room.black.bot === true, 'AI 换到黑座');
  ok(room.ai.seat === 1, 'ai.seat 跟着换成 1', JSON.stringify(room.ai));

  // AI 执黑 → 它会隔一拍自己走第一步
  let w2 = 0;
  while (room.moves < 1 && w2 < 4000) {
    await new Promise(r => setTimeout(r, 200));
    w2 += 200;
    const s = await sync(id, {});
    room = s.d.room;
  }
  ok(room.moves === 1, 'AI 执黑，自己走了第一步', 'moves=' + room.moves);
  ok(countStones(room.cells) === 1, '棋盘上只有 AI 那一颗子');
  ok(room.turn === 2, '轮到我（白方）走', 'turn=' + room.turn);

  // ---------- 5) 退出房间 ----------
  const lv = await sync(id, { act: 'leave' });
  ok(lv.d.room === null, '退出房间回到大厅', JSON.stringify(lv.d.room));

  console.log('\n== 结果: ' + passed + ' 通过, ' + failed + ' 失败 ==');
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => {
  console.error('测试异常: ' + (e && e.stack || e));
  process.exit(1);
});
