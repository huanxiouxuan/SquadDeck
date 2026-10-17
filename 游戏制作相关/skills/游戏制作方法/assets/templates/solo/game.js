/* ============================================================
 * 单机模板：30 秒内点方块得分
 *
 * 演示要点（改玩法时这些结构可以留着）：
 *   - requestAnimationFrame + dt 驱动，帧率无关
 *   - 点击命中检测（考虑 CSS 缩放，用 getBoundingClientRect 换算）
 *   - 标准四段 roundRect（arcTo 控制点两两不同）
 *   - 最高分存 localStorage（隐私模式下会失败，已 try/catch）
 * ============================================================ */
(function () {
  'use strict';

  // 游戏 id：单机用不到接口，但先留着这段。
  // 将来要加联机，务必用它拼 API 前缀——不要写死 /api/xxx（导入后 id 会变）。
  var GID = (location.pathname.match(/\/games\/([^\/]+)/) || [])[1] || 'solo-template';

  var canvas = document.getElementById('game');
  var ctx = canvas.getContext('2d');
  var elScore = document.getElementById('score');
  var elTime = document.getElementById('time');
  var elBest = document.getElementById('best');
  var overlay = document.getElementById('overlay');
  var btnStart = document.getElementById('start');

  var W = 640, H = 480;
  var BEST_KEY = 'soloTemplate.best';
  var GAME_MS = 30000;

  var STATE = { READY: 0, RUN: 1, OVER: 2 };
  var state = STATE.READY;

  var score = 0, best = 0, endAt = 0;
  var block = { x: 100, y: 100, s: 72, vx: 170, vy: 130 };
  var flash = 0;
  var lastTs = 0;

  // ---------------- 工具 ----------------

  function roundRect(x, y, w, h, r) {
    // 标准写法：四个控制点两两不同；r 夹到半边长以内。
    // （写成 arcTo(x+w,y+h,x+w,y+h,r) 这种 P1==P2 会退化成直线，fill 几乎填不出来）
    var rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function readBest() {
    try { return parseInt(localStorage.getItem(BEST_KEY) || '0', 10) || 0; }
    catch (e) { return 0; }
  }

  function saveBest(v) {
    try { localStorage.setItem(BEST_KEY, String(v)); } catch (e) { /* 隐私模式 */ }
  }

  // ---------------- 流程 ----------------

  function startGame() {
    score = 0;
    endAt = performance.now() + GAME_MS;
    block.x = W / 2 - block.s / 2;
    block.y = H / 2 - block.s / 2;
    block.vx = 170;
    block.vy = 130;
    state = STATE.RUN;
    overlay.classList.add('hidden');
    updateHud();
  }

  function gameOver() {
    state = STATE.OVER;
    if (score > best) { best = score; saveBest(best); }
    overlay.querySelector('h3').textContent = '时间到';
    overlay.querySelector('p').innerHTML =
        '得分 <b style="color:#ffd166">' + score + '</b>　最高 ' + best;
    btnStart.textContent = '再来一局';
    overlay.classList.remove('hidden');
    updateHud();
  }

  function updateHud() {
    elScore.textContent = score;
    elTime.textContent = state === STATE.RUN
        ? Math.max(0, Math.ceil((endAt - performance.now()) / 1000))
        : 0;
    elBest.textContent = best;
  }

  // ---------------- 点击 ----------------

  canvas.addEventListener('click', function (e) {
    if (state !== STATE.RUN) { return; }
    var rect = canvas.getBoundingClientRect();
    var x = (e.clientX - rect.left) / rect.width * W;
    var y = (e.clientY - rect.top) / rect.height * H;
    if (x >= block.x && x <= block.x + block.s && y >= block.y && y <= block.y + block.s) {
      score++;
      flash = 1;
      block.x = 20 + Math.random() * (W - block.s - 40);
      block.y = 20 + Math.random() * (H - block.s - 40);
      block.vx *= 1.06;
      block.vy *= 1.06;
      updateHud();
    }
  });

  // ---------------- 主循环 ----------------

  function loop(ts) {
    requestAnimationFrame(loop);
    var dt = lastTs ? Math.min(ts - lastTs, 100) : 0;   // 切标签页回来别一次补太多
    lastTs = ts;

    if (state === STATE.RUN) {
      block.x += block.vx * dt / 1000;
      block.y += block.vy * dt / 1000;
      if (block.x < 0) { block.x = 0; block.vx = Math.abs(block.vx); }
      if (block.y < 0) { block.y = 0; block.vy = Math.abs(block.vy); }
      if (block.x > W - block.s) { block.x = W - block.s; block.vx = -Math.abs(block.vx); }
      if (block.y > H - block.s) { block.y = H - block.s; block.vy = -Math.abs(block.vy); }

      if (performance.now() >= endAt) { gameOver(); }
      else { updateHud(); }
    }

    render(dt);
  }

  function render(dt) {
    ctx.fillStyle = '#0b1119';
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = 'rgba(120,170,255,.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var gx = 0; gx <= W; gx += 40) { ctx.moveTo(gx, 0); ctx.lineTo(gx, H); }
    for (var gy = 0; gy <= H; gy += 40) { ctx.moveTo(0, gy); ctx.lineTo(W, gy); }
    ctx.stroke();

    var g = ctx.createLinearGradient(block.x, block.y,
        block.x + block.s, block.y + block.s);
    g.addColorStop(0, flash > 0 ? '#b8f7a0' : '#4ea1ff');
    g.addColorStop(1, flash > 0 ? '#06d6a0' : '#2f7fe0');
    ctx.fillStyle = g;
    roundRect(block.x, block.y, block.s, block.s, 14);
    ctx.fill();

    flash = Math.max(0, flash - dt / 200);

    ctx.fillStyle = 'rgba(255,209,102,.95)';
    ctx.font = '600 22px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(String(score), 16, 14);
  }

  // ---------------- 启动 ----------------
  best = readBest();
  btnStart.addEventListener('click', startGame);
  updateHud();
  requestAnimationFrame(loop);
})();
