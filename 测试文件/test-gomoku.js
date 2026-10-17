/* ============================================================
 * 五子棋对弈 冒烟测试（test-gomoku.js）
 *
 * 跑法：  node 测试文件/test-gomoku.js        （服务器要在 8080 跑着）
 *
 * 本脚本一次验证两件事：
 *   1. 「添加游戏」导入链路——读 D:\项目\实验-游戏添加功能 下的
 *      index.html / game.js，走 POST /api/games/import + /upload
 *      把它装进 gamemode/<新id>/（幂等：已有同名游戏就复用）；
 *   2. 五子棋服务端逻辑——建房/凭码加入/满员拒绝/轮次校验/五连判胜/
 *      认输/再来一局/多房间并行/退出房间。
 *
 * 测试会在世界上留下些痕迹（导入的游戏目录、可能的房间），
 * 适合在开发/自测服务器上跑。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:8080';
/** 素材目录。原先写死指向外部「D:\项目\实验-游戏添加功能」，那个目录后来被搬走，
 *  一旦游戏列表里没有五子棋（要重新导入）就会 ENOENT 挂掉。改成从项目内自动找：
 *  任意带 index.html + game.js + server/GomokuWorld.java 的游戏目录都行，
 *  优先 game.json 里名字带「五子棋」的。 */
function pickSrcDir() {
  const root = path.join(__dirname, '..', 'gamemode');
  let fallback = null;
  for (const d of fs.readdirSync(root)) {
    const dir = path.join(root, d);
    try { if (!fs.statSync(dir).isDirectory()) { continue; } } catch (e) { continue; }
    if (!fs.existsSync(path.join(dir, 'index.html'))
        || !fs.existsSync(path.join(dir, 'game.js'))
        || !fs.existsSync(path.join(dir, 'server', 'GomokuWorld.java'))) { continue; }
    let nm = '';
    try { nm = String(JSON.parse(fs.readFileSync(path.join(dir, 'game.json'), 'utf8')).name || ''); } catch (e) { /* 忽略 */ }
    if (nm.indexOf('五子棋') >= 0) { return dir; }
    if (!fallback) { fallback = dir; }
  }
  if (!fallback) { throw new Error('gamemode/ 下找不到带 server/GomokuWorld.java 的游戏目录'); }
  return fallback;
}
const SRC_DIR = pickSrcDir();
const GAME_NAME = '五子棋对弈';

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

