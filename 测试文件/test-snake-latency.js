/* ============================================================
 * 贪吃蛇联机版 延迟矩阵测试（test-snake-latency.js）
 *
 * 跑法：  node 测试文件/test-snake-latency.js [LAT] [ST]
 *         单跑一组：LAT = 单程延迟 ms，ST = 步进间隔 ms
 *         不传参数则跑整张矩阵，任一格不达标就退出码 1
 *
 * 为什么还要它：test-snake-render.js 用的是**零延迟**虚拟服务端。
 * 「蛇身透明」和「转向飘移」这两个 bug 恰恰只在有延迟时才露头——
 * 客户端必须外推，而外推一旦越过拐角就会错。所以这里带真实延迟
 * （上行 + 下行各 LAT 毫秒）驱动同一个客户端，并额外养一条**旁观者
 * 蛇**（客户端无法本地预测它的转向，只能等快照）。
 *
 * 判据（三条不变量 + 一条观感指标，都是「越小越好」）：
 *   ① 离路径(身)/(头) —— 每个渲染点离**真实蛇身路径**的距离。蛇永远
 *      在自己走过的路上，所以必须 ≈ 0；飘出去就是「转向飘移」。
 *   ② 头脖距 / 节间距 —— 相邻两节的距离，恒 ≤ 1 格（格子间距）。
 *      一旦 > 1 就是「蛇身透明」（身体被撕开一个口子）。
 *   ③ 头跳 —— 头相邻两帧的位移。正常 ≈ 每帧走的格数（dt/st），
 *      突然冒出一个大值就是「跳 / 弹」。
 *   ④ 冻帧 —— 头几乎不动的帧占比（「一卡一卡」）。
 *
 * 调参：环境变量 AK/BK 覆盖本机蛇的两个延迟系数（× st、× 快照间隔），
 * TAU 覆盖锚点校正时间常数，PREDICT=0 关掉本机转向预测。用于标定
 * gamemode/snake2/game.js 顶部那几个常数的取值。
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

// ---------------- 浏览器环境桩 ----------------
function ctxStub() {
  return {
    fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1,
    font: '', textAlign: '', textBaseline: '', shadowColor: '', shadowBlur: 0,
    fillRect() {}, strokeRect() {}, clearRect() {}, beginPath() {}, closePath() {},
    moveTo() {}, lineTo() {}, arc() {}, arcTo() {}, fill() {}, stroke() {},
    save() {}, restore() {}, translate() {}, rotate() {}, drawImage() {},
    fillText() {}, measureText() { return { width: 10 }; }
  };
}
function elStub(id) {
  return {
    id, textContent: '', innerHTML: '', disabled: false, value: '', style: {},
    className: '', width: 960, height: 640,
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(ev, fn) { (this._ls = this._ls || {})[ev] = fn; }, _ls: {}
  };
}
function canvasStub() {
  const c = elStub('game');
  c.getContext = function () { return c._ctx || (c._ctx = ctxStub()); };
  return c;
}
const els = {}, winLs = {};
let rafCb = null;
global.document = {
  getElementById(id) { return els[id] || (els[id] = (id === 'game' ? canvasStub() : elStub(id))); },
  createElement() { return canvasStub(); },
  querySelectorAll() { return []; },
  addEventListener() {}, hidden: false
};
global.window = { addEventListener(ev, fn) { (winLs[ev] = winLs[ev] || []).push(fn); }, parent: null };
function storageStub() { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; }
global.localStorage = storageStub();
global.sessionStorage = storageStub();
global.requestAnimationFrame = cb => { rafCb = cb; };

const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0], CELL = 32;
const clamp = (v, a, b) => (v < a ? a : (v > b ? b : v));

// ---------------- 虚拟服务端：两条蛇 ----------------
// s1 = 本机（客户端能本地预测，转向由按键驱动）
// s2 = 旁观者（客户端**无法**预测它的转向，只能等快照）
function mkSnake(id, x, y, dir, len, st) {
  const s = { id, x, y, dir, len, st, last: 0, steps: 0, queued: -1, trail: [[x, y]] };
  for (let i = 1; i < 120; i++) { s.trail.push([x - DX[dir] * i, y - DY[dir] * i]); }
  return s;
}
function vStep(s) {
  if (s.queued >= 0) {
    if (s.queued !== (s.dir + 2) % 4) { s.dir = s.queued; }
    s.queued = -1;
  }
  // 挑一个走得通的方向，**绝不允许原地不动**。旧写法是「先按当前方向走、
  // 越界就退回再转向」，退回后照样把同一格 unshift 进 trail —— 身体里就多出
  // 一个重复格。真实服务端不可能这样（撞墙＝死亡/复活），拿这种身体去测
  // 客户端只会测出假故障。
  let nd = s.dir;
  for (let t = 0; t < 4; t++) {
    const nx = s.x + DX[nd], ny = s.y + DY[nd];
    if (nx >= 2 && nx <= 57 && ny >= 2 && ny <= 37) { s.x = nx; s.y = ny; s.dir = nd; break; }
    nd = (nd + 1) % 4;
  }
  s.trail.unshift([s.x, s.y]);
  if (s.trail.length > 120) { s.trail.pop(); }
  s.steps++;
  // s2 自己拐弯：每 4 步转一次，走 4×4 的方块（客户端无从预测）
  if (s.id === 's2' && s.steps % 4 === 0) { s.queued = (s.dir + 1) % 4; }
}
function vAdvance(s, now) {
  if (!s.last) { s.last = now; }
  let n = 0;
  while (now - s.last >= s.st && n < 8) { s.last += s.st; vStep(s); n++; }
  if (n >= 8) { s.last = now; }
}
function flying(s) { return s.queued >= 0 ? s.queued : s.dir; }
function snapOf(s, now) {
  const sf = clamp((now - s.last) * 1000 / s.st, 0, 999);
  return {
    id: s.id, n: s.id, c: '#4ea1ff', d: flying(s), alive: true, k: 0, sc: 0,
    st: s.st, sf, b: s.trail.slice(0, s.len).map(c => [c[0], c[1]])
  };
}

// ---------------- 加载客户端（注入探针） ----------------
const PROBE = `
globalThis.__t = {
  pts: function (id) {
    if (!cur) { return null; }
    for (var i = 0; i < cur.snakes.length; i++) {
      var s = cur.snakes[i];
      if (s.id !== id) { continue; }
      var g = glide[id];
      if (!g || !g.path || !g.path.length) { return null; }
      return { pts: bodySteps(s, g), b: s.b, d: s.d, st: g.st, idx: g.idx,
               T: g.T, delay: delayOfSnake(id, g.st) };
    }
    return null;
  }
};`;

function loadClient(LAT, s1, s2, onSync) {
  let src = fs.readFileSync(path.join(ROOT, 'gamemode/snake2/game.js'), 'utf8');
  if (process.env.PREDICT === '0') { src = src.replace('var PREDICT_SELF = true;', 'var PREDICT_SELF = false;'); }
  if (process.env.DST) { src = src.replace('oneWay() + st + snapGap', 'oneWay() + ' + process.env.DST + ' * st + ' + (process.env.DGAP || 1) + ' * snapGap'); }
  if (process.env.TAU) { src = src.replace('var TAU = 400;', 'var TAU = ' + process.env.TAU + ';'); }

  global.fetch = function (p, opts) {
    if (p === '/api/snake2/join') {
      return new Promise(res => setTimeout(() => res({ json: () => Promise.resolve({ id: 's1', w: 60, h: 40, cell: CELL }) }), LAT));
    }
    if (p === '/api/snake2/sync') {
      onSync();
      const body = (opts && opts.body) || '';
      const m = /(?:^|&)d=(-?\d+)/.exec(body);
      return new Promise(res => {
        setTimeout(() => {                                   // 上行
          if (m) { const d = +m[1]; if (d >= 0 && d <= 3) { s1.queued = d; } }
          const now = performance.now();
          vAdvance(s1, now); vAdvance(s2, now);
          const snap = {
            t: now, w: 60, h: 40, cell: CELL, you: 's1',
            me: { score: 0, kills: 0, deaths: 0, alive: true, respawnIn: 0, len: s1.len, step: s1.st },
            snakes: [snapOf(s1, now), snapOf(s2, now)],
            foods: [], board: [], events: []
          };
          setTimeout(() => res({ json: () => Promise.resolve(snap) }), LAT);   // 下行
        }, LAT);
      });
    }
    return Promise.resolve({ json: () => Promise.resolve({ error: 'no api' }) });
  };

  const anchor = 'requestAnimationFrame(frame);\n})();';
  const idx = src.lastIndexOf(anchor);
  (0, eval)(src.slice(0, idx) + PROBE + '\n' + src.slice(idx));
}

// ---------------- 度量 ----------------
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}
/** 真实蛇身路径折线：领先 3 格 + 走过的整条轨迹（多取几格，免得按自身
 *  延迟算出来的尾节落到折线外成了假阳性） */
