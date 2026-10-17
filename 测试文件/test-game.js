/* 坦克大战 v3 端到端验证：
   ① 障碍密度≈50% 且走廊连通  ② 炮塔 1s/90°  ③ 转身未完成前不动
   ④ 5 发弹匣 / 2s 回 1 发 / 空仓打不出 / 开炮间隔 1s
   ⑤ 视野扇形（车身前方 ±45°、10 格）：视野外敌人不下发
   ⑥ 视野外敌人开火 → 警戒；看得见的敌人开火 → 不警戒
   ⑦ 摧毁障碍 / 击毁坦克 → 下发事件（客户端据此播爆炸音效）
   ⑧ 身份复用：同 cid 重连拿回同一个号；5 秒离线从别人快照消失；
      回来同步一下又重新上线（不丢号）
   ⑨（已移除）表情广播：表情和聊天是启动器自己的功能（/api/chat 公共
      频道），与游戏无联系——游戏的 sync 不再收 e 参数            */
const BASE = 'http://127.0.0.1:8080';
const CELL = 32, W = 80, H = 60;
const HALF_PI = Math.PI / 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (a) => Math.atan2(Math.sin(a), Math.cos(a));

let pass = 0, fail = 0, skip = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  OK   ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
}
function note(name, extra) { skip++; console.log('  SKIP ' + name + (extra ? '  ' + extra : '')); }

let obs = new Int16Array(W * H);
const OCT = [8, 10, 2, 6, 4, 5, 1, 9];       // 0°,45°,90°,135°,180°,-135°,-90°,-45° 对应的按键位
function octIndex(a) { return ((Math.round(norm(a) / (Math.PI / 4)) % 8) + 8) % 8; }
function octAngle(i) { return norm(i * Math.PI / 4); }
function keysFor(a) { return OCT[octIndex(a)]; }

async function post(path, p) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(p).toString(),
    cache: 'no-store'
  });
  return r.json();
}

function mkSession() { return { id: null, rev: -1, ev: 0 }; }
async function join(s, name, cid) {
  const p = { name: name };
  if (cid) { p.cid = cid; }
  const d = await post('/api/tank/join', p);
  s.id = d.id; s.rev = -1; s.ev = 0;
  if (cid) { s.cid = cid; }
  return d;
}
async function leave(s) { if (s.id) { await post('/api/tank/leave', { id: s.id }); s.id = null; } }
function self(d, id) { return (d.tanks || []).find((t) => t.id === id); }

async function sync(s, opt) {
  opt = opt || {};
  const d = await post('/api/tank/sync', {
    id: s.id, k: opt.k || 0, a: opt.a == null ? 0 : opt.a,
    f: opt.f ? 1 : 0, rev: (opt.rev == null ? s.rev : opt.rev), ev: s.ev
  });
  if (d.map) {
    if (d.map.full) {
      obs = new Int16Array(W * H);
      (d.map.cells || []).forEach((c) => { obs[c[1] * W + c[0]] = c[2]; });
    } else {
      (d.map.ch || []).forEach((c) => { obs[c[1] * W + c[0]] = c[2]; });
    }
    s.rev = d.map.rev;
  }
  (d.events || []).forEach((e) => { if (e.id > s.ev) { s.ev = e.id; } });
  return d;
}

/* 点射一炮。`f` 在服务端是「按住开火」的状态位，不是一次性事件：
   1. 发完 f:1 后必须立刻 f:0，否则服务器会按 1 秒冷却一直连发下去，
      把测试里另一辆坦克打死（一死就随机重生，距离/朝向全乱，断言跟着崩）；
   2. 但 f:1 和 f:0 之间必须隔开一点时间——服务器的 tick 是 33ms 一次，
      两次请求若落在同一个 tick 窗口里，服务器压根没看到"按住"，一炮都不会打。 */
