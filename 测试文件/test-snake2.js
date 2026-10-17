/* ============================================================
 * 联机贪吃蛇 服务端冒烟测试（test-snake2.js）
 *
 * 跑法：  node 测试文件/test-snake2.js [baseUrl]
 * 默认打 http://127.0.0.1:8080（服务器得先起着）。
 *
 * 断言覆盖：
 *   1. join 返回 id 与世界尺寸
 *   2. 快照结构（me / snakes / foods / board）
 *   3. 双玩家互见
 *   4. 非法方向容错（服务端不炸）
 *   5. 固定方向必死（撞墙/撞物）+ 死亡计数
 *   6. 约 3 秒后复活、身长重置
 *   7. 同 cid 重join 身份复用
 *   8. leave 后从世界消失
 *
 * 注意：本测试会真的在世界里撞死一条蛇、留下几颗尸体果实，
 * 适合在没有真玩家时跑（开发/自测服务器）。
 *
 * 2026-10-14 起：联机版不再随服务器自启（房主在启动器里拨开关），
 * 所以开头先以房主身份 POST /api/games/snake2/start。
 * ============================================================ */
'use strict';

const BASE = process.argv[2] || 'http://127.0.0.1:8080';

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (extra ? '  -- ' + extra : '')); }
}

function post(path, params) {
  return fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    cache: 'no-store'
  }).then(function (r) { return r.json(); });
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

(async function () {
  console.log('== 联机贪吃蛇冒烟测试 ==  base=' + BASE);

  // ---- 0) 联机版默认不开；测试里以房主身份先启动 ----
  // 先停一次，避免"上一次遗留 / 手动开过"导致 start 返回 {"error":"已经在运行了"}，
  // 这样断言才是真的在验"房主能启"，而不是被环境状态左右。
  await post('/api/games/snake2/stop', {});
  const st = await post('/api/games/snake2/start', {});
  ok(!!st && st.ok === true, '房主可以启动贪吃蛇联机版（默认不开）', JSON.stringify(st));

  // ---- 1) join A ----
  const a = await post('/api/snake2/join', { name: '测试甲', cid: 'testcidA' });
  ok(!!a.id, 'join A 返回 id', JSON.stringify(a));
  ok(a.w === 60 && a.h === 40 && a.cell === 32, 'join A 返回世界尺寸 60x40x32');

  // ---- 2) join B ----
  const b = await post('/api/snake2/join', { name: '测试乙', cid: 'testcidB' });
  ok(!!b.id && b.id !== a.id, 'join B 返回不同 id');

  // ---- 3) sync A：快照结构 ----
  const s1 = await post('/api/snake2/sync', { id: a.id, d: -1, ev: 0, e: '' });
  ok(s1.you === a.id, 'sync you = 我');
  ok(!!s1.me && s1.me.alive === true && s1.me.len === 3, '初始 3 节且存活', JSON.stringify(s1.me));
  ok(Array.isArray(s1.snakes) && s1.snakes.length === 2, '快照里有 2 条蛇');
  const mySnake = s1.snakes.find(function (s) { return s.id === a.id; });
  ok(!!mySnake && mySnake.b.length === 3 && mySnake.b.every(function (c) { return c.length === 2; }),
     '蛇身是 [[x,y],...] 紧凑格式');
  ok(Array.isArray(s1.foods) && s1.foods.length >= 20, '场上至少 20 颗果实', 'got ' + (s1.foods && s1.foods.length));
  ok(Array.isArray(s1.board) && s1.board.length === 2, '排行榜 2 人');

  // ---- 4) B 也能看到 A ----
  const s2 = await post('/api/snake2/sync', { id: b.id, d: -1, ev: 0, e: '' });
  ok(s2.snakes.some(function (s) { return s.id === a.id; }), 'B 的快照里能看到 A');

  // ---- 5) 非法方向容错 ----
  const s3 = await post('/api/snake2/sync', { id: a.id, d: 7, ev: 0, e: '' });
  ok(!!s3.me, '非法方向 d=7 不炸服务端');
  const s3b = await post('/api/snake2/sync', { id: a.id, d: -5, ev: 0, e: '' });
  ok(!!s3b.me, '非法方向 d=-5 不炸服务端');

  // ---- 6) 沿当前方向一路冲，必死 ----
  // 地图 60×40：蛇出生位置随机，若它出生在离墙最远的地方、又正好朝那面墙，
  // 最坏要 60 格 × 150ms = 9 秒才撞墙。等待窗口要给足（200×60ms ≈ 13 秒），
  // 否则会偶发「还没撞墙就被判失败」——这不是服务端 bug，是测试等待太短。
  let dead = false, deaths = 0, lastMe = null;
  const dir = mySnake.d;
  for (let i = 0; i < 200 && !dead; i++) {
    const s = await post('/api/snake2/sync', { id: a.id, d: dir, ev: 0, e: '' });
    lastMe = s.me;
    if (s.me && !s.me.alive) { dead = true; deaths = s.me.deaths; }
    await sleep(60);
  }
  ok(dead, '固定方向最终阵亡（撞墙/撞物）', 'lastMe=' + JSON.stringify(lastMe));
  ok(deaths >= 1, '死亡计数 +1', 'deaths=' + deaths);

  // ---- 7) 约 3 秒后复活 ----
  let revived = false;
  for (let i = 0; i < 40 && !revived; i++) {
    const s = await post('/api/snake2/sync', { id: a.id, d: -1, ev: 0, e: '' });
    if (s.me && s.me.alive && s.me.len === 3) { revived = true; }
    await sleep(200);
  }
  ok(revived, '阵亡约 3 秒后复活（身长重置为 3）');

  // ---- 8) cid 身份复用 ----
  const a2 = await post('/api/snake2/join', { name: '测试甲', cid: 'testcidA' });
  ok(a2.id === a.id, '同 cid 重join 复用同一 id', a.id + ' vs ' + a2.id);

  // ---- 9) leave 后消失 ----
  await post('/api/snake2/leave', { id: a2.id });
  const s4 = await post('/api/snake2/sync', { id: b.id, d: -1, ev: 0, e: '' });
  ok(!s4.snakes.some(function (s) { return s.id === a.id; }), 'leave 后 A 从别人的快照里消失');
  await post('/api/snake2/leave', { id: b.id });

  const s5 = await post('/api/snake2/sync', { id: b.id, d: -1, ev: 0, e: '' });
  ok(!s5.me, '已 leave 的 id 再 sync 得到 me=null');

  console.log('== 结果: ' + passed + ' 通过, ' + failed + ' 失败 ==');
  process.exit(failed ? 1 : 0);
})().catch(function (e) {
  console.error('测试脚本异常: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
