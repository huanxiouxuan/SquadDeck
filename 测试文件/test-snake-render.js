/* ============================================================
 * 贪吃蛇渲染链路 无头浸泡测试（test-snake-render.js）
 *
 * 跑法：  node 测试文件/test-snake-render.js   （服务器不用开）
 *
 * 目的：卡顿修复 + 地图放大 + 镜头跟随都是客户端渲染逻辑，
 * 服务端测试覆盖不到。这里桩掉浏览器环境（DOM / canvas /
 * fetch / rAF），把两个游戏加载进来，用一个「虚拟服务端」
 * （按真实步进节拍推进、按精确时刻算 sf 相位）驱动约 4 秒，
 * 逐帧采样蛇头渲染位置，验证：
 *
 *   1. 整条链路跑 4 秒不出异常（join/sync/渲染/转向/相机/小地图）
 *   2. 蛇头连续滑动：绝大多数帧都在动（旧实现约有 1/3 的帧冻住）
 *   3. 没有「等快照→停顿→追赶」的跳帧（帧间位移有上限）
 *   4. 平均速度 ≈ 服务端真实步进速度（渲染节拍锁进服务端节拍）
 *   5. 相机始终在地图范围内、大致跟着蛇头
 *   6. 视口裁剪 / sprite 缓存 / 小地图 / 格子线代码路径都走到
 *   7. 身子相邻两节在拐角处不拉开缺口（修「蛇变透明」）、脖子始终贴在
 *      身体路径上（修「转向飘移」——offset 只校正蛇头，不拖身子）
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (extra ? '  -- ' + extra : '')); }
}

// ---------------- 浏览器环境桩 ----------------
function ctxStub() {
  const calls = {
    drawImage: 0, translate: [], fillText: 0, rotate: 0, stroke: 0,
    arcTo: 0, arcToBad: 0, badSamples: []
  };
  // 跟踪「当前点」，用来判断 arcTo 是否退化。
  // 画布规范：arcTo 的 第一控制点==终点，或 当前点==第一控制点 时，
  // 它退化成一条直线；圆角矩形若这么写，路径会自重叠、净环绕数为 0，
  // fill() 几乎填不出面积 —— 蛇身会渲染成一节节小碎片（看着像「透明」）。
  // 真实建议：桩 canvas 不光栅化，光靠几何断言抓不到这类 bug，必须查路径参数。
  let px = null, py = null;
  return {
    calls: calls,
    fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1,
    font: '', textAlign: '', textBaseline: '',
    shadowColor: '', shadowBlur: 0,
    fillRect() {}, strokeRect() {}, clearRect() {},
    beginPath() { px = py = null; }, closePath() {},
    moveTo(x, y) { px = x; py = y; },
    lineTo(x, y) { px = x; py = y; },
    arc(cx, cy, r, a0, a1) { px = cx + r * Math.cos(a1); py = cy + r * Math.sin(a1); },
    arcTo(x1, y1, x2, y2, r) {
      calls.arcTo++;
      const p1eqp2 = (x1 === x2 && y1 === y2);
      const p0eqp1 = (px !== null && px === x1 && py === y1);
      if (p1eqp2 || p0eqp1) {
        calls.arcToBad++;
        if (calls.badSamples.length < 3) {
          calls.badSamples.push(
            { p0: [px, py], p1: [x1, y1], p2: [x2, y2], r: r, p1eqp2: p1eqp2, p0eqp1: p0eqp1 });
        }
        px = x1; py = y1;          // 退化：按规范等价于 lineTo(P1)
        return;
      }
      // 正常：当前点更新到「弧的终点」——P1 沿 P1→P2 方向偏移 r/tan(θ/2)。
      // 注意不能直接当成 P2，否则下一段会误判成 P0==P1。
      const ax = px - x1, ay = py - y1, bx = x2 - x1, by = y2 - y1;
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      if (la < 1e-9 || lb < 1e-9 || r <= 0) { px = x1; py = y1; return; }
      let cosT = (ax * bx + ay * by) / (la * lb);
      cosT = Math.max(-1, Math.min(1, cosT));
      const d = r / Math.tan(Math.acos(cosT) / 2);
      px = x1 + (bx / lb) * d;
      py = y1 + (by / lb) * d;
    },
    fill() {}, stroke() { calls.stroke++; },
    save() {}, restore() {},
    translate(x, y) { calls.translate.push([x, y]); },
    rotate() { calls.rotate++; },
    drawImage() { calls.drawImage++; },
    fillText() { calls.fillText++; },
    measureText() { return { width: 10 }; }
  };
}
function elStub(id) {
  const e = {
    id: id, textContent: '', innerHTML: '', disabled: false, value: '',
    style: {}, className: '', width: 960, height: 640,
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(ev, fn) { (this._ls = this._ls || {})[ev] = fn; },
    getAttribute() { return null; },
    _ls: {}
  };
  return e;
}
function canvasStub() {
  const c = elStub('game');
  c.getContext = function () { return c._ctx || (c._ctx = ctxStub()); };
  return c;
}

const els = {};
const winLs = {};
const docLs = {};
let rafCb = null;

global.document = {
  getElementById(id) { return els[id] || (els[id] = (id === 'game' ? canvasStub() : elStub(id))); },
  createElement() { return canvasStub(); },
  querySelectorAll(sel) { return sel === '[data-speed]' ? speedBtns : []; },
  addEventListener(ev, fn) { (docLs[ev] = docLs[ev] || []).push(fn); },
  hidden: false
};
global.window = {
  addEventListener(ev, fn) { (winLs[ev] = winLs[ev] || []).push(fn); },
  parent: null
};
function storageStub() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
}
global.localStorage = storageStub();
global.sessionStorage = storageStub();
global.requestAnimationFrame = function (cb) { rafCb = cb; };

const speedBtns = ['185', '150', '110'].map(v => {
  const b = elStub('speed' + v);
  b.getAttribute = k => (k === 'data-speed' ? v : null);
  return b;
});

// ---------------- 虚拟服务端（贪吃蛇联机版） ----------------
const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];
const CELL = 32;

function makeVirtualSnake(id, sx, sy, dir, color, name) {
  return {
    id: id, x: sx, y: sy, dir: dir, st: 150, len: 4,
    last: performance.now(), trail: [[sx, sy]], queued: -1,
    color: color, name: name, dead: false
  };
}
function vStep(v) {
  if (v.queued >= 0 && v.queued !== (v.dir + 2) % 4) { v.dir = v.queued; }
  v.queued = -1;
  v.x += DX[v.dir];
  v.y += DY[v.dir];
  // 撞墙就换个方向重生（顺便 exercising 客户的瞬移吸附分支）
  if (v.x < 1 || v.x > 58 || v.y < 1 || v.y > 38) {
    v.x = 5 + Math.floor(Math.random() * 50);
    v.y = 5 + Math.floor(Math.random() * 30);
    v.dir = Math.floor(Math.random() * 4);
    v.trail = [[v.x, v.y]];
  }
  v.trail.unshift([v.x, v.y]);
  if (v.trail.length > 60) { v.trail.pop(); }
}
function vAdvance(v, now) {
  let steps = 0;
  while (now - v.last >= v.st && steps < 4) { v.last += v.st; vStep(v); steps++; }
  if (steps >= 4) { v.last = now; }   // 长时间没推进（测试卡顿），对齐时钟
}
function vSnapJson(v, now) {
  vAdvance(v, now);
  const sf = Math.max(0, Math.min(999, (now - v.last) * 1000 / v.st));
  const body = v.trail.slice(0, v.len);
  // 和真实服务端一致：下发「当前在飞的方向」——有排队转向时就是那个新方向，
  // 不是上一步走过的方向（这一点是「转向飘移」的服务端根因）
  const fd = v.queued >= 0 ? v.queued : v.dir;
  return {
    id: v.id, n: v.name, c: v.color, d: fd, alive: !v.dead,
    k: 0, sc: 0, st: v.st, sf: sf, b: body
  };
}

// ---------------- 加载游戏（注入探针） ----------------
function loadGame(file, probe, anchorText) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const idx = src.lastIndexOf(anchorText);
  if (idx < 0) { throw new Error('锚点没找到: ' + file); }
  const patched = src.slice(0, idx) + probe + '\n' + src.slice(idx);
  (0, eval)(patched);
}

const PROBE2 = `
globalThis.__t2 = {
  me: function () { return me; },
  cur: function () { return cur; },
  glide: function () { return glide; },
  cam: function () { return [camX, camY]; },
  joined: function () { return joined; },
  head: function () {
    var g = glide[me]; if (!g || !cur) { return null; }
    for (var i = 0; i < cur.snakes.length; i++) {
      if (cur.snakes[i].id === me) {
        return bodySteps(cur.snakes[i], g)[0];
      }
    }
    return null;
  },
  bodyInfo: function () {
    var g = glide[me]; if (!g || !cur) { return null; }
    for (var i = 0; i < cur.snakes.length; i++) {
      if (cur.snakes[i].id === me) {
        var s = cur.snakes[i];
        return { pts: bodySteps(s, g), b: s.b, d: s.d };
      }
    }
    return null;
  }
};`;

const PROBE1 = `
globalThis.__t1 = {
  state: function () { return state; },
  snake: function () { return snake; },
  cam: function () { return [camX, camY]; },
  head: function () {
    if (!snake.length || !prevSnake.length) { return null; }
    var t = state === 1 ? clamp(acc / tickMs, 0, 1) : 1;
    var c = snake[0], p = prevSnake[0] || c;
    return [p.x + (c.x - p.x) * t, p.y + (c.y - p.y) * t];
  }
};`;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function dispatchKey(code) {
  (winLs.keydown || []).forEach(fn => fn({ code: code, preventDefault() {} }));
}

// ---------------- 主流程 ----------------
(async function () {
  // ============ 第一部分：贪吃蛇联机版 ============
  console.log('== 联机版：虚拟服务端驱动 4 秒 ==');

  const me = makeVirtualSnake('s1', 30, 20, 1, '#4ea1ff', '我');
  const other = makeVirtualSnake('s2', 10, 10, 2, '#ff6b6b', '对方');
  let syncs = 0;

  global.fetch = function (p, opts) {
    const now = performance.now();
    if (p === '/api/snake2/join') {
      return Promise.resolve({ json: () => Promise.resolve({ id: 's1', w: 60, h: 40, cell: CELL }) });
    }
    if (p === '/api/snake2/sync') {
      syncs++;
      // 客户端上报的转向意图在 body 里（id=s1&d=2&ev=0&e=）→ 虚拟服务端排队
      const body = (opts && opts.body) || '';
      const m = /(?:^|&)d=(-?\d+)/.exec(body);
      if (m) {
        const d = +m[1];
        if (d >= 0 && d <= 3) { me.queued = d; }
      }
      const d = {
        t: now, w: 60, h: 40, cell: CELL, you: 's1',
        me: { score: 0, kills: 0, deaths: 0, alive: true, respawnIn: 0, len: me.len, step: me.st },
        snakes: [vSnapJson(me, now), vSnapJson(other, now)],
        foods: [
          { x: 5, y: 5, g: 0 }, { x: 55, y: 35, g: 0 },
          { x: 30, y: 20, g: 1, ms: 5000 }
        ],
        board: [{ id: 's1', n: '我', c: '#4ea1ff', k: 0, sc: 0, alive: true }],
        events: []
      };
      // 客户端上报的转向意图（POST body 里）→ 虚拟服务端排队
      return Promise.resolve({ json: () => Promise.resolve(d) });
    }
    if (p === '/api/snake2/leave') {
      return Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
    }
    return Promise.resolve({ json: () => Promise.resolve({ error: 'no such api' }) });
  };

  loadGame('gamemode/snake2/game.js', PROBE2, 'requestAnimationFrame(frame);\n})();');

  // 点「开始」
  els.join._ls.click();
  // 等 join 期间也要泵渲染帧：客户端一 join 就开始同步快照，而每份快照都会
  // 让路径下标前进——不同时跑帧的话「只加不减」会堆出假的滞后
  for (let k = 0; k < 20; k++) {
    try { if (rafCb) { rafCb(performance.now()); } } catch (e) { /* 忽略 */ }
    await sleep(16);
  }

  ok(!!global.__t2.joined(), 'join 成功进入游戏');
  ok(!!global.__t2.head(), '收到快照并建出滑行状态');

  // 驱动 4 秒：60fps 手动泵帧 + 真实定时器跑同步
  // （用真实时间而不是假时间：渲染下标按真实流逝推进，假时钟会让它和
  //   锚点校正的时钟错位，测出假的速度偏差）
  const samples = [];
  const bodySamples = [];   // 每帧的整条蛇渲染坐标（查「透明/飘移」用）
  let exceptions = 0;
  const t0 = performance.now();
  for (let i = 0; i < 240; i++) {
    try {
      if (rafCb) { rafCb(performance.now()); }
    } catch (e) {
      exceptions++;
      if (exceptions === 1) { console.log('    首帧异常: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)); }
    }
    if (i === 60) { dispatchKey('ArrowDown'); }    // 1s 转弯
    if (i === 140) { dispatchKey('ArrowLeft'); }   // 2.3s 再转弯
    const h = global.__t2.head();
    if (h) { samples.push([performance.now(), h[0], h[1]]); }
    const bi = global.__t2.bodyInfo();
    if (bi && bi.pts.length >= 2 && bi.b.length >= 2) {
      bodySamples.push({ pts: bi.pts, poly: truePoly() });
    }
    await sleep(16);
  }
  const elapsed = (performance.now() - t0) / 1000;

  ok(exceptions === 0, '4 秒渲染无异常', exceptions + ' 次');
  ok(syncs > 40, '同步在持续（' + syncs + ' 次 / ' + elapsed.toFixed(1) + 's）');

  // ---- 连续性分析 ----
  let maxJump = 0, frozen = 0, moving = 0, teleports = 0;
  const deltas = [];
  for (let i = 1; i < samples.length; i++) {
    const dt = samples[i][0] - samples[i - 1][0];
    if (dt <= 0 || dt > 100) { continue; }
    const d = Math.hypot(samples[i][1] - samples[i - 1][1], samples[i][2] - samples[i - 1][2]) * CELL;
    if (d > CELL * 2.5) { teleports++; continue; }   // 撞墙重生的瞬移，不算
    deltas.push({ d: d, dt: dt });
    if (d > maxJump) { maxJump = d; }
    if (d < 0.3) { frozen++; } else { moving++; }
  }
  const avgSpeed = deltas.reduce((a, x) => a + x.d / x.dt, 0) / Math.max(1, deltas.length); // px/ms
  const trueSpeed = CELL / me.st;   // 服务端真实速度 px/ms
  const frozenPct = frozen / Math.max(1, deltas.length) * 100;

  ok(deltas.length > 150, '采样足够（' + deltas.length + ' 帧）');
  // 阈值 16px（半格）：渲染下标按真实时间推进，每帧位移 ≈ dt/st 格，转向
  // 处最多乘 √2 ≈ 6px；「追赶跳」（一次跨一格以上）会是 32px 起步
  ok(maxJump <= 16, '无追赶跳帧（最大帧间位移 ' + maxJump.toFixed(1) + 'px ≤ 16）');
  ok(frozenPct <= 5, '几乎没有冻帧（' + frozenPct.toFixed(1) + '% ≤ 5%）——修卡顿的核心指标');
  ok(avgSpeed > trueSpeed * 0.75 && avgSpeed < trueSpeed * 1.3,
     '渲染速度锁进服务端节拍（实测 ' + avgSpeed.toFixed(3) + ' vs 真实 ' + trueSpeed.toFixed(3) + ' px/ms）');

  // ---- 相机 ----
  const cam = global.__t2.cam();
  ok(cam[0] >= -0.01 && cam[0] <= 960.01 && cam[1] >= -0.01 && cam[1] <= 640.01,
     '相机始终在地图范围内（' + cam[0].toFixed(0) + ',' + cam[1].toFixed(0) + '）');
  const head = global.__t2.head();
  if (head) {
    const dx = Math.abs(cam[0] + 480 - (head[0] + 0.5) * CELL);
    const dy = Math.abs(cam[1] + 320 - (head[1] + 0.5) * CELL);
    ok(dx < 700 && dy < 700, '相机大致跟着蛇头（偏差 ' + dx.toFixed(0) + ',' + dy.toFixed(0) + 'px）');
  }

  // ---- 身体贴合度：「蛇变透明」「转向飘移」两个 bug 的回归断言 ----
  // 点 P 到线段 AB 的距离
  function segDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    var t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
  }
  const DIRV = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  // 真实蛇身路径折线：领先 2 格 + 走过的整条轨迹（多取几格，免得按自身
  // 延迟算出来的尾节落到折线外，成了假阳性）
  function truePoly() {
    const fd = me.queued >= 0 ? me.queued : me.dir;
    const poly = [];
    for (let k = 2; k >= 1; k--) { poly.push([me.trail[0][0] + DX[fd] * k, me.trail[0][1] + DY[fd] * k]); }
    const n = Math.min(me.trail.length, me.len + 10);
    for (let i = 0; i < n; i++) { poly.push(me.trail[i]); }
    return poly;
  }
  function distToPoly(px, py, poly) {
    let best = Infinity;
    for (let i = 0; i + 1 < poly.length; i++) {
      const dd = segDist(px, py, poly[i][0], poly[i][1], poly[i + 1][0], poly[i + 1][1]);
      if (dd < best) { best = dd; }
    }
    return best;
  }
  // 三条不变量（比「看起来顺不顺」硬得多）：
  // 1) 头-脖间距 ≤ 1.05 格：整条蛇按「路径下标」参数化，相邻两节恒差 1 个
  //    下标 → 欧氏距离必然 ≤ 1 格。「蛇身透明」（头从身上断开一个大口子）
  //    从此结构上不可能出现。
  // 2) 身子相邻两节同样 ≤ 1.05 格。
  // 3) 每个渲染点都落在**真实蛇身路径**上（≤ 0.3 格）：蛇永远在自己走过的
  //    路上，飘出去就是「转向飘移」。以前靠「二维平移补间」压误差，那个
  //    补间在拐角处根本表达不出来，整条蛇会被拖着飘出去一格多。
  let maxNeckGap = 0, maxGap = 0, maxOffPath = 0, offSkipped = 0;
  let prevHead = null, respawnSkip = 0;
  for (let i = 0; i < bodySamples.length; i++) {
    const pts = bodySamples[i].pts, poly = bodySamples[i].poly;
    // 重生后客户端要等下一份快照才重新锚定（约 4 帧），那几帧不算
    if (prevHead && Math.hypot(pts[0][0] - prevHead[0], pts[0][1] - prevHead[1]) > 3) { respawnSkip = 8; }
    prevHead = pts[0];
    for (let k = 0; k + 1 < pts.length; k++) {
      const gap = Math.hypot(pts[k][0] - pts[k + 1][0], pts[k][1] - pts[k + 1][1]);
      if (k === 0) { if (gap > maxNeckGap) { maxNeckGap = gap; } }
      else if (gap > maxGap) { maxGap = gap; }
    }
    // 真值折线必须足够长才能当基准（开局/重生后轨迹很短，会出假阳性）
    if (poly.length < me.len + 3 || respawnSkip > 0) { respawnSkip -= (respawnSkip > 0 ? 1 : 0); offSkipped++; continue; }
    for (let k = 0; k < pts.length; k++) {
      const off = distToPoly(pts[k][0], pts[k][1], poly);
      if (off > maxOffPath) { maxOffPath = off; }
    }
  }
  ok(bodySamples.length > 150, '身体采样足够（' + bodySamples.length + ' 帧）');
  ok(maxNeckGap <= 1.05, '头-脖无缺口（最大 ' + maxNeckGap.toFixed(2) + ' 格 ≤ 1.05）——修「蛇身透明」');
  ok(maxGap <= 1.05, '身子相邻两节无缺口（最大 ' + maxGap.toFixed(2) + ' 格 ≤ 1.05）——修「蛇身透明」');
  ok(maxOffPath <= 0.3, '整条蛇贴在真实路径上（最大偏离 ' + maxOffPath.toFixed(2) + ' 格 ≤ 0.3，参与 ' +
     (bodySamples.length - offSkipped) + ' 帧）——修「转向飘移」');

  // ---- 渲染路径覆盖 ----
  const c = els.game._ctx;
  ok(c.calls.drawImage > 50, '食物 sprite 走 drawImage 缓存（' + c.calls.drawImage + ' 次，无 shadowBlur）');
  ok(c.calls.translate.length > 100, '相机 translate 每帧都在用');
  ok(c.calls.fillText > 50, '蛇名字/星级在画');

  // 「蛇身透明」的真根因在光栅化，不在几何：圆角矩形若把 arcTo 的控制点
  // 写成与终点重合，路径会退化成自重叠路径，fill() 几乎填不出面积，蛇身就
  // 渲染成一节节小碎片。桩 canvas 不光栅化，几何断言全绿也抓不到，所以这里
  // 直接查 arcTo 的路径参数是否退化。
  ok(c.calls.arcToBad === 0,
     '圆角矩形路径无退化（arcTo 控制点不重合）——修「蛇身透明」的根因',
     JSON.stringify(c.calls.badSamples));
  ok(c.calls.arcTo > 0, '圆角矩形确实走了 arcTo 路径（覆盖到位，' + c.calls.arcTo + ' 次）');
  const arcToBadOnline = c.calls.arcToBad;

  // ============ 第二部分：单机版 ============
  console.log('== 单机版：固定 tick 驱动 3 秒 ==');

  // 清掉联机版的 rAF 回调，重新加载单机版（同进程，全局已桩）
  rafCb = null;
  loadGame('gamemode/snake/game.js', PROBE1, 'requestAnimationFrame(loop);\n})();');

  // 点「休闲」难度（185ms/步）
  speedBtns[0]._ls.click();
  await sleep(200);

  ok(global.__t1.state() === 1, '单机版开局（RUNNING）');

  const s1samples = [];
  let s1ex = 0;
  const s1t0 = performance.now();
  for (let i = 0; i < 180; i++) {
    // 用真实时间驱动（单机版 loop 靠 rAF 的 ts 算 dt，假时间会让
    // 固定 tick 累加器与真实步进节拍错位，产生假的「速度偏慢」）
    try {
      if (rafCb) { rafCb(performance.now()); }
    } catch (e) {
      s1ex++;
      if (s1ex === 1) { console.log('    首帧异常: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)); }
    }
    // 30×20 一屏地图：从正中出发 3 秒直线会撞墙（15 格 × 185ms ≈ 2.8s），
    // 末尾几帧冻住会污染冻帧断言——1s 和下 2s 各转一次，蛇在圈里绕
    if (i === 60) { dispatchKey('ArrowDown'); }
    if (i === 120) { dispatchKey('ArrowLeft'); }
    const h = global.__t1.head();
    if (h) { s1samples.push([performance.now(), h[0], h[1]]); }
    await sleep(16);
  }

  ok(s1ex === 0, '3 秒渲染无异常', s1ex + ' 次');

  let s1max = 0, s1frozen = 0;
  const s1deltas = [];
  for (let i = 1; i < s1samples.length; i++) {
    const dt = s1samples[i][0] - s1samples[i - 1][0];
    if (dt <= 0 || dt > 100) { continue; }
    const d = Math.hypot(s1samples[i][1] - s1samples[i - 1][1], s1samples[i][2] - s1samples[i - 1][2]) * CELL;
    s1deltas.push({ d: d, dt: dt });
    if (d > s1max) { s1max = d; }
    if (d < 0.3) { s1frozen++; }
  }
  const s1frozenPct = s1frozen / Math.max(1, s1deltas.length) * 100;
  const s1avg = s1deltas.reduce((a, x) => a + x.d / x.dt, 0) / Math.max(1, s1deltas.length);
  const s1true = CELL / 185;

  ok(s1max <= 10, '无跳帧（最大帧间位移 ' + s1max.toFixed(1) + 'px ≤ 10）');
  // 185ms/步的休闲档，每步之间约 11 帧等待，采样窗口（约 16 步）首尾
  // 静止帧占 3~4% 属正常；联机版才是卡顿修复重点（那里冻帧是 0%）
  ok(s1frozenPct <= 4, '几乎没有冻帧（' + s1frozenPct.toFixed(1) + '% ≤ 4%）');
  ok(s1avg > s1true * 0.7 && s1avg < s1true * 1.35,
     '速度和设定档一致（实测 ' + s1avg.toFixed(3) + ' vs ' + s1true.toFixed(3) + ' px/ms）');

  // 单机版是原版 30×20 一屏地图（没有镜头）：蛇头永远在地图内
  let s1Out = 0;
  for (let i = 0; i < s1samples.length; i++) {
    if (s1samples[i][1] < 0 || s1samples[i][1] >= 30
        || s1samples[i][2] < 0 || s1samples[i][2] >= 20) { s1Out++; }
  }
  ok(s1Out === 0, '蛇头始终在 30×20 地图内（越界 ' + s1Out + ' 次）');

  const c1 = els.game._ctx;
  ok(c1.calls.drawImage > 30, '单机版果实 sprite 走缓存（' + c1.calls.drawImage + ' 次）');
  ok(c1.calls.stroke > 100, '格子线每帧都在画（stroke ' + c1.calls.stroke + ' 次）');
  ok(c1.calls.arcToBad === arcToBadOnline,
     '单机版圆角矩形同样无退化路径——两版是同一个 helper，一起修',
     JSON.stringify(c1.calls.badSamples));

  console.log('== 结果: ' + passed + ' 通过, ' + failed + ' 失败 ==');
  process.exit(failed ? 1 : 0);
})().catch(function (e) {
  console.error('测试脚本异常: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