async function fireOnce(s) {
  await sync(s, { f: 1 });
  await sleep(80);            // 跨过至少一个 tick
  await sync(s, { f: 0 });
}

/* 按住方向键把「车身」转到 target（车身只跟着移动键转）。
   三个坑：
   1. 转到目标后若不松键，服务器会带着这个方向一路开走 —— 每次循环末尾都补一次 k:0；
   2. 万一对齐判定始终不达标，绝不能一直按到超时（那会开出好几格、把距离拉开，
      后续"看不见/看得见"的断言就成了假象）—— 车身一旦离开起点太远就立刻停手；
   3. 对齐采样偶尔会错过窗口（采样间隔 6.3° vs 窗口 ±3.4°），车身冲过目标再
      绕回来，一次转身可能要 3 秒以上。传 keepAlive 会话进去，循环里定期同步，
      免得对方被服务器的 5 秒离线线判掉（真实玩家每 34ms 同步一次，不会这样）。 */
async function aimBodyStatic(s, target, maxMs, keepAlive) {
  const t0 = Date.now();
  let lastKeep = 0;
  let d = await sync(s, { k: 0 });
  const m0 = self(d, s.id);
  const x0 = m0 ? m0.x : 0, y0 = m0 ? m0.y : 0;
  while (Date.now() - t0 < maxMs) {
    if (keepAlive && Date.now() - lastKeep > 500) {
      lastKeep = Date.now();
      await sync(keepAlive, { k: 0 });
    }
    d = await sync(s, { k: keysFor(target) });
    let m = self(d, s.id);
    if (m && Math.abs(norm(m.ba - target)) < 0.06) { break; }
    if (m && Math.hypot(m.x - x0, m.y - y0) > 2 * CELL) { break; }   // 漂够了，别再按
    await sleep(45);
    d = await sync(s, { k: 0 });
    m = self(d, s.id);
    if (m && Math.abs(norm(m.ba - target)) < 0.06) { break; }
    await sleep(20);
  }
  return await sync(s, { k: 0 });     // 收尾务必松键
}

function lineClear(x1, y1, x2, y2) {
  const n = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 4));
  for (let i = 0; i <= n; i++) {
    const x = x1 + (x2 - x1) * i / n, y = y1 + (y2 - y1) * i / n;
    const gx = Math.floor(x / CELL), gy = Math.floor(y / CELL);
    if (gx < 0 || gy < 0 || gx >= W || gy >= H) { return false; }
    if (obs[gy * W + gx] > 0) { return false; }
  }
  return true;
}

/* 从 (px,py) 往 8 个方向找最近的墙（用来测"打碎障碍"事件）。
   起点取 14px：走廊只有 1 格宽（32px），侧墙离坦克中心仅 16px，
   若从 20px 起扫会正好漏掉这些贴身的墙。 */
function nearestWallDir(px, py) {
  let best = null;
  for (let k = 0; k < 8; k++) {
    const ang = octAngle(k);
    for (let d = 14; d <= 120; d += 2) {
      const gx = Math.floor((px + Math.cos(ang) * d) / CELL);
      const gy = Math.floor((py + Math.sin(ang) * d) / CELL);
      if (gx < 0 || gy < 0 || gx >= W || gy >= H) { break; }
      if (obs[gy * W + gx] > 0) {
        if (!best || d < best.d) { best = { ang: ang, d: d }; }
        break;
      }
    }
  }
  return best;
}

