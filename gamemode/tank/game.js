/* 联机坦克大战前端。
   分工：服务器算一切（移动、转身、子弹、弹药、命中、掉血、障碍耐久、视野、警戒），
   客户端只做三件事——把「按键 + 瞄准 + 是否开火 + 已收到的事件 id」发上去，
   把世界画出来，把音效放出来。

   画面：地图比视口大得多，相机始终把"自己这辆坦克"钉在画面正中心。 */
(function () {
  'use strict';

  // 按键位（要和 GameWorld 里的 K_UP 等保持一致）
  var K_UP = 1, K_DOWN = 2, K_LEFT = 4, K_RIGHT = 8;

  // 同步节奏：服务器 30Hz，客户端略快一点点去追
  var SYNC_MS = 34;

  // 位置平滑系数（每秒），越大越"跟手"但抖动越多
  var SMOOTH_ME = 26;
  var SMOOTH_OTHER = 18;

  var canvas = document.getElementById('game');
  var ctx = canvas.getContext('2d');
  var overlay = document.getElementById('overlay');
  var joinBtn = document.getElementById('join');
  var joinErr = document.getElementById('joinErr');
  var boardEl = document.getElementById('board');
  var statusEl = document.getElementById('status');

  var VW = canvas.width;
  var VH = canvas.height;

  // ---------- 世界状态 ----------
  var W = 80, H = 60, CELL = 32, TANK_HALF = 13;
  var OBS_HP = 3;               // 障碍物满耐久（快照里的 obsHp 会覆盖它）
  var VHALF = Math.PI / 4;      // 视野半角（左右各 45°）
  var VRANGE = 10 * 32;         // 视野半径（10 格）
  var obs = new Int16Array(W * H);
  var mapRev = -1;

  var me = null;
  var joined = false;

  var tanksById = {};   // id -> { rx, ry, rba, rta, tx, ty, tba, tta }
                        //   rx/ry: 渲染位置（平滑）   tx/ty: 服务器目标位置
                        //   rba/rta: 渲染车身角/炮塔角   tba/tta: 服务器目标车身角/炮塔角
  var srvTanks = [];    // 服务器最近一次给的"看得见的"坦克（自己 + 视野内敌人）
  var board = [];       // 排行榜（所有人，只有名字/击杀，不含坐标）
  var bullets = [];     // 服务器最近一次给的所有子弹
  var bulletsAt = 0;    // 收到这批子弹的「本地时刻」，用来按速度外推（兼顾本机/异地时钟差）
  var warns = [];       // 警戒：[{ a: 指向敌人的角度, d: 距离, left: 还要闪多久(ms) }]
  var warnsAt = 0;
  var lastEv = 0;       // 已处理的世界事件 id（去重用）
  var myName = '';      // 启动器「名字登记」栏下发的名字（≤10 字）；没收到就退回本地记录/随机名

  var keyBits = 0;
  var firing = false;
  var mouseX = VW / 2, mouseY = VH / 2;

  var hp = 5, alive = true, kills = 0;
  var ammo = 5, maxAmmo = 5, reloadIn = 0, reloadMs = 2000;
  var prevShots = null, prevReloads = null;   // 用服务器给的累计计数器来触发音效

  var cam = { x: W * CELL / 2, y: H * CELL / 2 };
  var lastRender = 0;
  var missCount = 0;
  var rejoining = false;
  var lastJoinTry = 0;

  // =========================================================
  // 音效（WebAudio）
  //   资源来自 Mixkit Free Sound Effects（免费商用、无需署名）。
  //   浏览器要求「用户操作后才能出声」，所以在点"加入战斗"时初始化。
  // =========================================================

  var SFX_FILES = {
    shot: 'shot.mp3',           // 开炮
    reload: 'reload.mp3',       // 换弹（补回一发）
    boomTank: 'boom_tank.mp3',  // 击毁敌方坦克
    boomBrick: 'boom_brick.mp3' // 摧毁障碍物
  };
  var actx = null;
  var sndBuf = {};
  var lastDistantShot = 0;

  function initAudio() {
    if (actx) {
      if (actx.state === 'suspended' && actx.resume) { actx.resume(); }
      return;
    }
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { return; }
    try { actx = new AC(); } catch (e) { actx = null; return; }
    Object.keys(SFX_FILES).forEach(function (k) {
      fetch('sfx/' + SFX_FILES[k])
        .then(function (r) { return r.arrayBuffer(); })
        .then(function (ab) { return actx.decodeAudioData(ab); })
        .then(function (buf) { sndBuf[k] = buf; })
        .catch(function () { /* 音效缺席不影响游戏 */ });
    });
  }

  function playSfx(name, vol, rate) {
    if (!actx) { return; }
    var buf = sndBuf[name];
    if (!buf) { return; }
    try {
      var src = actx.createBufferSource();
      src.buffer = buf;
      if (rate) { src.playbackRate.value = rate; }
      var g = actx.createGain();
      g.gain.value = (vol == null ? 0.9 : vol);
      src.connect(g);
      g.connect(actx.destination);
      src.start(0);
    } catch (e) { /* 播放失败忽略 */ }
  }

  // =========================================================
  // 与服务器通信
  // =========================================================

  function post(path, params) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      cache: 'no-store'
    }).then(function (r) { return r.json(); });
  }

  // 每个浏览器标签一个稳定身份。断线重连时服务器靠它把「原来那辆车」
  // 认回来——不然重连等于换个新号，旧号还会在世界里跑 30 秒，
  // 就会出现「地图上两个自己、榜单两条」的怪事。
  // 存 sessionStorage：同一标签刷新/重连都还在，关掉标签自然失效。
  function getCid() {
    try {
      var c = sessionStorage.getItem('tankCid');
      if (!c) {
        c = 'c' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        sessionStorage.setItem('tankCid', c);
      }
      return c;
    } catch (e) {
      return null;   // 隐私模式等拿不到 storage 时退回旧行为（每次新号）
    }
  }

  // 启动器（父页面，游戏跑在它的 iframe 里）只下发一样东西：右上角「名字登记」
  // 栏的名字，点「开始」直接用。表情和聊天是启动器自己的功能（走 /api/chat
  // 公共频道），与游戏无联系——这里不接、也不往启动器推任何东西。
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (d && d.kaihei === 'name' && typeof d.n === 'string') {
      myName = d.n.slice(0, 10);
    }
  });

  function joinGame() {
    var now = Date.now();
    if (rejoining && now - lastJoinTry < 2000) {
      return;
    }
    lastJoinTry = now;
    // 名字唯一来源：启动器「名字登记」栏（postMessage 下发）。没有就拒——
    // 匿名不让进，去右上角登记（≤10 字）。
    var name = (myName || '').trim();
    if (!name) {
      joinBtn.disabled = false;
      joinErr.textContent = '请先在启动器右上角「名字登记」里填个名字（≤10 字）';
      return;
    }
    myName = name;

    initAudio();   // 借"点加入"这个用户手势把 AudioContext 打开

    var params = { name: name };
    var cid = getCid();
    if (cid) { params.cid = cid; }

    post('/api/tank/join', params).then(function (d) {
      if (!d || !d.id) {
        // 服务端会把原因放在 error 里（如「游戏未启动…」），透给玩家看，
        // 别吞成通用的「连不上服务器」——服务器开着时那句话会误导人。
        throw new Error((d && d.error) || 'join failed');
      }
      me = d.id;
      joined = true;
      rejoining = false;
      missCount = 0;
      mapRev = -1;                 // 让下一次 sync 拉整张地图
      lastEv = 0;                  // 服务器若重启过，事件 id 会从头来
      prevShots = null;            // 第一帧不触发开炮/换弹音效
      prevReloads = null;
      tanksById = {};
      warns = [];
      bullets = [];
      if (d.hp) { hp = d.hp; }
      overlay.classList.add('hidden');
      statusEl.textContent = '';
      syncLoop();
    }).catch(function (err) {
      joined = false;
      overlay.classList.remove('hidden');
      joinErr.textContent = (err && err.message && err.message !== 'join failed')
          ? err.message
          : '连不上服务器，请确认服务器窗口还开着。';
    });
  }

  function syncLoop() {
    if (!joined || !me) {
      return;
    }
    // 瞄准角：坦克在画面中心，所以直接用鼠标相对中心的方向
    var aim = Math.atan2(mouseY - VH / 2, mouseX - VW / 2);
    post('/api/tank/sync', {
      id: me,
      k: keyBits,
      a: aim.toFixed(3),
      f: firing ? 1 : 0,
      rev: mapRev,
      ev: lastEv
    }).then(function (d) {
      missCount = 0;
      applyState(d);
      setTimeout(syncLoop, SYNC_MS);
    }).catch(function () {
      missCount++;
      if (missCount >= 3) {
        tryRejoin();
      }
      setTimeout(syncLoop, 300);
    });
  }

  function tryRejoin() {
    if (rejoining) {
      return;
    }
    rejoining = true;
    joined = false;
    me = null;
    statusEl.textContent = '与服务器断开，正在重连…';
    joinGame();
  }

  function applyState(d) {
    if (!d) {
      return;
    }
    if (d.w) { W = d.w; H = d.h; }
    if (d.cell) { CELL = d.cell; }
    if (d.tankHalf) { TANK_HALF = d.tankHalf; }
    if (d.obsHp) { OBS_HP = d.obsHp; }      // 障碍物满耐久（服务端下发，改数值不用动前端）
    if (d.vhalf) { VHALF = d.vhalf; }
    if (d.vrange) { VRANGE = d.vrange; }
    if (obs.length !== W * H) { obs = new Int16Array(W * H); mapRev = -1; }

    // 地图：整图 或 增量
    if (d.map) {
      if (d.map.full) {
        obs = new Int16Array(W * H);
        (d.map.cells || []).forEach(function (c) { obs[c[1] * W + c[0]] = c[2]; });
      } else {
        (d.map.ch || []).forEach(function (c) {
          if (c[1] >= 0 && c[1] < H && c[0] >= 0 && c[0] < W) {
            obs[c[1] * W + c[0]] = c[2];
          }
        });
      }
      mapRev = d.map.rev;
    }

    // 坦克（服务器已经只给了「自己 + 视野内敌人」）
    var seen = {};
    srvTanks = d.tanks || [];
    srvTanks.forEach(function (t) {
      seen[t.id] = true;
      var e = tanksById[t.id];
      if (!e) {
        // rba/rta = 当前渲染角（车身/炮塔），tba/tta = 服务器给的目标角
        e = { rx: t.x, ry: t.y, rba: t.ba || 0, rta: t.a || 0,
              tx: t.x, ty: t.y, tba: t.ba || 0, tta: t.a || 0 };
        tanksById[t.id] = e;
      }
      e.tx = t.x;
      e.ty = t.y;
      e.tba = t.ba || 0;   // 车身目标朝向（随移动方向）
      e.tta = t.a || 0;    // 炮塔目标朝向（随鼠标）
    });
    Object.keys(tanksById).forEach(function (id) {
      if (!seen[id]) { delete tanksById[id]; }   // 走出视野就消失
    });

    // 排行榜（全服，不含坐标）
    if (d.board) { board = d.board; }

    // 自己
    if (d.me) {
      hp = d.me.hp;
      alive = d.me.alive;
      kills = d.me.kills;
      if (typeof d.me.maxAmmo === 'number') { maxAmmo = d.me.maxAmmo; }
      if (typeof d.me.reloadMs === 'number' && d.me.reloadMs > 0) { reloadMs = d.me.reloadMs; }
      reloadIn = d.me.reloadIn || 0;
      if (typeof d.me.ammo === 'number') { ammo = d.me.ammo; }
      // 音效用服务器给的累计计数器判定：
      //   弹匣空着还按着开火时，「补弹 + 开火」发生在同一个 tick，ammo 是 0→0，
      //   看 ammo 变化会完全漏掉，所以必须用计数器。
      if (typeof d.me.shots === 'number') {
        if (prevShots != null && d.me.shots > prevShots) { playSfx('shot', 0.9, 1); }
        prevShots = d.me.shots;
      }
      if (typeof d.me.reloads === 'number') {
        if (prevReloads != null && d.me.reloads > prevReloads) { playSfx('reload', 0.55, 1); }
        prevReloads = d.me.reloads;
      }
    } else if (me) {
      // 服务器里已经没有我这号人了（被超时清掉 / 服务器重启）→ 重连
      tryRejoin();
      return;
    }

    // 警戒：视野外敌人开火的方向提示
    warns = d.warns || [];
    warnsAt = Date.now();

    bullets = d.bullets || [];
    bulletsAt = Date.now();

    // 世界事件 → 爆炸音效（只处理没见过的；视野外的静音）
    var evs = d.events || [];
    for (var i = 0; i < evs.length; i++) {
      var e = evs[i];
      if (!e || e.id <= lastEv) { continue; }
      lastEv = e.id;
      if (!inHearing(e.x, e.y)) { continue; }
      playSfx(e.type === 'kill' ? 'boomTank' : 'boomBrick',
              e.type === 'kill' ? 0.9 : 0.7,
              e.type === 'kill' ? 1 : 1.2);
    }

    renderBoard();
  }

  // =========================================================
  // 视野辅助（服务器已经过滤过一次，这里是"保险"式的本地过滤，
  //   阈值放宽一点，只用来兜掉明显在视野外的东西，避免边缘闪烁）
  // =========================================================

  function norm(a) {
    return Math.atan2(Math.sin(a), Math.cos(a));
  }

  function meEnt() {
    return me ? tanksById[me] : null;
  }

  function inVisionPoint(x, y, rMul, aMul) {
    var m = meEnt();
    if (!m) { return false; }
    var dx = x - m.rx, dy = y - m.ry;
    var r = VRANGE * (rMul || 1);
    if (dx * dx + dy * dy > r * r) { return false; }
    return Math.abs(norm(Math.atan2(dy, dx) - m.rba)) <= VHALF * (aMul || 1);
  }

  function inHearing(x, y) {
    var m = meEnt();
    if (!m) { return true; }
    var dx = x - m.rx, dy = y - m.ry;
    var r = VRANGE * 1.4;
    return dx * dx + dy * dy <= r * r;
  }

  function renderBoard() {
    var arr = board.slice().sort(function (a, b) { return (b.k || 0) - (a.k || 0); });
    boardEl.innerHTML = '';
    if (!arr.length) {
      var li0 = document.createElement('li');
      li0.className = 'sub';
      li0.textContent = '等待玩家加入…';
      boardEl.appendChild(li0);
      return;
    }
    arr.forEach(function (t) {
      var li = document.createElement('li');
      if (t.id === me) { li.className = 'me'; }
      var dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = t.c || '#4ea1ff';
      var nm = document.createElement('span');
      nm.textContent = (t.n || '玩家') + (t.alive ? '' : '（阵亡）');
      var sc = document.createElement('b');
      sc.textContent = String(t.k || 0);
      li.appendChild(dot);
      li.appendChild(nm);
      li.appendChild(sc);
      boardEl.appendChild(li);
    });
  }

  // =========================================================
  // 渲染
  // =========================================================

  function angLerp(a, b, t) {
    var d = ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    return a + d * t;
  }

  function relax(cur, target, k, dt) {
    return cur + (target - cur) * (1 - Math.exp(-k * dt));
  }

  function updateEntities(dt) {
    Object.keys(tanksById).forEach(function (id) {
      var e = tanksById[id];
      var k = (id === me) ? SMOOTH_ME : SMOOTH_OTHER;
      e.rx = relax(e.rx, e.tx, k, dt);
      e.ry = relax(e.ry, e.ty, k, dt);
      // 车身/炮塔的转动速度已经由服务端限定了（都是 1s/90°），
      // 客户端只做很轻的一点平滑，用来抹掉 30Hz 的台阶感，不改变转向快慢。
      var ka = 1 - Math.exp(-(k + 14) * dt);
      e.rba = angLerp(e.rba, e.tba, ka);
      e.rta = angLerp(e.rta, e.tta, ka);
    });
    // 相机：把自己钉在正中心
    var m = meEnt();
    if (m) {
      cam.x = m.rx;
      cam.y = m.ry;
    }
  }

  function w2sx(x) { return x - cam.x + VW / 2; }
  function w2sy(y) { return y - cam.y + VH / 2; }

  function draw(dt) {
    var now = Date.now();

    // 背景（地图之外是"虚空"）
    ctx.fillStyle = '#070a10';
    ctx.fillRect(0, 0, VW, VH);

    // 战场地面
    var gx = w2sx(0), gy = w2sy(0);
    var gw = W * CELL, gh = H * CELL;
    ctx.fillStyle = '#111a26';
    ctx.fillRect(gx, gy, gw, gh);

    // 网格
    var x0 = Math.max(0, Math.floor((cam.x - VW / 2) / CELL));
    var x1 = Math.min(W - 1, Math.floor((cam.x + VW / 2) / CELL));
    var y0 = Math.max(0, Math.floor((cam.y - VH / 2) / CELL));
    var y1 = Math.min(H - 1, Math.floor((cam.y + VH / 2) / CELL));

    ctx.strokeStyle = 'rgba(120,170,255,.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var x = x0; x <= x1 + 1; x++) {
      var sx = Math.floor(w2sx(x * CELL)) + 0.5;
      ctx.moveTo(sx, gy);
      ctx.lineTo(sx, gy + gh);
    }
    for (var y = y0; y <= y1 + 1; y++) {
      var sy = Math.floor(w2sy(y * CELL)) + 0.5;
      ctx.moveTo(gx, sy);
      ctx.lineTo(gx + gw, sy);
    }
    ctx.stroke();

    // 视野扇形（车身正前方左右各 45°，长 10 格）
    drawVision();

    // 障碍物：颜色随耐久变化（打掉越多越暗越"破"）
    for (var yy = y0; yy <= y1; yy++) {
      for (var xx = x0; xx <= x1; xx++) {
        var hpo = obs[yy * W + xx];
        if (hpo <= 0) { continue; }
        var frac = hpo / OBS_HP;   // 满耐久=1；3 点耐久下正好是 1.0 / 0.67 / 0.33 三档
        var px = w2sx(xx * CELL);
        var py = w2sy(yy * CELL);
        ctx.fillStyle = 'rgb(' + Math.round(120 + 60 * frac) + ',' + Math.round(95 + 55 * frac) + ',' + Math.round(70 + 45 * frac) + ')';
        ctx.fillRect(px + 1, py + 1, CELL - 2, CELL - 2);
        // 破损：耐久越低，裂纹越多
        if (frac < 0.7) {
          ctx.fillStyle = 'rgba(0,0,0,' + (0.35 * (1 - frac)) + ')';
          ctx.fillRect(px + 4, py + 4, CELL - 8, 3);
        }
        if (frac < 0.4) {
          ctx.fillStyle = 'rgba(0,0,0,0.35)';
          ctx.fillRect(px + 4, py + CELL - 8, CELL - 8, 3);
        }
      }
    }

    // 子弹
    bullets.forEach(function (b) {
      // 用「收到快照的本地时刻」外推，避免依赖服务器/客户端时钟一致。
      var age = (now - bulletsAt) / 1000;
      if (!(age > 0) || age > 0.4) { age = 0; }
      var bx = b.x + b.vx * age;
      var by = b.y + b.vy * age;
      var sx = w2sx(bx), sy = w2sy(by);
      ctx.beginPath();
      ctx.arc(sx, sy, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#ffe08a';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(sx, sy, 7, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,190,80,.25)';
      ctx.fill();
    });

    // 坦克（再兜一层：明显在视野外的不画）
    srvTanks.forEach(function (t) {
      var e = tanksById[t.id];
      if (!e) { return; }
      if (t.id !== me && !inVisionPoint(e.rx, e.ry, 1.25, 1.5)) { return; }
      drawTank(t, e, t.id === me);
    });

    // 转身提示：车身还没转到移动方向时，画个转圈指示
    drawTurningHint();

    // 警戒标志：视野外的敌人开火 → 车身外一格闪"指向他"的三角
    drawWarns();

    // 准星 + 瞄准参考线
    if (joined && alive) {
      ctx.strokeStyle = 'rgba(255,255,255,.18)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(VW / 2, VH / 2);
      ctx.lineTo(mouseX, mouseY);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,255,255,.75)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(mouseX, mouseY, 9, 0, Math.PI * 2);
    ctx.moveTo(mouseX - 14, mouseY);
    ctx.lineTo(mouseX - 4, mouseY);
    ctx.moveTo(mouseX + 4, mouseY);
    ctx.lineTo(mouseX + 14, mouseY);
    ctx.moveTo(mouseX, mouseY - 14);
    ctx.lineTo(mouseX, mouseY - 4);
    ctx.moveTo(mouseX, mouseY + 4);
    ctx.lineTo(mouseX, mouseY + 14);
    ctx.stroke();

    drawHud();

    if (!alive) {
      ctx.fillStyle = 'rgba(255,120,120,.92)';
      ctx.font = '600 20px "Segoe UI","Microsoft YaHei",sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('坦克被击毁，3 秒后复活…', VW / 2, VH / 2 - 60);
      ctx.textAlign = 'left';
    }
  }

  /** 视野扇形：以自己车身朝向为轴，左右各 VHALF，半径 VRANGE。 */
  function drawVision() {
    var m = meEnt();
    if (!m) { return; }
    var cx = w2sx(m.rx), cy = w2sy(m.ry);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(m.rba);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, VRANGE, -VHALF, VHALF);
    ctx.closePath();
    ctx.fillStyle = 'rgba(120,200,255,.065)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(140,210,255,.22)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  /** 车身还没转到位时给个提示（转 90° 要 1 秒，这段时间坦克不会动）。 */
  function drawTurningHint() {
    var m = meEnt();
    if (!m || !joined || !alive) { return; }
    var want = wantAngle();
    if (want == null) { return; }
    if (Math.abs(norm(want - m.rba)) < 0.12) { return; }

    var cx = w2sx(m.rx), cy = w2sy(m.ry);
    var t = Date.now() / 1000;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.globalAlpha = 0.5 + 0.3 * Math.sin(t * 8);
    ctx.beginPath();
    ctx.arc(0, 0, TANK_HALF + 9, -Math.PI * 0.75, -Math.PI * 0.25);
    ctx.strokeStyle = '#ffd166';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  /** 当前按键想去的世界方向（没有按键则返回 null）。 */
  function wantAngle() {
    var dx = 0, dy = 0;
    if (keyBits & K_RIGHT) { dx += 1; }
    if (keyBits & K_LEFT) { dx -= 1; }
    if (keyBits & K_DOWN) { dy += 1; }
    if (keyBits & K_UP) { dy -= 1; }
    if (dx === 0 && dy === 0) { return null; }
    return Math.atan2(dy, dx);
  }

  /** 警戒标志：视野外的敌人开火 → 车身外一格画个指向他的三角。 */
  function drawWarns() {
    var m = meEnt();
    if (!m || !warns.length) { return; }
    var cx = w2sx(m.rx), cy = w2sy(m.ry);
    var r = TANK_HALF + CELL;      // "车身外一格"
    var age = Date.now() - warnsAt;
    var t = Date.now() / 1000;

    warns.forEach(function (w) {
      var left = (w.left || 0) - age;
      if (left <= 0) { return; }
      var fade = Math.min(1, left / 600);
      var pulse = 0.55 + 0.45 * Math.abs(Math.sin(t * 7));
      var a = w.a || 0;
      ctx.save();
      ctx.translate(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      ctx.rotate(a);
      ctx.globalAlpha = fade * pulse;
      // 指向敌人（外侧）的三角
      ctx.beginPath();
      ctx.moveTo(11, 0);
      ctx.lineTo(-6, -8);
      ctx.lineTo(-6, 8);
      ctx.closePath();
      ctx.fillStyle = '#ff5a3c';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.9)';
      ctx.lineWidth = 1.3;
      ctx.stroke();
      // 外圈再套一个警示环
      ctx.beginPath();
      ctx.arc(0, 0, 15, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,90,60,.75)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    });
  }

  function drawTank(t, e, isMe) {
    var sx = w2sx(e.rx);
    var sy = w2sy(e.ry);
    var h = TANK_HALF;
    ctx.save();
    ctx.translate(sx, sy);
    if (!t.alive) { ctx.globalAlpha = 0.22; }

    // ---- 车身：跟随 WASD 的移动方向，转 90° 要 1 秒 ----
    ctx.save();
    ctx.rotate(e.rba);
    // 履带
    ctx.fillStyle = 'rgba(0,0,0,.5)';
    ctx.fillRect(-h, -h - 3, h * 2, 5);
    ctx.fillRect(-h, h - 2, h * 2, 5);
    // 车体
    ctx.fillStyle = t.c || '#4ea1ff';
    ctx.fillRect(-h, -h + 2, h * 2, h * 2 - 4);
    ctx.strokeStyle = 'rgba(0,0,0,.55)';
    ctx.lineWidth = 2;
    ctx.strokeRect(-h, -h + 2, h * 2, h * 2 - 4);
    // 车头标记（一眼看清车身朝哪边）
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    ctx.fillRect(h - 6, -h + 5, 4, h * 2 - 10);
    ctx.restore();

    // ---- 炮塔：跟随鼠标，也是 1s/90° ----
    ctx.save();
    ctx.rotate(e.rta);
    // 炮管
    ctx.fillStyle = 'rgba(18,22,30,.95)';
    ctx.fillRect(0, -3.5, h + 12, 7);
    ctx.fillStyle = 'rgba(255,255,255,.20)';
    ctx.fillRect(0, -3.5, h + 12, 2);
    // 炮塔座
    ctx.beginPath();
    ctx.arc(0, 0, 8, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(246,249,255,.95)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.5)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(40,50,70,.9)';
    ctx.fill();
    ctx.restore();

    ctx.restore();

    // 血条 + 名字
    ctx.globalAlpha = t.alive ? 1 : 0.4;
    var barW = 30;
    var bx = sx - barW / 2;
    var by = sy - TANK_HALF - 14;
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    ctx.fillRect(bx, by, barW, 4);
    ctx.fillStyle = (t.hp <= 2) ? '#ff6b6b' : '#7bd88f';
    ctx.fillRect(bx, by, barW * Math.max(0, t.hp) / 5, 4);

    ctx.font = '11px "Segoe UI","Microsoft YaHei",sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = isMe ? '#ffffff' : 'rgba(232,238,252,.8)';
    ctx.fillText(t.n || '玩家', sx, by - 5);
    ctx.textAlign = 'left';

    ctx.globalAlpha = 1;

    if (isMe) {
      ctx.strokeStyle = 'rgba(255,255,255,.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(sx - TANK_HALF - 6, sy - TANK_HALF - 6, TANK_HALF * 2 + 12, TANK_HALF * 2 + 12);
    }
  }

  function drawHud() {
    // ---- 左上角：竖排弹药条（5 格，一格一发，打一发少一格）----
    var bw = 15, bh = 20, gap = 3, bx = 16, by = 22;
    ctx.textAlign = 'left';
    for (var i = 0; i < maxAmmo; i++) {
      var y = by + i * (bh + gap);
      ctx.fillStyle = 'rgba(0,0,0,.45)';
      ctx.fillRect(bx, y, bw, bh);
      ctx.strokeStyle = 'rgba(255,255,255,.22)';
      ctx.lineWidth = 1;
      ctx.strokeRect(bx + 0.5, y + 0.5, bw - 1, bh - 1);
      if (i < ammo) {
        ctx.fillStyle = '#ffd166';
        ctx.fillRect(bx + 2, y + 2, bw - 4, bh - 4);
        ctx.fillStyle = 'rgba(255,255,255,.45)';
        ctx.fillRect(bx + 2, y + 2, (bw - 4) * 0.45, 2);
      }
    }
    // 正在补的那一格：底部一条进度（0→1）
    if (ammo < maxAmmo && reloadIn > 0 && reloadMs > 0) {
      var p = 1 - Math.min(1, reloadIn / reloadMs);
      var y2 = by + ammo * (bh + gap);
      ctx.fillStyle = 'rgba(120,220,255,.8)';
      ctx.fillRect(bx + 1, y2 + bh - 4, (bw - 2) * p, 3);
    }
    ctx.font = '600 11px "Segoe UI","Microsoft YaHei",sans-serif';
    ctx.fillStyle = 'rgba(232,238,252,.85)';
    ctx.fillText(ammo + ' / ' + maxAmmo, bx - 1, by + maxAmmo * (bh + gap) + 10);

    // ---- 旁边的 5 颗心 + 击杀数 ----
    var hx = bx + bw + 22, hy = by + 22;
    ctx.font = '24px "Segoe UI Symbol","Microsoft YaHei",sans-serif';
    for (var k = 0; k < 5; k++) {
      ctx.fillStyle = (k < hp) ? '#ff5a6e' : 'rgba(255,255,255,.16)';
      ctx.fillText('\u2665', hx + k * 27, hy);
    }
    ctx.font = '13px "Segoe UI","Microsoft YaHei",sans-serif';
    ctx.fillStyle = 'rgba(232,238,252,.85)';
    ctx.fillText('生命 ' + Math.max(0, hp) + '/5    击杀 ' + kills, hx, hy + 24);
  }

  function frame(now) {
    requestAnimationFrame(frame);
    var dt = lastRender ? Math.min(0.06, (now - lastRender) / 1000) : 0.016;
    lastRender = now;
    updateEntities(dt);
    draw(dt);
  }

  // =========================================================
  // 输入
  // =========================================================

  function setKey(bit, down) {
    if (down) { keyBits |= bit; } else { keyBits &= ~bit; }
  }

  function keyToBit(e) {
    switch (e.key) {
      case 'w': case 'W': case 'ArrowUp': return K_UP;
      case 's': case 'S': case 'ArrowDown': return K_DOWN;
      case 'a': case 'A': case 'ArrowLeft': return K_LEFT;
      case 'd': case 'D': case 'ArrowRight': return K_RIGHT;
      default: return 0;
    }
  }

  window.addEventListener('keydown', function (e) {
    var bit = keyToBit(e);
    if (bit) { setKey(bit, true); e.preventDefault(); }
  });

  window.addEventListener('keyup', function (e) {
    var bit = keyToBit(e);
    if (bit) { setKey(bit, false); e.preventDefault(); }
  });

  // 失焦时清掉按键，避免"松手了还在跑"
  window.addEventListener('blur', function () { keyBits = 0; firing = false; });

  function updateMouse(e) {
    var r = canvas.getBoundingClientRect();
    mouseX = (e.clientX - r.left) * (VW / r.width);
    mouseY = (e.clientY - r.top) * (VH / r.height);
  }

  canvas.addEventListener('mousemove', updateMouse);
  canvas.addEventListener('mousedown', function (e) {
    if (e.button === 0) { firing = true; updateMouse(e); e.preventDefault(); }
  });
  window.addEventListener('mouseup', function (e) {
    if (e.button === 0) { firing = false; }
  });
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  joinBtn.addEventListener('click', joinGame);

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { missCount = 0; }
  });
  window.addEventListener('pagehide', function () {
    if (me) {
      try {
        navigator.sendBeacon('/api/tank/leave', new Blob([new URLSearchParams({ id: me }).toString()],
          { type: 'application/x-www-form-urlencoded' }));
      } catch (e) { /* 忽略 */ }
    }
  });

  // =========================================================
  // 启动
  // =========================================================

  requestAnimationFrame(frame);
})();
