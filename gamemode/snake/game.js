/* ============================================================
 * 贪吃蛇（纯客户端单机版， gamemode/snake/ ）
 *
 * 规则：
 *   - 方向键 / WASD 控制，禁止 180° 掉头（输入进缓冲队列，手感更跟手）
 *   - 吃普通果实 +10 分并整体提速；每吃 5 颗刷一颗金色果实 +50 分，
 *     金色果实数秒内不吃会消失
 *   - 撞墙或咬到自己即终局；最高分存 localStorage
 *
 * 地图与渲染：
 *   - 地图 30×20 格（960×640 像素），正好一屏装得下——没有镜头，
 *     睁眼就是全场
 *   - 逻辑按固定 tick 推进，画面用 requestAnimationFrame 在相邻两个
 *     tick 之间做插值，低速档也不“一顿一顿”
 *   - 吃到东西 / 死亡有粒子，死亡有屏幕轻震
 *   - 食物光晕用离屏 sprite 缓存画，不再每帧 shadowBlur（软渲染
 *     环境下那是掉帧元凶）
 * ============================================================ */
(function () {
  'use strict';

  // ---------------- 配置 ----------------
  var COLS = 30, ROWS = 20;           // 网格（格）→ 世界 960x640，正好一屏
  var CELL = 32;                      // 每格像素
  var VIEW_W = 960, VIEW_H = 640;     // 视口 = 画布大小 = 整张地图
  var MIN_TICK = 65;                  // 最快步进间隔（ms）
  var SPEED_STEP = 7;                 // 每吃一颗普通果实缩短的 ms
  var FOOD_EVERY = 5;                 // 每吃几颗普通果实刷一颗金色
  var GOLDEN_TTL = 6000;              // 金色果实存活时间（ms）
  var BEST_KEY = 'kaihei.snake.best'; // localStorage 键

  // ---------------- DOM ----------------
  var canvas = document.getElementById('game');
  var ctx = canvas.getContext('2d');
  var overlay = document.getElementById('overlay');
  var scReady = document.getElementById('scReady');
  var scPause = document.getElementById('scPause');
  var scOver = document.getElementById('scOver');
  var elScore = document.getElementById('score');
  var elBest = document.getElementById('best');
  var elLen = document.getElementById('len');
  var elLevel = document.getElementById('level');
  var elOverScore = document.getElementById('overScore');
  var elOverBest = document.getElementById('overBest');
  var elOverTip = document.getElementById('overTip');
  var btnResume = document.getElementById('btnResume');
  var btnRetry = document.getElementById('btnRetry');

  // ---------------- 状态 ----------------
  var STATE = { READY: 0, RUNNING: 1, PAUSED: 2, OVER: 3 };
  var state = STATE.READY;

  var snake = [];          // [{x,y}]，头在 [0]
  var prevSnake = [];      // 上一 tick 的位置（渲染插值用）
  var dir = { x: 1, y: 0 };
  var dirQueue = [];       // 待执行的转向
  var food = null;         // 普通果实
  var golden = null;       // 金色果实
  var goldenUntil = 0;     // 金色果实过期时刻（performance.now 时基）
  var score = 0;
  var best = loadBest();
  var eaten = 0;
  var startTick = 150;     // 当前难度对应的初始步进
  var tickMs = 150;
  var acc = 0;             // tick 累加器
  var lastTs = 0;
  var particles = [];
  var shake = 0;

  // ---------------- 小工具 ----------------
  function loadBest() {
    try { return +(localStorage.getItem(BEST_KEY) || 0) || 0; }
    catch (e) { return 0; }
  }
  function saveBest(v) {
    try { localStorage.setItem(BEST_KEY, String(v)); } catch (e) { /* 隐私模式等场合忽略 */ }
  }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function onSnake(x, y) {
    for (var i = 0; i < snake.length; i++) {
      if (snake[i].x === x && snake[i].y === y) { return true; }
    }
    return false;
  }
  function level() { return 1 + Math.floor(eaten / 5); }

  // ---------------- 游戏流程 ----------------
  function startGame(tick) {
    startTick = tick;
    tickMs = tick;
    score = 0; eaten = 0; acc = 0;
    particles = []; shake = 0;
    dir = { x: 1, y: 0 };
    dirQueue = [];
    // 初始蛇：水平 3 节，放在地图正中
    var cx = (COLS / 2) | 0, cy = (ROWS / 2) | 0;
    snake = [{ x: cx, y: cy }, { x: cx - 1, y: cy }, { x: cx - 2, y: cy }];
    prevSnake = snake.map(function (s) { return { x: s.x, y: s.y }; });
    food = randomEmpty();
    golden = null;
    state = STATE.RUNNING;
    showScreen(null);
    updateHud();
  }

  function die() {
    state = STATE.OVER;
    shake = 14;
    // 沿身子炸一圈粒子
    for (var i = 0; i < snake.length; i += 2) {
      burst((snake[i].x + 0.5) * CELL, (snake[i].y + 0.5) * CELL, '#67d98a', 5, 3);
    }
    var isBest = score > best;
    if (isBest) { best = score; saveBest(best); }
    elOverScore.textContent = score;
    elOverBest.textContent = best;
    elOverTip.textContent = isBest ? '🎉 新纪录！' : '差一点，再来一局？';
    elOverTip.className = isBest ? 'newbest' : '';
    showScreen('over');
    updateHud();
  }

  function tick() {
    // 执行一个排队的转向（pushDir 已过滤掉非法方向）
    if (dirQueue.length) { dir = dirQueue.shift(); }

    var head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
    prevSnake = snake.map(function (s) { return { x: s.x, y: s.y }; });

    // 撞墙
    if (head.x < 0 || head.y < 0 || head.x >= COLS || head.y >= ROWS) { die(); return; }

    var willEat = food && head.x === food.x && head.y === food.y;
    // 撞自己：不长身体时，尾巴末格这一步会让出来，不算
    var limit = willEat ? snake.length : snake.length - 1;
    for (var i = 0; i < limit; i++) {
      if (snake[i].x === head.x && snake[i].y === head.y) { die(); return; }
    }

    snake.unshift(head);
    if (willEat) {
      onEatFood();
    } else {
      snake.pop();
    }
    if (golden && head.x === golden.x && head.y === golden.y) {
      onEatGolden();
    }
  }

  function onEatFood() {
    score += 10;
    eaten++;
    burst((food.x + 0.5) * CELL, (food.y + 0.5) * CELL, '#ff6b6b', 10, 3.2);
    food = randomEmpty();
    tickMs = Math.max(MIN_TICK, startTick - eaten * SPEED_STEP);
    if (eaten % FOOD_EVERY === 0 && !golden) {
      golden = randomEmpty();
      goldenUntil = performance.now() + GOLDEN_TTL;
    }
    updateHud();
  }

  function onEatGolden() {
    score += 50;
    burst((golden.x + 0.5) * CELL, (golden.y + 0.5) * CELL, '#ffd166', 16, 4);
    golden = null;
    updateHud();
  }

  function randomEmpty() {
    var tries = 0, x, y;
    while (tries++ < 600) {
      x = (Math.random() * COLS) | 0;
      y = (Math.random() * ROWS) | 0;
      if (!onSnake(x, y) && !(food && food.x === x && food.y === y)
          && !(golden && golden.x === x && golden.y === y)) {
        return { x: x, y: y };
      }
    }
    // 兜底：顺序扫描第一个空格
    for (y = 0; y < ROWS; y++) {
      for (x = 0; x < COLS; x++) {
        if (!onSnake(x, y)) { return { x: x, y: y }; }
      }
    }
    return null; // 理论上铺满全屏才会到这
  }

  // ---------------- 输入 ----------------
  var DIRS = {
    up: { x: 0, y: -1 }, down: { x: 0, y: 1 },
    left: { x: -1, y: 0 }, right: { x: 1, y: 0 }
  };
  var KEYMAP = {
    ArrowUp: 'up', KeyW: 'up',
    ArrowDown: 'down', KeyS: 'down',
    ArrowLeft: 'left', KeyA: 'left',
    ArrowRight: 'right', KeyD: 'right'
  };

  function pushDir(name) {
    var d = DIRS[name];
    var last = dirQueue.length ? dirQueue[dirQueue.length - 1] : dir;
    if (d.x === -last.x && d.y === -last.y) { return; }  // 禁止 180° 掉头
    if (d.x === last.x && d.y === last.y) { return; }    // 同向忽略
    if (dirQueue.length < 3) { dirQueue.push(d); }
  }

  window.addEventListener('keydown', function (e) {
    var name = KEYMAP[e.code];
    if (name) {
      e.preventDefault();
      if (state === STATE.RUNNING) { pushDir(name); }
      return;
    }
    if (e.code === 'Space') {
      e.preventDefault();
      if (state === STATE.RUNNING) { pause(); }
      else if (state === STATE.PAUSED) { resume(); }
      return;
    }
    if (e.code === 'Enter' || e.code === 'KeyR') {
      e.preventDefault();
      if (state === STATE.OVER) { startGame(startTick); }
      else if (state === STATE.READY) { startGame(150); }
    }
  });

  // 触屏滑动
  var touchStart = null;
  canvas.addEventListener('touchstart', function (e) {
    if (e.touches.length === 1) {
      touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
  }, { passive: true });
  canvas.addEventListener('touchmove', function (e) {
    if (!touchStart || state !== STATE.RUNNING) { return; }
    var t = e.touches[0];
    var dx = t.clientX - touchStart.x, dy = t.clientY - touchStart.y;
    if (Math.abs(dx) < 24 && Math.abs(dy) < 24) { return; }
    if (Math.abs(dx) > Math.abs(dy)) { pushDir(dx > 0 ? 'right' : 'left'); }
    else { pushDir(dy > 0 ? 'down' : 'up'); }
    touchStart = { x: t.clientX, y: t.clientY };
    e.preventDefault();
  }, { passive: false });

  // 难度按钮 / 覆盖层按钮
  Array.prototype.forEach.call(document.querySelectorAll('[data-speed]'), function (b) {
    b.addEventListener('click', function () { startGame(+b.getAttribute('data-speed')); });
  });
  btnResume.addEventListener('click', resume);
  btnRetry.addEventListener('click', function () { startGame(startTick); });

  // 切走标签页自动暂停，回来不会已经撞死
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && state === STATE.RUNNING) { pause(); }
  });

  function pause() {
    if (state !== STATE.RUNNING) { return; }
    state = STATE.PAUSED;
    showScreen('pause');
  }
  function resume() {
    if (state !== STATE.PAUSED) { return; }
    state = STATE.RUNNING;
    showScreen(null);
  }

  // ---------------- 界面 ----------------
  function showScreen(which) {
    overlay.classList.toggle('hidden', !which);
    scReady.classList.toggle('hidden', which !== 'ready');
    scPause.classList.toggle('hidden', which !== 'pause');
    scOver.classList.toggle('hidden', which !== 'over');
  }
  function updateHud() {
    elScore.textContent = score;
    elBest.textContent = best;
    elLen.textContent = snake.length;
    elLevel.textContent = level();
  }

  // ---------------- 粒子 ----------------
  function burst(cx, cy, color, n, power) {
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2;
      var sp = (0.3 + Math.random() * 0.7) * power;
      particles.push({
        x: cx, y: cy,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 1, decay: 0.02 + Math.random() * 0.025,
        color: color, size: 2 + Math.random() * 3
      });
    }
  }

  // ---------------- 更新 ----------------
  function update(dt, ts) {
    var k = dt / 16.7;   // 归一到 60fps 的“帧”单位

    // 金色果实过期
    if (golden && ts > goldenUntil) { golden = null; }

    // 粒子
    for (var i = particles.length - 1; i >= 0; i--) {
      var p = particles[i];
      p.x += p.vx * k; p.y += p.vy * k;
      p.vy += 0.06 * k;          // 一点重力
      p.life -= p.decay * k;
      if (p.life <= 0) { particles.splice(i, 1); }
    }

    if (shake > 0) { shake = Math.max(0, shake - 0.5 * k); }
  }

  // ---------------- 渲染 ----------------
  function drawGrid() {
    ctx.fillStyle = '#0b1119';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    // 格子线（整张地图一屏装得下，全画即可）
    ctx.strokeStyle = 'rgba(120,170,255,0.055)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var x = 1; x < COLS; x++) {
      var sx = Math.round(x * CELL) + .5;
      ctx.moveTo(sx, 0); ctx.lineTo(sx, VIEW_H);
    }
    for (var y = 1; y < ROWS; y++) {
      var sy = Math.round(y * CELL) + .5;
      ctx.moveTo(0, sy); ctx.lineTo(VIEW_W, sy);
    }
    ctx.stroke();
  }

  // 果实光晕 sprite：离屏画一次，之后每帧只 drawImage
  var foodSprite = null, goldSprite = null;
  function makeGlowDisc(color, glow, blur) {
    var r = Math.ceil(CELL * 0.3) + blur + 4;
    var c = document.createElement('canvas');
    c.width = c.height = r * 2;
    var g = c.getContext('2d');
    g.shadowColor = glow;
    g.shadowBlur = blur;
    g.fillStyle = color;
    g.beginPath();
    g.arc(r, r, CELL * 0.3, 0, Math.PI * 2);
    g.fill();
    return { c: c, r: r };
  }

  function drawFood(ts) {
    if (!food) { return; }
    var cx = (food.x + 0.5) * CELL, cy = (food.y + 0.5) * CELL;
    var pulse = 1 + 0.1 * Math.sin(ts / 140);
    ctx.drawImage(foodSprite.c, cx - foodSprite.r * pulse, cy - foodSprite.r * pulse,
            foodSprite.r * 2 * pulse, foodSprite.r * 2 * pulse);
    // 高光
    ctx.fillStyle = 'rgba(255,255,255,.5)';
    ctx.beginPath();
    ctx.arc(cx - CELL * 0.09, cy - CELL * 0.1, CELL * 0.07, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawGolden(ts) {
    if (!golden) { return; }
    var cx = (golden.x + 0.5) * CELL, cy = (golden.y + 0.5) * CELL;
    var pulse = 1 + 0.14 * Math.sin(ts / 110);
    // 剩余时间环
    var remain = clamp((goldenUntil - ts) / GOLDEN_TTL, 0, 1);
    ctx.strokeStyle = 'rgba(255,209,102,.75)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(cx, cy, CELL * 0.42, -Math.PI / 2, -Math.PI / 2 + remain * Math.PI * 2);
    ctx.stroke();
    ctx.drawImage(goldSprite.c, cx - goldSprite.r * pulse, cy - goldSprite.r * pulse,
            goldSprite.r * 2 * pulse, goldSprite.r * 2 * pulse);
    ctx.fillStyle = '#8a6420';
    ctx.font = 'bold 15px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('★', cx, cy + 1);
  }

  function drawSnake(t) {
    var n = snake.length;
    for (var i = n - 1; i >= 0; i--) {
      var cur = snake[i];
      var pre = prevSnake[i] || cur;
      var x = (pre.x + (cur.x - pre.x) * t) * CELL;
      var y = (pre.y + (cur.y - pre.y) * t) * CELL;
      // 身子颜色：头亮尾深
      var f = n > 1 ? i / (n - 1) : 0;
      var r = Math.round(103 + (43 - 103) * f);
      var g = Math.round(217 + (122 - 217) * f);
      var b = Math.round(138 + (94 - 138) * f);
      ctx.fillStyle = i === 0 ? '#b8f7a0' : 'rgb(' + r + ',' + g + ',' + b + ')';
      roundRect(x + 1.5, y + 1.5, CELL - 3, CELL - 3, 7);
      ctx.fill();

      if (i === 0) { drawEyes(x, y); }
    }
  }

  function drawEyes(x, y) {
    var cx = x + CELL / 2, cy = y + CELL / 2;
    var ex = dir.x, ey = dir.y;
    // 眼睛分别落在朝向的垂直两侧
    var px = -ey, py = ex;
    var off = CELL * 0.17, fwd = CELL * 0.14;
    ctx.fillStyle = '#0b1119';
    ctx.beginPath();
    ctx.arc(cx + ex * fwd + px * off, cy + ey * fwd + py * off, CELL * 0.085, 0, Math.PI * 2);
    ctx.arc(cx + ex * fwd - px * off, cy + ey * fwd - py * off, CELL * 0.085, 0, Math.PI * 2);
    ctx.fill();
  }

  /**
   * 圆角矩形路径（标准四段 arcTo）。
   *
   * 注意：arcTo(x1,y1,x2,y2,r) 里「第一控制点 == 终点」时会按规范退化成一条
   * 直线。曾误写成
   *   arcTo(x+w, y+h, x+w, y+h, r); arcTo(x+w, y, x+w, y, r);
   * 于是路径变成自重叠路径，净环绕数为 0，fill() 几乎填不出面积——
   * 蛇身渲染成一节节小楔形，看着像「透明」。正确写法必须四个控制点各不相同。
   */
  function roundRect(x, y, w, h, r) {
    var rr = Math.min(r, w / 2, h / 2);
    if (rr < 0) { rr = 0; }
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function drawParticles() {
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      ctx.globalAlpha = clamp(p.life, 0, 1);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
  }

  function render(ts) {
    var t = state === STATE.RUNNING ? clamp(acc / tickMs, 0, 1) : 1;
    ctx.save();
    if (shake > 0) {
      ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
    }
    drawGrid();
    drawFood(ts);
    drawGolden(ts);
    if (state === STATE.READY) {
      // 待机画面：盘成一坨给大家看（放在地图正中）
      var cx = (COLS / 2) | 0, cy = (ROWS / 2) | 0;
      var demo = [{ x: cx, y: cy }, { x: cx - 1, y: cy }, { x: cx - 1, y: cy + 1 }, { x: cx, y: cy + 1 }, { x: cx + 1, y: cy + 1 }];
      for (var i = demo.length - 1; i >= 0; i--) {
        ctx.fillStyle = i === 0 ? '#b8f7a0' : 'rgb(67,150,110)';
        roundRect(demo[i].x * CELL + 1.5, demo[i].y * CELL + 1.5, CELL - 3, CELL - 3, 7);
        ctx.fill();
      }
      drawEyes(demo[0].x * CELL, demo[0].y * CELL);
    } else {
      drawSnake(t);
    }
    drawParticles();
    ctx.restore();
  }

  // ---------------- 主循环 ----------------
  function loop(ts) {
    requestAnimationFrame(loop);
    var dt = lastTs ? (ts - lastTs) : 0;
    lastTs = ts;
    if (dt > 100) { dt = 100; }   // 切标签页回来不要一次补太多

    if (state === STATE.RUNNING) {
      acc += dt;
      var guard = 0;
      while (acc >= tickMs && state === STATE.RUNNING && guard < 8) {
        acc -= tickMs;
        tick();
        guard++;
      }
    }
    update(dt, ts);
    render(ts);
  }

  // ---------------- 启动 ----------------
  foodSprite = makeGlowDisc('#ff6b6b', 'rgba(255,107,107,.55)', 14);
  goldSprite = makeGlowDisc('#ffd166', 'rgba(255,209,102,.7)', 18);
  showScreen('ready');
  updateHud();
  requestAnimationFrame(loop);
})();