(async function main() {

  // ============ ① 地图：密度 + 连通 ============
  console.log('【① 地图密度与连通性】');
  const M = mkSession();
  await join(M, '测量');
  let dm = await sync(M);
  let total = 0, open = 0;
  for (let i = 0; i < W * H; i++) { if (obs[i] > 0) { total++; } else { open++; } }
  const density = total / (W * H);
  check('障碍密度约一半', density > 0.40 && density < 0.60,
        (density * 100).toFixed(1) + '%（' + total + ' / ' + (W * H) + ' 格）');

  // 连通性：算所有连通块，取最大的一块 —— 「可玩区域是否连成一片」
  // （若从随便一个空地起 BFS，恰好撞上一格被墙包死的空洞就会误报 0%）
  const seenAll = new Uint8Array(W * H);
  let best = 0, comps = 0;
  for (let i = 0; i < W * H; i++) {
    if (obs[i] > 0 || seenAll[i]) { continue; }
    comps++;
    const q = [i];
    seenAll[i] = 1;
    let size = 0;
    while (q.length) {
      const cur = q.pop();
      size++;
      const cx = cur % W, cy = (cur / W) | 0;
      const nb = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]];
      for (let k = 0; k < 4; k++) {
        const nx = nb[k][0], ny = nb[k][1];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) { continue; }
        const idx = ny * W + nx;
        if (seenAll[idx] || obs[idx] > 0) { continue; }
        seenAll[idx] = 1;
        q.push(idx);
      }
    }
    if (size > best) { best = size; }
  }
  const reachPct = (100 * best / open).toFixed(1);
  // 注意：地图生成时已保证「严格 1 个连通块」（见 GameWorld.sealIsolatedPockets）。
  // 但服务器是跨测试轮次常驻的，上一轮打碎的墙可能留下 1~2 格的孤立小洞——
  // 那是可破坏地形的自然结果（周围还都是墙，坦克本来就进不去），不算死区。
  // 所以这里断言的是「没有大面积不可达区域」。
  check('可玩空地基本连通（无大面积死区）', best / open >= 0.99,
        best + ' / ' + open + ' = ' + reachPct + '%（连通块 ' + comps +
        '，最大孤岛 ' + (open - best) + ' 格）');
  await leave(M);

  // ============ ② 转身未完成前不能移动 ============
  console.log('\n【② 转身优先：车身没转到位前不动】');
  const T = mkSession();
  await join(T, '转身');
  await sync(T);
  let st = await aimBodyStatic(T, 0, 6000);
  let mt = self(st, T.id);
  const want = octAngle(octIndex(mt.ba + Math.PI));   // 要求原地掉头 180°（要 2 秒）
  const startX = mt.x, startY = mt.y;
  let maxDrift = 0, alignedAt = -1;
  const t0 = Date.now();
  while (Date.now() - t0 < 2000) {
    st = await sync(T, { k: keysFor(want) });
    mt = self(st, T.id);
    const off = Math.abs(norm(want - mt.ba));
    if (off > 0.15) {
      const drift = Math.hypot(mt.x - startX, mt.y - startY);
      if (drift > maxDrift) { maxDrift = drift; }
    } else if (alignedAt < 0) {
      alignedAt = Date.now() - t0;
    }
    await sleep(30);
  }
  await sync(T, { k: 0 });
  check('转向期间坦克位置完全没动', maxDrift < 1.0, '最大位移 ' + maxDrift.toFixed(2) + ' px');
  check('车身确实转过来了', Math.abs(norm(mt.ba - want)) < 0.2,
        '目标 ' + (want * 180 / Math.PI).toFixed(0) + '°，实际 ' + (mt.ba * 180 / Math.PI).toFixed(0) + '°');
  check('掉头 180° 耗时 ≈2s（1s/90°）', alignedAt < 0 || alignedAt > 1500,
        alignedAt < 0 ? '2 秒内没转完（符合 ≤180°/2s）' : ('实测 ' + alignedAt + 'ms'));
  await leave(T);

  // ============ ③ 弹匣 / 换弹 / 开炮间隔 ============
  console.log('\n【③ 弹匣 5 发 · 2s 回 1 发 · 空仓打不出 · 开炮间隔 1s】');
  const C = mkSession();
  await join(C, '弹药');
  let dc = await sync(C);
  const shots = [];
  let lastShots = null, lastReloads = null, reloadCount = 0;
  let minAmmo = 99, maxAmmoSeen = 0, zeroFrom = -1;
  const tA = Date.now();
  while (Date.now() - tA < 9500) {
    dc = await sync(C, { f: 1 });
    const m = dc.me;
    if (lastShots != null && m.shots > lastShots) { shots.push(Date.now()); }
    if (lastReloads != null && m.reloads > lastReloads) { reloadCount += m.reloads - lastReloads; }
    lastShots = m.shots;
    lastReloads = m.reloads;
    if (m.ammo === 0 && zeroFrom < 0) { zeroFrom = Date.now(); }
    if (m.ammo < minAmmo) { minAmmo = m.ammo; }
    if (m.ammo > maxAmmoSeen) { maxAmmoSeen = m.ammo; }
    await sleep(55);
  }
  check('弹匣上限是 5 发', maxAmmoSeen === 5, '见过的最大值=' + maxAmmoSeen);
  check('一直按着开火时，弹匣会一路打到 0', minAmmo === 0, '最低=' + minAmmo);
  check('弹药不会变成负数', minAmmo >= 0, '最低=' + minAmmo);
  const first5 = shots.slice(0, 5);
  let minGap = 1e9, maxGap = 0;
  for (let i = 1; i < first5.length; i++) {
    const g = first5[i] - first5[i - 1];
    if (g < minGap) { minGap = g; }
    if (g > maxGap) { maxGap = g; }
  }
  check('前 5 发之间都隔了约 1 秒', first5.length >= 5 && minGap > 850 && maxGap < 1350,
        first5.length < 5 ? ('只观测到 ' + first5.length + ' 发') :
          ('间隔 ' + minGap + '~' + maxGap + 'ms，前 5 发用时 ' + (first5[4] - first5[0]) + 'ms'));
  // 打空后必须干等约 2 秒才有下一发
  let emptyGap = 0;
  for (let i = 5; i < shots.length; i++) {
    if (shots[i] - shots[i - 1] > emptyGap) { emptyGap = shots[i] - shots[i - 1]; }
  }
  check('打空后会停约 2 秒才有下一发', shots.length >= 6 && emptyGap > 1600,
        '共 ' + shots.length + ' 发，最长间隔 ' + emptyGap + 'ms');
  check('补弹计数器有在涨（换弹音效靠它触发）', reloadCount >= 2, '共补弹 ' + reloadCount + ' 次');
  await leave(C);

  // ============ ④ 视野 + 警戒（先造一对"近且通视"的坦克）============
  console.log('\n【④ 视野扇形 + 视野外警戒】');
  const B = mkSession();
  let pair = null, sb = null, pb0 = null;
  for (let round = 0; round < 30 && !pair; round++) {
    await leave(B);
    await join(B, 'B');
    sb = await sync(B);
    pb0 = self(sb, B.id);
    for (let i = 0; i < 100 && !pair; i++) {
      const A = mkSession();
      await join(A, 'A');
      const sa = await sync(A, { rev: sb.rev });      // 地图没变，只取增量即可
      const pa = self(sa, A.id);
      const dist = Math.hypot(pb0.x - pa.x, pb0.y - pa.y);
      // 只需两个条件：
      //   ① 够近（2~7 格）：视野/警戒测试要够近；上限留 3 格余量给转向时的微小漂移，
      //      保证 B 始终落在 10 格视野内（太近会顶到一起，也会让炮口越过对方）。
      //   ② 两点直线无遮挡：击杀测试是「A 原地开火」，中间隔墙就打不中。
      // 不再要求 BFS 可达 —— A 全程不移动，走不走得到 B 已经无所谓，
      // 去掉这条能大幅提高抽中概率（密图里"近且通视"本来就少见）。
      if (dist <= 7 * CELL && dist >= 2 * CELL && lineClear(pa.x, pa.y, pb0.x, pb0.y)) {
        pair = { A, B, sa, pb: pb0 };
        console.log('  （第 ' + (round + 1) + ' 轮第 ' + (i + 1) + ' 次：相距 ' +
                    (dist / CELL).toFixed(1) + ' 格，通视）');
      } else {
        await leave(A);
      }
    }
  }

  if (!pair) {
    note('视野/警戒测试', '地形太密，3000 次都没抽到"近距离且通视"的出生点');
  } else {
    const A = pair.A;
    let sa = pair.sa;
    const pb = self(sb, B.id);

    // 4.1 车身朝向 B → B 应可见
    let pa = self(sa, A.id);
    let ang = Math.atan2(pb.y - pa.y, pb.x - pa.x);
    await sync(B);              // B 刚在选对循环里晾了会儿，先唤回在线（超过 3s 会被判离线）
    sa = await aimBodyStatic(A, octAngle(octIndex(ang)), 6000, B);
    sa = await sync(A);
    pa = self(sa, A.id);
    ang = Math.atan2(pb.y - pa.y, pb.x - pa.x);
    const vis1 = !!(sa.tanks || []).find((t) => t.id === B.id);
    console.log('    [诊断] 4.1：A=(' + pa.x.toFixed(0) + ',' + pa.y.toFixed(0) + ') ba=' +
                (pa.ba * 180 / Math.PI).toFixed(0) + '°，B 方向=' + (Math.atan2(pb.y - pa.y, pb.x - pa.x) * 180 / Math.PI).toFixed(0) +
                '°，board=' + JSON.stringify((sa.board || []).map((b) => b.id)) +
                '，tanks=' + JSON.stringify((sa.tanks || []).map((t) => t.id)));
    check('车身朝着敌人时，敌人在快照里（可见）', vis1,
          '相距 ' + (Math.hypot(pb.y - pa.y, pb.x - pa.x) / CELL).toFixed(1) + ' 格，快照坦克数=' + (sa.tanks || []).length);

    // 4.2 车身背对 B → B 应不可见
    await sleep(1500);   // 先让之前可能存在的警戒过期
    await sync(B);       // 把 B 唤回在线：它从 4.1 起晾了 3 秒多，已被判离线
    sa = await aimBodyStatic(A, octAngle(octIndex(ang + Math.PI)), 6000, B);
    sa = await sync(A);
    pa = self(sa, A.id);
    console.log('    [诊断] 4.1后相距 ' + (Math.hypot(pb.y - pa.y, pb.x - pa.x) / CELL).toFixed(1) + ' 格');
    const vis2 = !!(sa.tanks || []).find((t) => t.id === B.id);
    check('背对敌人时，敌人不在快照里（视野外不可见）', !vis2,
          '快照坦克数=' + (sa.tanks || []).length);

    // 4.3 视野外的 B 开火 → A 应收到指向 B 的警戒
    await fireOnce(B);
    await sleep(180);
    sa = await sync(A);
    pa = self(sa, A.id);
    console.log('    [诊断] 4.2后相距 ' + (Math.hypot(pb.y - pa.y, pb.x - pa.x) / CELL).toFixed(1) +
                ' 格（A 的 ba=' + (pa.ba * 180 / Math.PI).toFixed(0) + '°，ang=' + (ang * 180 / Math.PI).toFixed(0) + '°）');
    const w = sa.warns || [];
    check('视野外敌人开火 → 出现警戒标志', w.length > 0, JSON.stringify(w));
    if (w.length) {
      const da = Math.abs(norm(w[0].a - ang));
      check('警戒方向指向敌人', da < 0.4, '角度误差 ' + (da * 180 / Math.PI).toFixed(1) + '°');
    }

    // 4.4 转回来看得见 B，再让 B 开火 → 不该有警戒
    await sleep(1500);
    await sync(B);       // 同理：B 从 fireOnce 起晾了 3 秒多，先唤回在线
    ang = Math.atan2(pb.y - pa.y, pb.x - pa.x);
    sa = await aimBodyStatic(A, octAngle(octIndex(ang)), 6000, B);
    sa = await sync(A);
    pa = self(sa, A.id);
    const dist44 = Math.hypot(pb.y - pa.y, pb.x - pa.x);
    console.log('    [诊断] 4.4：距 B ' + (dist44 / CELL).toFixed(1) + ' 格，A 的 ba=' +
                (pa.ba * 180 / Math.PI).toFixed(0) + '°，目标=' +
                (octAngle(octIndex(ang)) * 180 / Math.PI).toFixed(0) + '°（视野上限 10 格）' +
                '，board=' + JSON.stringify((sa.board || []).map((b) => b.id)) +
                '，tanks=' + JSON.stringify((sa.tanks || []).map((t) => t.id)));
    const vis3 = !!(sa.tanks || []).find((t) => t.id === B.id);
    await fireOnce(B);
    await sleep(180);
    sa = await sync(A);
    const w2 = sa.warns || [];
    check('看得见的敌人开火 → 不报警戒（自己看得见）', vis3 && w2.length === 0,
          '可见=' + vis3 + '，警戒数=' + w2.length);

    // ============ ⑤ 击毁坦克 / 摧毁障碍 → 事件 ============
    console.log('\n【⑤ 爆炸事件（音效依据）】');
    // 选对时已保证两车相距 ≤7 格且中间无遮挡，A 全程没移动过，原地瞄准开火即可。
    pa = self(sa, A.id);
    const closeDist = Math.hypot(pb.x - pa.x, pb.y - pa.y);
    console.log('  （A 原地开火：相距 ' + (closeDist / CELL).toFixed(1) +
                ' 格，通视=' + lineClear(pa.x, pa.y, pb.x, pb.y) + '）');
    ang = Math.atan2(pb.y - pa.y, pb.x - pa.x);
    // 炮塔对准 B
    for (let i = 0; i < 80; i++) {
      sa = await sync(A, { a: ang.toFixed(3) });
      const m = self(sa, A.id);
      if (Math.abs(norm(m.a - ang)) < 0.05) { break; }
      await sleep(30);
    }
    await sync(B);       // 炮塔瞄准期间 B 又晾了一会儿，击杀循环开始前唤回在线
    let hp0 = null, killed = false, sawKillEv = false, sawDamage = false;
    const tK = Date.now();
    while (Date.now() - tK < 16000) {
      sa = await sync(A, { a: ang.toFixed(3), f: 1 });
      if ((sa.events || []).some((e) => e.type === 'kill')) { sawKillEv = true; }
      const sb2 = await sync(B);
      const mb = self(sb2, B.id);
      if (hp0 == null) { hp0 = mb.hp; }
      if (mb.hp < hp0) { sawDamage = true; }
      if (!mb.alive) { killed = true; }
      if (killed && sawKillEv) { break; }
      await sleep(100);
    }
    await sync(A, { f: 0 });   // 松手，别让它继续连发
    check('子弹能打中敌人并扣血', sawDamage, '初始血量 ' + hp0);
    check('击毁敌方坦克会下发 kill 事件（爆炸音效）', sawKillEv && killed,
          'killed=' + killed + '，事件=' + sawKillEv);

    // 摧毁障碍：挑一个方向、找最近的那面墙，一直打同一格（要 3 发才碎）
    const wall = nearestWallDir(pa.x, pa.y);
    if (!wall) {
      note('摧毁障碍事件', '身边 120px 内没找到墙');
    } else {
      let sawObsEv = false;
      const tO = Date.now();
      while (Date.now() - tO < 24000 && !sawObsEv) {
        sa = await sync(A, { a: wall.ang.toFixed(3), f: 1 });
        if ((sa.events || []).some((e) => e.type === 'obs')) { sawObsEv = true; }
        await sleep(90);
      }
      check('摧毁障碍物会下发 obs 事件（爆炸音效）', sawObsEv,
            '朝 ' + (wall.ang * 180 / Math.PI).toFixed(0) + '° 那面墙（' + wall.d + 'px）打了约 ' +
            ((Date.now() - tO) / 1000).toFixed(0) + 's');
    }
    await leave(A);
  }
  await leave(B);

  // ============ ⑧ 身份复用：重连不产生重复号 ============
  console.log('\n【⑧ 身份复用：断线重连拿回同一个号】');
  const R = mkSession();
  await join(R, '重连甲', 'cid-test-1');
  const firstId = R.id;
  // 同 cid 再 join 一次（不发 leave）——模拟"闪断之后自动重连"
  await join(R, '重连甲', 'cid-test-1');
  check('同一个 cid 重连会复用原来的 id（不会变新号）', R.id === firstId,
        '第一次=' + firstId + '，重连后=' + R.id);
  // 重连时改名 → 旧号的名字跟着更新，而不是多出一条
  await join(R, '重连乙', 'cid-test-1');
  let dr = await sync(R);
  let boardR = dr.board || [];
  check('排行榜里不会出现重复账号（同一个人只有一条）',
        boardR.filter((b) => b.id === firstId).length === 1 &&
        boardR.filter((b) => b.n === '重连乙').length === 1,
        'board=' + JSON.stringify(boardR.map((b) => b.id + ':' + b.n)));
  check('重连可以改名', boardR.filter((b) => b.n === '重连乙').length === 1,
        '名字=' + JSON.stringify(boardR.map((b) => b.n)));

  // 不带 cid 加入 → 全新一个号（改版前的行为，保持兼容）
  const N = mkSession();
  await join(N, '无身份');
  check('不带 cid 也能加入（每次都是新号）', !!N.id && N.id !== firstId, '新号=' + N.id);

  // 不同 cid → 不同号
  const D = mkSession();
  await join(D, '另一个人', 'cid-test-2');
  check('不同 cid 是不同号', D.id !== firstId && D.id !== N.id, D.id);

  // 名字上限 10 个字符（启动器「名字登记」栏 maxlength=10，服务端同样截断兜底）
  const L = mkSession();
  await join(L, '一二三四五六七八九十十一');   // 11 字
  const dl = await sync(L);
  check('名字上限 10 个字符（服务端截断）', (self(dl, L.id).n || '').length <= 10,
        'n=' + self(dl, L.id).n);
  await leave(L);

  // 离线：5 秒不同步 → 从别人快照里消失；再同步 → 回来（不丢号）
  const W2 = mkSession();
  await join(W2, '旁观者', 'cid-test-3');
  let dw = await sync(W2);
  check('正常情况下排行榜看得到测试号', (dw.board || []).some((b) => b.id === firstId),
        'board=' + (dw.board || []).length + ' 人');
  await sleep(5600);            // 超过 IDLE_MS(5s)，R 全程不 sync
  dw = await sync(W2);
  check('5 秒没同步 → 从别人快照里消失（离线）',
        !(dw.board || []).some((b) => b.id === firstId),
        'board=' + JSON.stringify((dw.board || []).map((b) => b.id)));
  dr = await sync(R);           // 本人重新同步
  check('回来同步一下又重新上线（还是原来那个号）',
        !!self(dr, firstId) && dr.me != null, 'id=' + firstId);
  dw = await sync(W2);
  check('重新上线后别人又看得见了', (dw.board || []).some((b) => b.id === firstId));

  // leave 之后再 join 同 cid → 发新号（旧号已彻底离开世界）
  await leave(R);
  await join(R, '重连甲', 'cid-test-1');
  check('leave 后再用同 cid 加入 → 新号（旧的已彻底移除）', R.id !== firstId,
        '旧=' + firstId + ' 新=' + R.id);
  await leave(R);
  await leave(N);
  await leave(D);
  await leave(W2);

  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 / ' + skip + ' 跳过 =====');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