function truePoly(s) {
  const fd = flying(s);
  const poly = [];
  for (let k = 3; k >= 1; k--) { poly.push([s.trail[0][0] + DX[fd] * k, s.trail[0][1] + DY[fd] * k]); }
  const n = Math.min(s.trail.length, s.len + 10);
  for (let i = 0; i < n; i++) { poly.push(s.trail[i]); }
  return poly;
}
function distToPoly(px, py, poly) {
  let best = Infinity;
  for (let i = 0; i + 1 < poly.length; i++) {
    const d = segDist(px, py, poly[i][0], poly[i][1], poly[i + 1][0], poly[i + 1][1]);
    if (d < best) { best = d; }
  }
  return best;
}
function mkStat() {
  return { offBody: 0, offHead: 0, headJump: 0, headNeck: 0, segGap: 0,
           frozen: 0, total: 0, delay: 0,
           tailJump: 0, tailFrozen: 0, tailIdxMin: 1e9, tailIdxMax: -1e9 };
}
function feed(st, cur2, prev, truth) {
  st.delay = cur2.delay;
  const poly = truePoly(truth);
  for (let i = 0; i < cur2.pts.length; i++) {
    const d = distToPoly(cur2.pts[i][0], cur2.pts[i][1], poly);
    if (i === 0) { if (d > st.offHead) { st.offHead = d; } }
    else if (d > st.offBody) { st.offBody = d; }
  }
  if (cur2.pts.length >= 2) {
    const hg = Math.hypot(cur2.pts[0][0] - cur2.pts[1][0], cur2.pts[0][1] - cur2.pts[1][1]);
    if (hg > st.headNeck) { st.headNeck = hg; }
  }
  for (let j = 1; j + 1 < cur2.pts.length; j++) {
    const g = Math.hypot(cur2.pts[j][0] - cur2.pts[j + 1][0], cur2.pts[j][1] - cur2.pts[j + 1][1]);
    if (g > st.segGap) { st.segGap = g; }
  }
  if (!prev) { return; }
  const hd = Math.hypot(cur2.pts[0][0] - prev.pts[0][0], cur2.pts[0][1] - prev.pts[0][1]);
  if (hd > 3) { return; }                    // 重生瞬移，不算
  st.total++;
  if (hd > st.headJump) { st.headJump = hd; }
  if (hd < 0.03) { st.frozen++; }
  // ---- 尾巴抖动 ----
  // 渲染延迟让整条蛇沿路径后移，尾巴的渲染下标会滑出身体末端、落到
  // 「已腾出格」上（实测到 n+3.5）。若那段历史被丢掉，pointAt 就被夹在
  // 尾格上：尾巴静止 80%+ 的帧，然后某帧突然跳 1~2 格 —— 视觉上就是抖动。
  // 所以尾巴既要「一直在动」（静止帧占比低），也要「不跳」（单帧位移小）。
  const ti = cur2.idx + (cur2.n - 1);
  if (ti < st.tailIdxMin) { st.tailIdxMin = ti; }
  if (ti > st.tailIdxMax) { st.tailIdxMax = ti; }
  const li = cur2.pts.length - 1, pi = prev.pts.length - 1;
  if (li >= 0 && pi >= 0) {
    const td = Math.hypot(cur2.pts[li][0] - prev.pts[pi][0], cur2.pts[li][1] - prev.pts[pi][1]);
    if (td > st.tailJump) { st.tailJump = td; }
    if (td < 0.03) { st.tailFrozen++; }
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
function key(code) { (winLs.keydown || []).forEach(fn => fn({ code, preventDefault() {} })); }

// ---------------- 单组：跑一次 ----------------
async function run(LAT, ST) {
  const s1 = mkSnake('s1', 30, 20, 2, 6, ST);
  const s2 = mkSnake('s2', 12, 12, 1, 6, ST);
  let syncs = 0;
  loadClient(LAT, s1, s2, () => { syncs++; });

  els.join._ls.click();
  // 等 join 期间也要泵渲染帧：客户端一 join 就开始同步快照，而每份快照都会
  // 让路径下标前进——不同时跑帧的话「只加不减」会堆出假偏差
  for (let k = 0; k < 20; k++) {
    if (rafCb) { try { rafCb(performance.now()); } catch (e) { /* 忽略 */ } }
    await sleep(16);
  }

  const st1 = mkStat(), st2 = mkStat();
  let prev1 = null, prev2 = null, tdir = 2;
  const TURN_EVERY = Math.round(4.5 * ST / 16.7);   // 每约 4.5 格右转一次，走方形轨迹
  for (let i = 0; i < 480; i++) {
    if (rafCb) { try { rafCb(performance.now()); } catch (e) { console.log('  帧异常:', e.message); break; } }
    if (i > 20 && i % TURN_EVERY === 0) { tdir = (tdir + 1) % 4; key(['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft'][tdir]); }
    const a = global.__t.pts('s1'), b = global.__t.pts('s2');
    if (a) { feed(st1, a, prev1, s1); prev1 = a; }
    if (b) { feed(st2, b, prev2, s2); prev2 = b; }
    await sleep(16);
  }
  return { st1, st2, syncs };
}

// ---------------- 判据 ----------------
const LIM = { offPath: 0.35, headNeck: 1.05, segGap: 1.05, headJump: 1.25, frozen: 2.0,
              // 一帧 ~16ms；ST=70 时一格 70ms，一帧最多走 0.25 格（实测帧距
              // 含开销约 31ms → 0.45 格）。给到 0.8 格：真「跳格」必然 >=1 格。
              tailJump: 0.8,
              // 尾巴静止帧占比。旧实现在 ST=70 下 82%，修好后 0~2%。
              tailFrozen: 12.0 };
function line(tag, st) {
  return tag + ' 离路径(身)=' + st.offBody.toFixed(2) + ' (头)=' + st.offHead.toFixed(2) +
    ' | 头跳=' + st.headJump.toFixed(2) + ' | 头脖距=' + st.headNeck.toFixed(2) +
    ' | 节间距=' + st.segGap.toFixed(2) +
    ' | 延迟=' + Math.round(st.delay) + 'ms | 冻帧=' + (st.frozen / Math.max(1, st.total) * 100).toFixed(1) + '%' +
    ' | 尾跳=' + st.tailJump.toFixed(2) + '格 尾静=' +
    (st.tailFrozen / Math.max(1, st.total) * 100).toFixed(0) + '%';
}
function check(tag, st) {
  const bad = [];
  if (Math.max(st.offBody, st.offHead) > LIM.offPath) { bad.push('离路径 ' + Math.max(st.offBody, st.offHead).toFixed(2)); }
  if (st.headNeck > LIM.headNeck) { bad.push('头脖距 ' + st.headNeck.toFixed(2)); }
  if (st.segGap > LIM.segGap) { bad.push('节间距 ' + st.segGap.toFixed(2)); }
  if (st.headJump > LIM.headJump) { bad.push('头跳 ' + st.headJump.toFixed(2)); }
  const fp = st.frozen / Math.max(1, st.total) * 100;
  if (fp > LIM.frozen) { bad.push('冻帧 ' + fp.toFixed(1) + '%'); }
  if (st.tailJump > LIM.tailJump) { bad.push('尾跳 ' + st.tailJump.toFixed(2) + '格'); }
  const tfp = st.tailFrozen / Math.max(1, st.total) * 100;
  if (tfp > LIM.tailFrozen) { bad.push('尾静 ' + tfp.toFixed(0) + '%'); }
  if (bad.length) { console.log('  FAIL  ' + tag + '：' + bad.join('、') + ' 超限'); }
  return bad.length === 0;
}

// 一个格子一个子进程：客户端是 eval 进当前进程的，同进程跑两遍会互相污染
// （旧实例的同步定时器还在跑）
const MATRIX = [[0, 150], [0, 70], [40, 150], [40, 70], [80, 150], [80, 70]];

if (process.argv[2] === undefined) {
  const { spawnSync } = require('child_process');
  let allOk = true;
  for (const [lat, st] of MATRIX) {
    const r = spawnSync(process.execPath, [__filename, String(lat), String(st)], { stdio: 'inherit' });
    if (r.status !== 0) { allOk = false; }
  }
  console.log(allOk ? '== 矩阵全部达标 ==' : '== 矩阵有超限 ==');
  process.exit(allOk ? 0 : 1);
}

(async function () {
  const LAT = +process.argv[2], ST = +(process.argv[3] || 150);
  const { st1, st2 } = await run(LAT, ST);
  console.log('LAT=' + LAT + ' ST=' + ST);
  console.log('  ' + line('s1本机', st1));
  console.log('  ' + line('s2旁观', st2));
  const ok = check('s1本机', st1) & check('s2旁观', st2);
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('测试脚本异常: ' + (e && e.stack ? e.stack : e)); process.exit(1); });