/** 找已导入的「五子棋对弈」；没有就现导一个，返回它的游戏 id。 */
async function ensureGame() {
  const list = await (await fetch(BASE + '/api/games')).json();
  const found = (list.games || []).find(g => g.name === GAME_NAME);
  if (found) {
    console.log('  复用已导入的游戏 id=' + found.id);
    return found.id;
  }
  // 连同 server/ 下的自带服务端源码一起导入——内核会现场编译它，
  // 这就是「导入即用、不用重编 jar」的关键。
  const files = ['index.html', 'game.js', 'server/GomokuWorld.java'].map(n => ({
    name: n, buf: fs.readFileSync(path.join(SRC_DIR, ...n.split('/')))
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
  console.log('  导入完成 id=' + id);
  return id;
}

(async function () {
  console.log('== 五子棋对弈冒烟测试 ==  base=' + BASE);

  // ============ 0) 保证游戏存在且世界在跑 ============
  const gid = await ensureGame();
  const API = BASE + '/api/' + gid;

  const join = (name, cid) => post(API + '/join', { name, cid });
  const sync = (id, params) => post(API + '/sync', Object.assign({ id }, params));

  let r = await post(BASE + '/api/games/' + gid + '/start', {});
  ok(r.status === 200 || (r.status === 409 && r.d && /运行/.test(r.d.error || '')),
     '启动五子棋世界（或已在运行）', r.status + ' ' + JSON.stringify(r.d));

  const info = await (await fetch(API + '/info')).json();
  ok(info.board === 15, 'info 返回 15 路棋盘', JSON.stringify(info));

  // ============ 1) 三人入场 ============
  const A = (await join('甲', 'cidA')).d;
  const B = (await join('乙', 'cidB')).d;
  const C = (await join('丙', 'cidC')).d;
  ok(A && A.id && B && B.id && C && C.id && A.id !== B.id, '三个人各自拿到 id');

  // 同 cid 复用
  const A2 = (await join('甲', 'cidA')).d;
  ok(A2 && A2.id === A.id, '同 cid 重进复用同一个 id');

  let s = (await sync(A.id, {})).d;
  ok(s && s.room === null, '刚进来时在大厅（room=null）');

  // ============ 2) 建房 / 凭码加入 / 满员拒绝 ============
  s = (await sync(A.id, { act: 'create' })).d;
  ok(s.room && /^[A-Z0-9]{4}$/.test(s.room.code), '甲创建房间，拿到 4 位房间码',
     s.room && s.room.code);
  ok(s.room.state === 'waiting', '只有一人时房间状态 = waiting');
  ok(s.room.youSeat === 1, '房主执黑（seat=1）');
  const code = s.room.code;

  s = (await sync(B.id, { act: 'join', room: code })).d;
  ok(s.room && s.room.white && s.room.white.id === B.id, '乙凭房间码加入，坐白');
  ok(s.room.state === 'playing', '两人到齐后状态 = playing');
  ok(s.err === null, '乙加入没有报错');

  s = (await sync(C.id, { act: 'join', room: code })).d;
  ok(s.room === null && s.err && /满/.test(s.err), '丙加入已满的房间被拒绝（限定两人）',
     s.err);

  // 房间码大小写/空白容错
  s = (await sync(C.id, { act: 'join', room: ' ' + code.toLowerCase() + ' ' })).d;
  ok(s.room === null && s.err && /满/.test(s.err), '房间码大小写与空格被容错归一');

  s = (await sync(C.id, { act: 'join', room: 'ZZZZ' })).d;
  ok(s.room === null && s.err && /不存在/.test(s.err), '不存在的房间码 → 报错', s.err);

  s = (await sync(C.id, { act: 'join', room: 'AB' })).d;
  ok(s.room === null && s.err && /4 位/.test(s.err), '房间码长度不对 → 报错', s.err);

  // ============ 3) 轮次与合法性 ============
  s = (await sync(A.id, {})).d;
  ok(s.room.turn === 1, '开局轮到黑方（甲）');

  s = (await sync(B.id, { act: 'place', x: 5, y: 5 })).d;
  ok(s.err && /黑方/.test(s.err), '不是自己的回合落子被拒', s.err);

  s = (await sync(A.id, { act: 'place', x: 20, y: 3 })).d;
  ok(s.err && /超出/.test(s.err), '越界落子被拒', s.err);

  // 黑 (7,7)
  s = (await sync(A.id, { act: 'place', x: 7, y: 7 })).d;
  ok(s.err === null && s.room.cells[7][7] === 1 && s.room.turn === 2,
     '黑落子 (7,7) 成功，轮到白');

  s = (await sync(B.id, { act: 'place', x: 7, y: 7 })).d;
  ok(s.err && /已经有子/.test(s.err), '往已占格落子被拒', s.err);

  // ============ 4) 黑连五取胜 ============
  // 甲(黑) 7,7 → 8,7 → 9,7 → 10,7 → 11,7；乙(白) 在下边陪走
  const blackMoves = [[8, 7], [9, 7], [10, 7], [11, 7]];
  const whiteMoves = [[0, 0], [0, 1], [0, 2], [0, 3]];
  for (let i = 0; i < blackMoves.length; i++) {
    let rr = await sync(B.id, { act: 'place', x: whiteMoves[i][0], y: whiteMoves[i][1] });
    if (rr.d.err) { ok(false, '白陪走 ' + whiteMoves[i], rr.d.err); break; }
    rr = await sync(A.id, { act: 'place', x: blackMoves[i][0], y: blackMoves[i][1] });
    if (rr.d.err) { ok(false, '黑第 ' + (i + 2) + ' 手', rr.d.err); break; }
  }
  s = (await sync(A.id, {})).d;
  ok(s.room.winner === 1, '黑连成 5 子（横线 y=7, x=7..11）判黑胜', 'winner=' + s.room.winner);
  ok(Array.isArray(s.room.win) && s.room.win.length >= 5, '返回获胜连线（客户端高亮用）',
     s.room.win && s.room.win.length);

  s = (await sync(B.id, {})).d;
  ok(s.room.winner === 1 && s.room.youSeat === 2, '白方视角也看到黑胜、自己执白');

  s = (await sync(A.id, { act: 'place', x: 3, y: 3 })).d;
  ok(s.err && /结束/.test(s.err), '对局已结束后不能继续落子', s.err);

  // ============ 5) 再来一局（清盘 + 换先后手）============
  s = (await sync(A.id, { act: 'again' })).d;
  ok(s.err === null && s.room.moves === 0 && s.room.winner === 0, '再来一局：棋盘清空');
  ok(s.room.black && s.room.black.id === B.id, '再来一局后甲乙交换（乙执黑先手）',
     s.room.black && s.room.black.n);
  ok(s.room.youSeat === 2, '甲换到白方（seat=2）');

  // ============ 6) 认输 ============
  s = (await sync(A.id, { act: 'resign' })).d;   // 甲现在执白，认输 → 黑胜
  ok(s.err === null && s.room.winner === 1, '白方认输 → 黑胜', 'winner=' + s.room.winner);

  // ============ 7) 多房间并行、互不干扰 ============
  await sync(A.id, { act: 'leave' });
  await sync(B.id, { act: 'leave' });

  const r1 = (await sync(A.id, { act: 'create' })).d.room.code;
  const r2 = (await sync(C.id, { act: 'create' })).d.room.code;
  ok(r1 && r2 && r1 !== r2, '甲、丙各开一个房间，拿到不同房间码', r1 + ' vs ' + r2);

  // 乙加入甲的房间 → 满员，甲（黑）即可落子
  s = (await sync(B.id, { act: 'join', room: r1 })).d;
  ok(s.room && s.room.code === r1 && s.room.white && s.room.white.id === B.id,
     '乙凭房间码加入甲的房间');

  s = (await sync(A.id, { act: 'place', x: 7, y: 7 })).d;
  ok(s.err === null && s.room.moves === 1, '甲在自己房间落子成功');

  const sC = (await sync(C.id, {})).d;
  ok(sC.room.moves === 0 && sC.room.state === 'waiting',
     '丙的另一个房间不受影响（多房间独立）', 'moves=' + sC.room.moves);

  // 已在房间时加入别的房间 / 再建房 → 都被拒
  s = (await sync(B.id, { act: 'join', room: r2 })).d;
  ok(s.err && /别的房间/.test(s.err), '已在房间时加入别的房间被拒', s.err);
  s = (await sync(A.id, { act: 'create' })).d;
  ok(s.err && /已经在房间/.test(s.err), '已在房间时再创建被拒', s.err);

  // ============ 8) 收尾 ============
  s = (await sync(A.id, { act: 'leave' })).d;
  ok(s.room === null, '甲退出自己的房间');
  await sync(B.id, { act: 'leave' });
  await sync(C.id, { act: 'leave' });
  const info2 = await (await fetch(API + '/info')).json();
  ok(typeof info2.rooms === 'number' && typeof info2.players === 'number',
     'info 返回房间数与在线人数', JSON.stringify(info2));

  console.log('== 结果: ' + passed + ' 通过, ' + failed + ' 失败 ==');
  process.exit(failed ? 1 : 0);
})().catch(function (e) {
  console.error('测试脚本异常: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
