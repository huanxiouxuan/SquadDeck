/* ============================================================
 * 游戏启停开关 冒烟测试（test-toggle.js）
 *
 * 跑法：  node 测试文件/test-toggle.js [baseUrl]
 * 默认打 http://127.0.0.1:8080（服务器得先起着）。
 *
 * 覆盖：
 *   1. /api/games 带 host / srv / run 字段，坦克默认启动
 *   2. 未启动时 join / info 返回 409
 *   3. 房主 start / stop 生命周期（重复启动、没在跑时停 → 409）
 *   4. 有玩家时 stop 被拒绝；退干净后能停
 *   5. 静态游戏 / 不存在的游戏启停 → 404
 *   6. GET 启停 → 405（必须 POST）
 *   7. 停了再启 = 全新世界
 *
 * 覆盖不到的两条（代码已写、需特定环境）：
 *   - 非房主拨开关 → 403：本机任意来源 IP 都是“本机网卡”，
 *     只能从另一台电脑连进来才能测；
 *   - 同时启动上限 → 409 LIMIT：需要 5 个以上声明了 world 的游戏。
 *
 * 注意：本测试会独占 snake2 世界的启停，适合在没有真玩家时跑。
 * ============================================================ */
'use strict';

const BASE = process.argv[2] || 'http://127.0.0.1:8080';

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (extra ? '  -- ' + extra : '')); }
}

function req(path, method, params) {
  return fetch(BASE + path, {
    method: method,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: method === 'POST' ? new URLSearchParams(params || {}).toString() : undefined,
    cache: 'no-store'
  }).then(async function (r) {
    let d = null;
    try { d = await r.json(); } catch (e) { d = null; }
    return { status: r.status, d: d };
  });
}
const post = function (p, q) { return req(p, 'POST', q); };
const get = function (p) { return req(p, 'GET'); };

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

(async function () {
  console.log('== 启停开关冒烟测试 ==  base=' + BASE);

  // ---- 1) 列表字段 ----
  const g = await get('/api/games');
  ok(!!g.d && g.d.host === true, '本机请求 host=true（房主）');
  const games = (g.d && g.d.games) || [];
  const tank = games.find(function (x) { return x.id === 'tank'; });
  const snk = games.find(function (x) { return x.id === 'snake2'; });
  const snk1 = games.find(function (x) { return x.id === 'snake'; });
  ok(!!tank && tank.srv === true && tank.run === true, '坦克：有服务端且默认启动', JSON.stringify(tank));
  ok(!!snk && snk.srv === true, '贪吃蛇联机版：有服务端世界');
  ok(!!snk1 && snk1.srv === false, '单机贪吃蛇：没有服务端（启动器里也没有开关）');

  // ---- 2) 先确保 snake2 是停的（可能被上个测试启动着）----
  let r = await post('/api/games/snake2/stop', {});
  ok(r.status === 200 || (r.status === 409 && r.d && r.d.error === '还没有在运行'),
     '开头先停 snake2（或确认没在跑）', r.status + ' ' + JSON.stringify(r.d));

  // ---- 3) 没启动时打游戏接口 → 409 ----
  r = await post('/api/snake2/join', { name: '开关测试', cid: 'togglecid' });
  ok(r.status === 409, '未启动时 join → 409', r.status + ' ' + JSON.stringify(r.d));
  r = await get('/api/snake2/info');
  ok(r.status === 409, '未启动时 info → 409', r.status + ' ' + JSON.stringify(r.d));

  // ---- 4) 没在跑时 stop → 409 not running ----
  r = await post('/api/games/snake2/stop', {});
  ok(r.status === 409 && r.d && r.d.error === '还没有在运行', '没在跑时 stop → 409 还没有在运行');

  // ---- 5) 房主启动 + 重复启动 ----
  r = await post('/api/games/snake2/start', {});
  ok(r.status === 200 && r.d && r.d.ok === true, '房主启动 snake2', r.status + ' ' + JSON.stringify(r.d));
  r = await post('/api/games/snake2/start', {});
  ok(r.status === 409 && r.d && r.d.error === '已经在运行了', '重复启动 → 409 已经在运行了');

  // ---- 6) 启动后 join / sync 正常 ----
  const j = await post('/api/snake2/join', { name: '开关测试', cid: 'togglecid' });
  ok(!!j.d && !!j.d.id, '启动后 join 正常');
  const s = await post('/api/snake2/sync', { id: j.d.id, d: -1, ev: 0, e: '' });
  ok(!!s.d && s.d.you === j.d.id, '启动后 sync 正常');

  // ---- 7) 有玩家时 stop 被拒绝 ----
  r = await post('/api/games/snake2/stop', {});
  ok(r.status === 409 && /玩家/.test((r.d && r.d.error) || ''), '有玩家时 stop 被拒绝（409）',
     r.status + ' ' + JSON.stringify(r.d));

  // ---- 8) 退干净后能停 ----
  await post('/api/snake2/leave', { id: j.d.id });
  r = await post('/api/games/snake2/stop', {});
  ok(r.status === 200 && r.d && r.d.ok === true, '玩家退干净后 stop 成功');

  // ---- 9) 静态游戏 / 不存在的游戏 → 404 ----
  r = await post('/api/games/snake/start', {});
  ok(r.status === 404, '单机贪吃蛇（无世界）start → 404', r.status + ' ' + JSON.stringify(r.d));
  r = await post('/api/games/nope/start', {});
  ok(r.status === 404, '不存在的游戏 start → 404');
  r = await post('/api/games/tank/stop', {});
  ok(r.status === 409 && /玩家/.test((r.d && r.d.error) || '') || r.status === 200,
     '坦克（autostart 世界）也能被房主停', r.status + ' ' + JSON.stringify(r.d));
  // 坦克若被停掉了，拉起来，别影响后面的测试
  const tankRun = (await get('/api/games')).d.games.find(function (x) { return x.id === 'tank'; });
  if (!tankRun.run) {
    r = await post('/api/games/tank/start', {});
    ok(r.status === 200, '坦克重新启动', r.status + ' ' + JSON.stringify(r.d));
  }

  // ---- 10) GET 启停 → 405 ----
  r = await get('/api/games/snake2/start');
  ok(r.status === 405, 'GET start → 405（必须 POST）', r.status + ' ' + JSON.stringify(r.d));

  // ---- 11) 停了再启 = 全新世界 ----
  r = await post('/api/games/snake2/start', {});
  ok(r.status === 200, '重新启动成功');
  const j2 = await post('/api/snake2/join', { name: '开关测试二', cid: 'togglecid2' });
  ok(!!j2.d && !!j2.d.id, '重开后 join 正常');
  await post('/api/snake2/leave', { id: j2.d.id });
  r = await post('/api/games/snake2/stop', {});
  ok(r.status === 200, '收尾：停掉 snake2');

  console.log('== 结果: ' + passed + ' 通过, ' + failed + ' 失败 ==');
  process.exit(failed ? 1 : 0);
})().catch(function (e) {
  console.error('测试脚本异常: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
