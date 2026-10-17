/* ============================================================
 * 游戏删除功能测试（test-delete.js）
 *
 * 跑法：  node 测试文件/test-delete.js        （服务器要在 8080 跑着）
 *
 * 自己导入一个「临时游戏」（借实验文件夹的五子棋），然后验证：
 *   - 有玩家时删除被拒绝（409，先让玩家退）
 *   - 玩家走了以后能删（会先把运行中的世界停掉）
 *   - 删完列表里没有了、目录也没了
 *   - 重复删 / 删不存在 → 404
 *
 * ⚠️ 不测内置游戏（tank/snake2）的删除，避免把项目自带的游戏删掉。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:8080';
/** 导入用的素材目录。原先写死指向外部「D:\项目\实验-游戏添加功能」，
 *  那个目录后来被搬走，测试直接 ENOENT 挂掉。改成从项目内自动找：
 *  任意一个带 index.html + game.js + server/GomokuWorld.java 的游戏目录都行
 *  （五子棋优先——它是导入进来的，跟内置游戏不重名）。 */
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

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (extra ? '  -- ' + extra : '')); }
}

async function post(url, params) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params || {}).toString()
  });
  let d = null;
  try { d = await r.json(); } catch (e) { /* 忽略 */ }
  return { status: r.status, d };
}

/** 导入一份临时游戏（带 server/ 源码，这样世界能真的启起来）。 */
async function importCopy() {
  const files = ['index.html', 'game.js', 'server/GomokuWorld.java'].map(n => ({
    name: n, buf: fs.readFileSync(path.join(SRC_DIR, ...n.split('/')))
  }));
  const r = await fetch(BASE + '/api/games/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: '删除测试用临时游戏',
      desc: '只用于验证删除功能',
      icon: '\uD83D\uDDD1',
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

(async function () {
  console.log('== 游戏删除功能测试 ==  base=' + BASE);

  // 1) 导入临时游戏
  const gid = await importCopy();
  ok(!!gid, '导入一个临时游戏用于删除测试', gid);

  let list = await (await fetch(BASE + '/api/games')).json();
  ok(list.games.some(g => g.id === gid), '列表里能看到它');

  // 2) 启动世界
  let r = await post(BASE + '/api/games/' + gid + '/start', {});
  ok(r.status === 200, '启动它的世界', r.status + ' ' + JSON.stringify(r.d));

  // 3) 有玩家时删除被拒绝
  const j = (await post(BASE + '/api/' + gid + '/join', { name: '占位', cid: 'delcid1' })).d;
  ok(j && j.id, '一个玩家 join 进去', JSON.stringify(j));
  r = await post(BASE + '/api/games/' + gid + '/delete', {});
  ok(r.status === 409, '有玩家时删除被拒绝（409）', r.status + ' ' + JSON.stringify(r.d));

  // 4) 玩家退出后可以删（会先把世界停掉）
  await post(BASE + '/api/' + gid + '/leave', { id: j.id });
  r = await post(BASE + '/api/games/' + gid + '/delete', {});
  ok(r.status === 200, '玩家走了以后删除成功（200）', r.status + ' ' + JSON.stringify(r.d));

  // 5) 列表里没了
  list = await (await fetch(BASE + '/api/games')).json();
  ok(!list.games.some(g => g.id === gid), '列表里已经看不到它');

  // 6) 游戏目录也没了
  const idx = await fetch(BASE + '/games/' + gid + '/');
  ok(idx.status === 404, '游戏目录已删除（/games/<id>/ → 404）', 'got ' + idx.status);

  // 7) 再删一次 → 404
  r = await post(BASE + '/api/games/' + gid + '/delete', {});
  ok(r.status === 404, '重复删除 → 404', r.status + ' ' + JSON.stringify(r.d));

  // 8) 删不存在的 → 404
  r = await post(BASE + '/api/games/nosuchgame/delete', {});
  ok(r.status === 404, '删不存在的游戏 → 404', r.status + ' ' + JSON.stringify(r.d));

  // 9) GET 不该能删（方法校验）
  const g = await fetch(BASE + '/api/games/' + gid + '/delete');
  ok(g.status === 405 || g.status === 404, 'GET 删除接口被拒（405/404）', 'got ' + g.status);

  console.log('  （不测内置游戏 tank/snake2 的删除，避免破坏项目自带内容）');
  console.log('== 结果: ' + passed + ' 通过, ' + failed + ' 失败 ==');
  process.exit(failed ? 1 : 0);
})().catch(function (e) {
  console.error('测试脚本异常: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
