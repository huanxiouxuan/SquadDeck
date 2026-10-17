/* ============================================================
 * 贪吃蛇联机版 客户端（ gamemode/snake2/ ）
 *
 * 服务端权威：本地只做「上报转向 + 渲染快照」，所有判定在服务端。
 *
 * 通信：
 *   POST /api/snake2/join  {name, cid}          → {id, w, h, cell}
 *   POST /api/snake2/sync  {id, d, ev, e}       → 世界快照（约 16 次/秒，
 *                                                  上一次应答到了才发下一次）
 *   POST /api/snake2/leave {id}
 *   d = 想转的方向（0上/1右/2下/3左，-1 不变），一次性带上即清；
 *   e = 启动器表情栏转发来的表情，同样一次性。
 *
 * 渲染（这套方案是修「蛇身透明」+「转向飘移」后定下来的）：
 *   - 地图 60×40 格，比 960×640 的视口大不少：镜头跟随自己的蛇
 *     （平滑跟随，出生/重生瞬移时吸附），右下角小地图看全局。
 *   - 服务端给每条蛇下发步进间隔 st、当前这一步已走的千分比 sf、
 *     **在飞方向 d**（有排队转向时就是那个新方向）和身体格 b（头在队首）。
 *   - 整条蛇按「**路径下标**」参数化：b 本身就是一条带拐角的路径（每一格
 *     都是蛇头待过的地方）。头在 b[0] 记作下标 0，领先半格记 -0.5，第 i 节
 *     取下标 idx+i。相邻两节恒差 1 个下标 → 欧氏距离恒 ≤ 1 格，
 *     **结构上不可能撕开缺口**（「蛇身透明」的根治）。
 *   - 头的领先段沿「在飞方向」走、转向时顺拐角绕过去；本地对**自己的蛇**
 *     再做转向预测（输入一到服务端就在下一个步进边界生效）。全程不做
 *     二维平移补间——那种补间在拐角处根本表达不出来，只会把整条蛇
 *     拖着往外飘（「转向飘移」的老根）。
 *   - 别人的蛇压一个「快照间隔 + 单程」的渲染延迟：转弯只能靠快照知道，
 *     延迟让领先段落回确认过的路径里，怎么取点都对。
 *   - 相位/下标每帧按 dt/st 前进，快照到达时前缀多了几格下标就加几，
 *     渲染位置前后严格连续；另有一个很慢的校正抹掉 tick 量化抖动。
 *   - 食物光晕用离屏 sprite 缓存画，不再每帧 shadowBlur（软渲染
 *     环境下那是掉帧元凶）；格子线/蛇/果实都按视口裁剪。
 *
 * 断线：sync 连续失败会重新 join（cid 相同 → 服务端认回原来那条蛇）。
 * ============================================================ */
(function () {
  'use strict';

  // ---------------- 配置（join 返回后以服务器为准）----------------
  var VIEW_W = 960, VIEW_H = 640;   // 视口 = 画布大小（不随地图变大）
  var W = 60, H = 40, CELL = 32;
  var SYNC_MS = 60;        // 同步间隔目标（毫秒）——16 次/秒
  var MAX_MISS = 3;        // 连续失败这么多次就重新 join

  // 方向编码与服务器约定：0 上 / 1 右 / 2 下 / 3 左
  var DIRS = [
    { x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }
  ];
  var DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];

  // ---------------- DOM ----------------
  var canvas = document.getElementById('game');
  var ctx = canvas.getContext('2d');
  var overlay = document.getElementById('overlay');
  var joinBtn = document.getElementById('join');
  var joinErr = document.getElementById('joinErr');
  var elScore = document.getElementById('score');
  var elKills = document.getElementById('kills');
  var elDeaths = document.getElementById('deaths');
  var elLen = document.getElementById('len');
  var elPlayers = document.getElementById('players');
  var elBoard = document.getElementById('board');
  var elStatus = document.getElementById('status');
  var elToast = document.getElementById('toast');

  // ---------------- 网络状态 ----------------
  var me = null;
  var joined = false;
  var rejoining = false;
  var lastJoinTry = 0;
  var missCount = 0;
  var lastEv = 0;
  var syncTimer = null;
  var wantDir = -1;      // 本周期要上报的转向（一次性）
  var myDirQ = [];       // 本地预测用的转向队列（最多 2 个，规则同服务端）
  var myName = '';
  var inFlight = false;  // 是否有 sync 请求在飞
  var hurry = false;     // 在飞期间来了输入 → 回来立刻补发一次

  // ---------------- 世界缓存 ----------------
  var cur = null;        // 最新快照
  var snapAt = 0;        // 最新快照到达时刻（performance.now）
  var snapGap = SYNC_MS; // 最近两次快照的实测间隔（估 RTT 用）
  var particles = [];
  var deadAt = 0;        // 我阵亡的时刻（本地倒计时用）

  // ---------------- 相机 ----------------
  var camX = 0, camY = 0, camInit = false, camSnap = false;

  // ---------------- 每条蛇的滑行状态 ----------------
  // id -> {path:[[x,y]…], st, T, dir, idx, seen}
  //   path  服务端确认的身体格，头在 [0]——它本身就是一条带拐角的路径
  //   st    步进间隔（毫秒）
  //   T     头**到达** path[0] 的本机时刻（= 快照到达时刻 - 单程延迟 - sf·st）
  //   dir   服务端下发的「在飞方向」（有排队转向时就是那个新方向）
  //   idx   头在路径里的浮点下标：0 = 正好在 path[0]，-0.5 = 已领先半格，
  //         3.5 = 第 3、4 节之间。详见 updateGlide 上方的长注释。
  //   seen  最后一次见到它的时刻（退场清理用）
  var glide = {};

  // ---------------- 小地图 ----------------
  var MM_W = 150, MM_H = 100;
  var MM_X = VIEW_W - MM_W - 12, MM_Y = VIEW_H - MM_H - 12;

  // ---------------- 工具 ----------------
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function post(path, params) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      cache: 'no-store'
    }).then(function (r) { return r.json(); });
  }

  // 每个浏览器标签一个稳定身份。断线重连时服务器靠它把「原来那条蛇」
  // 认回来——不然重连等于换个新号，旧号还会在场里跑 30 秒。
  function getCid() {
    try {
      var c = sessionStorage.getItem('snake2Cid');
      if (!c) {
        c = 'c' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        sessionStorage.setItem('snake2Cid', c);
      }
      return c;
    } catch (e) {
      return null;
    }
  }

  // 启动器（父页面）只下发一样东西：右上角「名字登记」栏的名字。
  // 表情和聊天是启动器自己的功能（走 /api/chat 公共频道），与游戏无联系。
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (d && d.kaihei === 'name' && typeof d.n === 'string' && d.n) {
      myName = d.n.slice(0, 10);
    }
  });

  // ---------------- 加入 / 同步 ----------------
  var startTries = 0;   // 自动拉世界的次数，防 409 死循环

  // 点「开始」时世界没启动 → 自动调房主接口拉起（服务端校验身份），再重试 join。
  // 房主（本机）直接就进；朋友拿到 403，提示等房主拨开关。
  function ensureWorld() {
    startTries++;
    if (startTries > 3) {
      startTries = 0;
      joinBtn.disabled = false;
      joinErr.textContent = '游戏启动失败了，让房主在启动器里手动拨一下「贪吃蛇联机版」的开关。';
      return;
    }
    joinErr.textContent = '游戏世界还没启动，正在自动开启…';
    post('/api/games/snake2/start', {}).then(function (d) {
      // ok = 新启动的；「已经在运行了」= 别人先开了，都当成功，等世界就绪后重试
      if (d && (d.ok || (d.error && /已经在运行/.test(d.error)))) {
        setTimeout(function () { startTries = 0; joinGame(); }, 400);
      } else {
        startTries = 0;
        throw new Error((d && d.error) || 'start failed');
      }
    }).catch(function (err) {
      startTries = 0;
      joinBtn.disabled = false;
      joinErr.textContent = (err && err.message && /只有房主/.test(err.message))
          ? '只有房主能启动游戏——让房主在启动器里拨一下「贪吃蛇联机版」的开关。'
          : '游戏启动失败：' + ((err && err.message) || '未知错误');
    });
  }

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

    var params = { name: name };
    var cid = getCid();
    if (cid) { params.cid = cid; }

    post('/api/snake2/join', params).then(function (d) {
      // 服务端会把原因放在 error 里（如「游戏未启动…」），透给玩家看，
      // 别吞成通用的「连不上服务器」——服务器开着时那句话会误导人。
      if (d && d.error && /未启动/.test(d.error)) {
        // 世界没启动（409）：自动拉起再进——只有房主（本机）能启动，
        // 朋友会拿到 403，那时照实提示等房主开。
        startTries = 0;
        ensureWorld();
        return;
      }
      if (!d || !d.id) { throw new Error((d && d.error) || 'join failed'); }
      me = d.id;
      joined = true;
      rejoining = false;
      startTries = 0;
      missCount = 0;
      // 世界大小以服务器为准；画布始终是视口大小（960x640），不随地图撑大
      if (d.w) { W = d.w; H = d.h; CELL = d.cell || 32; }
      lastEv = 0;
      cur = null;
      glide = {};
      myDirQ = [];
      camInit = false;
      overlay.classList.add('hidden');
      elStatus.textContent = '';
      elToast.classList.add('hidden');
      scheduleSync(0);
    }).catch(function (err) {
      joined = false;
      rejoining = true;
      overlay.classList.remove('hidden');
      joinBtn.disabled = false;
      // 有明确原因（游戏未启动等）就照实说；只有真的连不上才说连不上。
      // 自动重试保留：房主一拨开关，这边两秒内自己就进去了。
      joinErr.textContent = (err && err.message && err.message !== 'join failed')
          ? err.message + '，正在自动重试…'
          : '连不上服务器，请确认服务器窗口还开着，正在自动重试…';
      setTimeout(joinGame, 2000);
    });
  }

  joinBtn.addEventListener('click', function () {
    joinBtn.disabled = true;
    joinErr.textContent = '';
    joinGame();
  });

  function scheduleSync(delay) {
    if (inFlight) { hurry = true; return; }   // 有请求在飞：回来后立刻补一次
    if (syncTimer) { clearTimeout(syncTimer); }
    syncTimer = setTimeout(syncLoop, delay == null ? SYNC_MS : delay);
  }

  function syncLoop() {
    if (!joined || !me) { return; }
    var params = {
      id: me,
      d: wantDir >= 0 ? wantDir : -1,
      ev: lastEv
    };
    wantDir = -1;      // 一次性意图，发出去就清
    inFlight = true;
    post('/api/snake2/sync', params).then(function (d) {
      inFlight = false;
      missCount = 0;
      applySnapshot(d);
      scheduleSync(hurry ? 0 : SYNC_MS);
      hurry = false;
    }).catch(function () {
      inFlight = false;
      missCount++;
      if (missCount >= MAX_MISS) {
        // 掉线：回到覆盖层并重新 join（cid 相同 → 拿回原来那条蛇）
        joined = false;
        rejoining = true;
        elStatus.textContent = '';
        overlay.classList.remove('hidden');
        joinErr.textContent = '与服务器断开了，正在重连…';
        joinBtn.disabled = false;
        joinGame();
        return;
      }
      elStatus.textContent = '同步失败 ' + missCount + '/' + MAX_MISS + '，重试中…';
      scheduleSync(400);
    });
  }

  function applySnapshot(d) {
    if (!d) { return; }
    var now = performance.now();
    var gapNow = clamp(now - snapAt, 30, 250);
    // 快照间隔取「衰减峰值」而不是瞬时值：延迟必须覆盖最坏情况，被偶发的
    // 慢间隔打小，领先段就会冒出来（转向时就跳一下）。峰值按每份快照 0.9
    // 衰减，约 0.4 秒半衰。
    snapGap = Math.max(gapNow, snapGap * 0.9);
    cur = d;
    snapAt = now;

    // 事件 → 粒子（boom：某条蛇撞了）
    if (d.events && d.events.length) {
      for (var i = 0; i < d.events.length; i++) {
        var e = d.events[i];
        if (e.id > lastEv) { lastEv = e.id; }
        if (e.type === 'boom') {
          burst(e.x, e.y, 16, 4);
        }
      }
    }

    // HUD
    if (d.me) {
      elScore.textContent = d.me.score;
      elKills.textContent = d.me.kills;
      elDeaths.textContent = d.me.deaths;
      elLen.textContent = d.me.len;
      if (!d.me.alive && deadAt === 0) { deadAt = performance.now(); }
      if (d.me.alive) { deadAt = 0; elToast.classList.add('hidden'); }
    }
    if (d.board) {
      elPlayers.textContent = '（' + d.board.length + ' 人在线）';
      renderBoard(d.board);
    }

    // 每条蛇的滑行状态按快照刷新
    if (d.snakes) {
      for (var j = 0; j < d.snakes.length; j++) {
        updateGlide(d.snakes[j], now);
      }
    }
  }

  // 转义 HTML（名字是玩家输入，保险起见前端也转一遍）
  function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // 排行榜：服务端已按分数降序排好，这里按 id/名字/击杀/分数渲染
  function renderBoard(arr) {
    if (!arr || !arr.length) {
      elBoard.innerHTML = '<li class="sub">等待玩家加入…</li>';
      return;
    }
    var html = '';
    for (var i = 0; i < arr.length; i++) {
      var t = arr[i];
      var cls = 'li';
      if (t.id === me) { cls += ' me'; }
      if (!t.alive) { cls += ' dead'; }
      html += '<li class="' + cls + '">'
            + '<span class="dot" style="background:' + esc(t.c || '#4ea1ff') + '"></span>'
            + '<span>' + esc(t.n || '玩家') + (t.alive ? '' : '（阵亡）') + '</span>'
            + '<span class="kills">击杀 ' + (t.k || 0) + '</span>'
            + '<b>' + (t.sc || 0) + '</b>'
            + '</li>';
    }
    elBoard.innerHTML = html;
  }

  /** 单程延迟估计（毫秒）：一次来回 ≈ snapGap - 同步间隔，取一半。 */
  function oneWay() {
    return clamp(snapGap - SYNC_MS, 0, 250) / 2;
  }

  /**
   * 渲染延迟（毫秒）——所有蛇都先压这么久的延迟再画。
   *
   * 为什么必须延迟：快照只能告诉我们「过去」。渲染时刻若越过了最后一份
   * 快照确认到的头格，领先段就只能靠外推；而下一步往哪拐我们只能等快照
   * ——外推一错，头就被从错误的方向拽回来，那就是「转向飘移」。延迟让渲染
   * 时刻落回**身体格确认过的那段时间**，那段路径自带拐角（身体格就是头
   * 待过的格），怎么取点都对，不需要任何补间。
   *
   * 必须覆盖三部分：
   *   单程          快照从生成到送达的这段时间
   * + 一个 st       快照里「这一步已经走掉的部分」sf·st，sf 最坏取 1
   * + 一个快照间隔   两次快照之间对方可能已经拐弯，而我们还没收到
   * 三项都算满，领先段就恒 ≤ 0——整条蛇永远画在确认过的路径上。
   * （少算任何一项，最高速 + 高延迟时头就会冒出半格偏离。）
   */
  function delayOf(st) {
    return clamp(oneWay() + st + snapGap, 0, 420);
  }

  /** 本机蛇也一样：本地输入预测能兜住偶尔冒头的一点点领先，不必多留延迟。 */
  function delayOfSnake(id, st) {
    return delayOf(st);
  }

  var PREDICT_SELF = true;   // 本机蛇是否用本地输入预测转向
  var TAU = 400;             // 锚点校正时间常数（毫秒）

  // ---------------- 滑行状态（修卡顿 / 修转向的核心）----------------
  // 服务端每条蛇带 st（步进间隔 ms）、sf（当前这一步已走的千分比）、
  // d（**当前在飞的方向**——有排队转向时就是那个新方向）和 b（身体格，
  // 头在队首）。
  //
  // 关键认识：**b 本身就是一条带拐角的路径**——每一格都是蛇头待过的
  // 地方。于是整条蛇按「路径下标」参数化：
  //
  //     idx = 0     头正好在 b[0]
  //     idx = -0.5  头已领先半格（走出确认范围，用外推段 fut 取点）
  //     idx = 3.5   第 3、4 节之间
  //
  // 第 i 节取下标 idx+i，相邻两节恒差 1 个下标 → 欧氏距离恒 ≤ 1 格，
  // **结构上不可能撕开缺口**（「蛇身透明」的根治）；头的领先段沿「在飞
  // 方向」走、转向时顺着拐角绕过去，全程不做任何二维平移补间——那种
  // 补间在拐角处根本表达不出来，只会把整条蛇拖着往外飘（「转向飘移」
  // 的老根）。
  //
  // idx 每帧按 dt/st 前进；快照到达时身体前缀多了 dist 格，同一物理点
  // 的下标随之 +dist，**渲染位置前后严格连续**；另有一个很慢的校正
  // （τ≈400ms）抹掉 tick 量化抖动和延迟估计残差。
  function updateGlide(s, now) {
    var head = s.b && s.b.length ? s.b[0] : null;
    if (!head) { return; }
    var st = s.st || 150;
    var sf = clamp((s.sf || 0) / 1000, 0, 1);
    var T = now - oneWay() - sf * st;      // 头**到达** b[0] 的本机时刻
    var g = glide[s.id];
    if (!g) {
      // 首次见到这条蛇：**直接用快照里的整条身体**建路径。
      // 早期版本这里只塞头格（full=[[head]]），下一帧 oldFull 就只剩 1 格，
      // 「前缀多出 dist 格」的历史接不上，full 被迫退化成纯身体 → 尾巴的
      // 渲染下标（idx+n-1）被夹在尾格上，等整条身体出现时一帧跳好几格
      // （实测 4 格）。浏览器里表现为刚开局那一下蛇身「啪」地展开。
      var b0 = [];
      for (var m0 = 0; m0 < s.b.length; m0++) { b0.push([s.b[m0][0], s.b[m0][1]]); }
      glide[s.id] = { path: b0, n: b0.length, full: b0.slice(),
                      st: st, T: T, dir: s.d,
                      seen: now, idx: -((now - delayOfSnake(s.id, st)) - T) / st };
      return;
    }
    // 这一轮走了几格。用两个互相独立的来源算，一致才敢用：
    //   ① 相位：服务端 sf 推出来的 T 推进了几个步进间隔（推进 idx 的依据）
    //   ② 身体：**旧头格**在新身体里的下标（几何真值，只做校验）
    // 只用 ② 推进、而 T 另算的话，两者会被网络抖动一点点喂出固定偏差
    // （表现为渲染滞后越积越多）；用 ① 推进、② 校验，偏差在快照处严格守恒，
    // 只剩那个很慢的校正去抹平它。
    // 注意不能「在新身体里找旧路径的格」：新头格永远在旧路径前方。
    var oldHead = g.path[0];
    var oldFull = g.full;
    var prevIdx = g.idx;
    var prevT = g.T;
    var bodyDist = -1;
    for (var k = 0; k < Math.min(8, s.b.length); k++) {
      if (s.b[k][0] === oldHead[0] && s.b[k][1] === oldHead[1]) { bodyDist = k; break; }
    }
    var phaseDist = (T - prevT) / st;
    var dist = Math.round(phaseDist);
    g.path = [];
    for (var m = 0; m < s.b.length; m++) { g.path.push([s.b[m][0], s.b[m][1]]); }
    g.n = g.path.length;

    // 「重生/瞬移/两个来源对不上」的判定：这一步决定 idx 是否硬锚定，
    // 也决定 full 能不能沿用（沿用 = 历史继续；不沿用 = 只剩身体）。
    var bad = (dist < 0 || dist > 6 || Math.abs(phaseDist - dist) > 0.4
        || (bodyDist >= 0 && Math.abs(bodyDist - dist) > 0.4) || g.path.length < 2);

    // ---- 统一路径 full = 身体 ＋ 已腾出格（尾巴滑动的依据） ----
    // 渲染延迟让整条蛇沿路径后移约 idx 格，所以尾巴下标会滑到身体末端之外
    // （实测到 n+3.5）。快照只给当前身体，多出来的下标若被夹死，尾巴就会
    // 静止 82% 的帧、然后一帧跳 1~2 格——「尾巴抖动」。
    //
    // 做法：**把旧 full 整体后移 dist 格**。同一个物理格在新帧里的下标
    // 等于它在旧帧里的下标 + dist（这轮走了 dist 步），也就是
    //     full_new[dist + i] = full_old[i]
    // 所以在前面补上服务端刚给的 dist 个新头格，「已腾出格」就自动延续下来
    // 了——不必推断步数、不依赖批次顺序、也不会被中途清空。
    if (!bad && dist > 0) {
      var pre = [];
      for (var q = 0; q < dist && q < s.b.length; q++) { pre.push([s.b[q][0], s.b[q][1]]); }
      g.full = pre.concat(oldFull);
      var cap = g.path.length + 16;
      if (g.full.length > cap) { g.full.length = cap; }
    } else if (!bad) {
      g.full = oldFull;   // 这轮没走步：路径没变，已腾出格原样留着（别重置！）
    } else {
      // dist 不可信（相位与身体对不上，多半是网络抖动，不一定真重生）。
      // 这时**不能整段丢掉历史**——尾巴会立刻从远处跳回尾格（「尾巴抖动」）。
      // 改成从旧 full 里找出与新身体尾格相邻的那一格，把其后的一段接上：
      // 抖动时历史继续，真重生时找不到相邻格，自然退化为「只有身体」。
      g.full = g.path.slice();
      var tailCell = g.path[g.path.length - 1];
      var cut = -1;
      // ① 新尾格本身就在旧路径里：它后面那一格就是接续（最准，无冗余）
      for (var w = 0; w < oldFull.length; w++) {
        if (oldFull[w][0] === tailCell[0] && oldFull[w][1] === tailCell[1]) { cut = w + 1; break; }
      }
      // ② 退一步：旧路径里与它**相邻**的那一格（只能挑最近的，靠 0 号端）
      if (cut < 0) {
        for (var w2 = 0; w2 < oldFull.length; w2++) {
          if (Math.abs(oldFull[w2][0] - tailCell[0])
              + Math.abs(oldFull[w2][1] - tailCell[1]) === 1) { cut = w2; break; }
        }
      }
      if (cut >= 0 && cut < oldFull.length) {
        // 从 cut 接起：接缝处 path 末格 → oldFull[cut] 必相邻（①w+1 承接 w，
        // ②本身就是相邻格），否则会被下面的四邻校验否掉。
        g.full = g.full.concat(oldFull.slice(cut));
        var cap2 = g.path.length + 16;
        if (g.full.length > cap2) { g.full.length = cap2; }
      }
    }
    {
      // 前缀对齐：full 的头 g.n 格必须就是服务端权威身体
      if (g.full.length < g.path.length) { g.full = g.path; }
      else { for (var i2 = 0; i2 < g.path.length; i2++) { g.full[i2] = g.path[i2]; } }
    }
    // 保险：full 必须是一条**四邻相接**的连续路径。真实服务端每次步进都只把
    // 头挪到相邻新格，不会给出重复格或断格；万一被弄脏了，宁可丢历史
    // （尾巴短暂被夹在末格）也不要把尾巴画到不相干的地方去。
    for (var c = 1; c < g.full.length; c++) {
      if (Math.abs(g.full[c][0] - g.full[c - 1][0])
          + Math.abs(g.full[c][1] - g.full[c - 1][1]) !== 1) {
        g.full = g.path;
        break;
      }
    }

    g.st = st;
    g.T = T;
    g.dir = s.d;
    g.seen = now;
    if (bad) {
      // 重生（异地瞬移）/ 换图 / 两个来源对不上：直接锚定，不补间
      var tgt = -((now - delayOfSnake(s.id, st)) - T) / st;
      if (s.id === me && Math.abs(tgt - prevIdx) > 3) { camSnap = true; }
      g.idx = tgt;
    } else {
      g.idx = prevIdx + dist;   // 前缀多了 dist 格 → 同一物理点下标 +dist
    }
    if (s.id === me) {
      // 服务端在这之前收到的转向都已经用掉了，本地预测队列同步清理
      while (myDirQ.length && myDirQ[0].r <= T) { myDirQ.shift(); }
    }
  }

  /**
   * 外推段：fut[0] = b[0]，fut[m] = 第 m 步之后头到达的格。
   *
   * 别人的蛇只按「当前在飞方向」直走（他们下一次转向我们还不知道，
   * 但渲染延迟已经把这段挡住了）；自己的蛇叠加本地预测——输入一旦
   * （按延迟估计）到了服务端就会在下一个步进边界生效，于是按下的方向
   * 当场就转，不必等快照。
   */
  function predict(s, g) {
    var st = g.st;
    var dir = s.d;
    var f = [[g.path[0][0], g.path[0][1]]];
    var q = (s.id === me && PREDICT_SELF) ? myDirQ : null;
    var qi = 0;
    for (var m = 1; m <= 4; m++) {
      if (q && qi < q.length && q[qi].r <= g.T + m * st) {
        var nd = q[qi].d; qi++;
        if (nd !== (dir + 2) % 4) { dir = nd; }
      }
      var p = f[f.length - 1];
      f.push([p[0] + DX[dir], p[1] + DY[dir]]);
    }
    return f;
  }

  /**
   * 路径取点：idx ≥ 0 在「身体 + 已腾出格历史」上插值；idx < 0 走外推段 fut。
   *
   * 尾巴的下标会滑到身体末端之外（渲染延迟让整条蛇沿路径后移约 idx 格），
   * 所以必须接上 g.full 尾部的「已腾出格」，否则会被夹死在最后一格上 ——
   * 那就是「尾巴抖动」。
   */
  function pointAt(g, fut, idx) {
    if (idx >= 0) {
      var arr = g.full;
      var n = arr.length;
      var k = Math.floor(idx);
      if (k >= n - 1) { return [arr[n - 1][0], arr[n - 1][1]]; }
      var fr = idx - k, a = arr[k], b = arr[k + 1];
      return [a[0] + (b[0] - a[0]) * fr, a[1] + (b[1] - a[1]) * fr];
    }
    var j = -idx, k2 = Math.floor(j);
    if (k2 >= fut.length - 1) { k2 = fut.length - 2; j = k2; }
    if (k2 < 0) { k2 = 0; j = 0; }
    var ff = j - k2, a2 = fut[k2], b2 = fut[k2 + 1];
    return [a2[0] + (b2[0] - a2[0]) * ff, a2[1] + (b2[1] - a2[1]) * ff];
  }

  /**
   * 一条蛇逐节的渲染坐标（格，浮点）。
   *
   * 相邻两节的下标恒差 1，所以间距恒 ≤ 1 格：既不会在拐角拉开缺口
   * （「蛇身透明」），也不会多拖出余量。节数用身体真值 g.n ——
   * 路径数组因为接了尾巴历史而更长，不能拿它的长度当节数。
   */
  function bodySteps(s, g) {
    var fut = predict(s, g);
    var res = [];
    for (var i = 0; i < g.n; i++) {
      res.push(pointAt(g, fut, g.idx + i));
    }
    return res;
  }

  /** 逐帧推进：idx 按 dt/st 前进，再朝快照锚点做慢速校正。 */
  function advanceGlide(dt, now) {
    for (var id in glide) {
      var g = glide[id];
      if (now - g.seen > 5000) { delete glide[id]; continue; }   // 退场清理
      g.idx -= dt / g.st;
      var target = -((now - delayOfSnake(id, g.st)) - g.T) / g.st;
      // 偏差很大 = 渲染循环停过（切标签页回来）：直接归位，别慢慢排
      if (Math.abs(target - g.idx) > 1.5) { g.idx = target; }
      else { g.idx += (target - g.idx) * Math.min(1, dt / TAU); }
      var lim = -(g.n + 4);
      if (g.idx < lim) { g.idx = lim; }
    }
  }

  // ---------------- 输入 ----------------
  var KEYMAP = {
    ArrowUp: 0, KeyW: 0,
    ArrowRight: 1, KeyD: 1,
    ArrowDown: 2, KeyS: 2,
    ArrowLeft: 3, KeyA: 3
  };

  /**
   * 本机玩家的转向输入：一份上报服务端，一份进本地预测队列。
   *
   * 为什么要本地预测：服务端「到格才生效」，本机按下的方向要等到下一次
   * 走步才被采用；而快照最快也就 16 次/秒，转向常常正好落在两次快照之间
   * ——客户端发现自己转晚了，头已经在旧方向上多冲出去一格多，只能拉回来，
   * 看上去就是「转向飘一下」。输入是本地已知的，直接提前用上即可。
   * 规则和服务端一致（不掉头、不重复、最多排 2 个），所以不会被拒。
   *
   * r = 估计的「服务端收到它的时刻」，predict 用它算这条输入落在哪个
   * 步进边界生效；T 之前的输入由 updateGlide 出队。
   */
  function localInput(d) {
    if (!joined) { return; }
    wantDir = d;
    scheduleSync(0);          // 立刻上报，别等下一次同步（最多白等 60ms）
    var g = me ? glide[me] : null;
    if (!g) { return; }
    var last = myDirQ.length ? myDirQ[myDirQ.length - 1].d : g.dir;
    if (d === last || d === (last + 2) % 4) { return; }
    if (myDirQ.length < 2) {
      myDirQ.push({ d: d, r: performance.now() + oneWay() });
    }
  }

  window.addEventListener('keydown', function (e) {
    var d = KEYMAP[e.code];
    if (d !== undefined) {
      e.preventDefault();
      localInput(d);
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
    if (!touchStart || !joined) { return; }
    var t = e.touches[0];
    var dx = t.clientX - touchStart.x, dy = t.clientY - touchStart.y;
    if (Math.abs(dx) < 24 && Math.abs(dy) < 24) { return; }
    localInput(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0));
    touchStart = { x: t.clientX, y: t.clientY };
    e.preventDefault();
  }, { passive: false });

  // ---------------- 粒子 ----------------
  function burst(cx, cy, n, power) {
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2;
      var sp = (0.3 + Math.random() * 0.7) * power;
      particles.push({
        x: cx, y: cy,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 1, decay: 0.02 + Math.random() * 0.025,
        color: i % 2 ? '#ff6b6b' : '#ffd166',
        size: 2 + Math.random() * 3
      });
    }
  }

  // ---------------- 更新 ----------------
  function update(dt) {
    var k = dt / 16.7;
    for (var i = particles.length - 1; i >= 0; i--) {
      var p = particles[i];
      p.x += p.vx * k; p.y += p.vy * k;
      p.vy += 0.06 * k;
      p.life -= p.decay * k;
      if (p.life <= 0) { particles.splice(i, 1); }
    }
    // 每条蛇按自身步进节拍推进路径下标（快照锚点只做慢速校正，见 advanceGlide）
    advanceGlide(dt, performance.now());
    // 我阵亡的倒计时 toast
    if (deadAt > 0 && cur && cur.me && !cur.me.alive) {
      var left = Math.max(0, cur.me.respawnIn - (performance.now() - deadAt) / 1);
      if (left > 0) {
        elToast.textContent = '💥 你阵亡了，' + Math.ceil(left / 1000) + ' 秒后复活…';
        elToast.classList.remove('hidden');
      } else {
        elToast.classList.add('hidden');
      }
    }
  }

  // ---------------- 相机 ----------------
  function updateCamera(hx, hy, dt, snap) {
    var tx = clamp(hx - VIEW_W / 2, 0, Math.max(0, W * CELL - VIEW_W));
    var ty = clamp(hy - VIEW_H / 2, 0, Math.max(0, H * CELL - VIEW_H));
    if (snap || !camInit) { camX = tx; camY = ty; camInit = true; return; }
    var k = Math.min(1, dt / 90);
    camX += (tx - camX) * k;
    camY += (ty - camY) * k;
  }

  // ---------------- 渲染 ----------------
  function drawGrid() {
    ctx.fillStyle = '#0b1119';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    // 只画视口内的格子线（地图比屏幕大，全画是浪费）
    var x0 = Math.max(1, Math.floor(camX / CELL));
    var x1 = Math.min(W - 1, Math.ceil((camX + VIEW_W) / CELL));
    var y0 = Math.max(1, Math.floor(camY / CELL));
    var y1 = Math.min(H - 1, Math.ceil((camY + VIEW_H) / CELL));
    ctx.strokeStyle = 'rgba(120,170,255,0.055)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var x = x0; x <= x1; x++) {
      var sx = Math.round(x * CELL - camX) + .5;
      ctx.moveTo(sx, 0); ctx.lineTo(sx, VIEW_H);
    }
    for (var y = y0; y <= y1; y++) {
      var sy = Math.round(y * CELL - camY) + .5;
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
  function buildSprites() {
    foodSprite = makeGlowDisc('#ff6b6b', 'rgba(255,107,107,.55)', 14);
    goldSprite = makeGlowDisc('#ffd166', 'rgba(255,209,102,.7)', 18);
  }

  function drawFoods(ts) {
    if (!cur || !cur.foods) { return; }
    for (var i = 0; i < cur.foods.length; i++) {
      var f = cur.foods[i];
      var cx = (f.x + 0.5) * CELL, cy = (f.y + 0.5) * CELL;
      // 视口裁剪
      if (cx < camX - CELL || cx > camX + VIEW_W + CELL
          || cy < camY - CELL || cy > camY + VIEW_H + CELL) { continue; }
      if (f.g) {
        // 金色：脉冲 + 剩余时间环
        var pulse = 1 + 0.14 * Math.sin(ts / 110);
        var remain = clamp((f.ms || 0) / 8000, 0, 1);
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
      } else {
        var pulse2 = 1 + 0.1 * Math.sin(ts / 140 + i);
        ctx.drawImage(foodSprite.c, cx - foodSprite.r * pulse2, cy - foodSprite.r * pulse2,
                foodSprite.r * 2 * pulse2, foodSprite.r * 2 * pulse2);
        // 高光
        ctx.fillStyle = 'rgba(255,255,255,.5)';
        ctx.beginPath();
        ctx.arc(cx - CELL * 0.09, cy - CELL * 0.1, CELL * 0.07, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /**
   * 圆角矩形路径（标准四段 arcTo）。
   *
   * 注意：arcTo(x1,y1,x2,y2,r) 里「第一控制点 == 终点」时会按规范退化成一条
   * 直线。曾误写成
   *   arcTo(x+w, y+h, x+w, y+h, r); arcTo(x+w, y, x+w, y, r);
   * 于是路径变成 沿右边下去 → 原路爬回 → 沿上边退回 的自重叠路径，
   * 净环绕数为 0，fill() 几乎填不出面积，只剩右上角圆弧鼓出的一小片——
   * 蛇身就渲染成一节节小楔形，看着像「透明」。
   * 正确写法必须让四个控制点各不相同。r 还要夹到半边长以内，防止退化。
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

  function drawSnakes(now) {
    if (!cur || !cur.snakes) { return; }
    for (var i = 0; i < cur.snakes.length; i++) {
      var s = cur.snakes[i];
      if (!s.alive || !s.b || s.b.length === 0) { continue; }
      var g = glide[s.id];
      if (!g) { continue; }
      var pts = bodySteps(s, g);
      var n = pts.length;
      // 视口裁剪：整条蛇都在屏幕外就跳过主视图（小地图里仍然画）
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (var q = 0; q < n; q++) {
        if (pts[q][0] < minX) { minX = pts[q][0]; }
        if (pts[q][0] > maxX) { maxX = pts[q][0]; }
        if (pts[q][1] < minY) { minY = pts[q][1]; }
        if (pts[q][1] > maxY) { maxY = pts[q][1]; }
      }
      if (maxX * CELL < camX || minX * CELL > camX + VIEW_W
          || maxY * CELL < camY || minY * CELL > camY + VIEW_H) { continue; }

      var isMe = s.id === me;
      for (var k = n - 1; k >= 0; k--) {
        var f = n > 1 ? k / (n - 1) : 0;
        ctx.fillStyle = k === 0 ? lighten(s.c) : shade(s.c, f);
        var px = pts[k][0] * CELL, py = pts[k][1] * CELL;
        roundRect(px + 1.5, py + 1.5, CELL - 3, CELL - 3, 7);
        ctx.fill();
        if (isMe) {
          ctx.strokeStyle = 'rgba(255,255,255,.85)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
      // 蛇头眼睛：朝向取「脖子 → 头」的方向——路径自带拐角，不必另做平滑
      var d = DIRS[s.d] || DIRS[1];
      if (pts.length >= 2) {
        var ex = pts[0][0] - pts[1][0], ey = pts[0][1] - pts[1][1];
        var el = Math.sqrt(ex * ex + ey * ey);
        if (el > 0.15) { d = { x: ex / el, y: ey / el }; }
      }
      var hx = pts[0][0] * CELL + CELL / 2, hy = pts[0][1] * CELL + CELL / 2;
      var px2 = -d.y, py2 = d.x;
      ctx.fillStyle = '#0b1119';
      ctx.beginPath();
      ctx.arc(hx + d.x * CELL * 0.14 + px2 * CELL * 0.17, hy + d.y * CELL * 0.14 + py2 * CELL * 0.17, CELL * 0.085, 0, Math.PI * 2);
      ctx.arc(hx + d.x * CELL * 0.14 - px2 * CELL * 0.17, hy + d.y * CELL * 0.14 - py2 * CELL * 0.17, CELL * 0.085, 0, Math.PI * 2);
      ctx.fill();
      // 名字（别飞出屏幕顶部）
      ctx.font = '11px "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = isMe ? '#ffffff' : 'rgba(232,238,252,.75)';
      var ny = Math.max(camY + 12, pts[0][1] * CELL - 6);
      ctx.fillText(s.n + (isMe ? '（你）' : ''), hx, ny);
    }
  }

  /** 颜色提亮（蛇头用）。 */
  function lighten(hex) {
    var c = parseHex(hex);
    return 'rgb(' + Math.min(255, c[0] + 70) + ',' + Math.min(255, c[1] + 70) + ',' + Math.min(255, c[2] + 70) + ')';
  }

  /** 颜色按 f（0 头 → 1 尾）加深。 */
  function shade(hex, f) {
    var c = parseHex(hex);
    var k = 1 - 0.55 * f;
    return 'rgb(' + Math.round(c[0] * k) + ',' + Math.round(c[1] * k) + ',' + Math.round(c[2] * k) + ')';
  }

  function parseHex(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) { return [100, 160, 255]; }
    var v = parseInt(m[1], 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
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

  /** 小地图：全局果实 / 所有人 / 视口框（地图比屏幕大，没它找不到人）。 */
  function drawMinimap() {
    if (!cur) { return; }
    var sx = MM_W / (W * CELL), sy = MM_H / (H * CELL);
    ctx.save();
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = 'rgba(8,12,20,.8)';
    roundRect(MM_X, MM_Y, MM_W, MM_H, 8);
    ctx.fill();
    ctx.strokeStyle = 'rgba(120,170,255,.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
    // 果实
    if (cur.foods) {
      for (var i = 0; i < cur.foods.length; i++) {
        var f = cur.foods[i];
        ctx.fillStyle = f.g ? '#ffd166' : 'rgba(255,107,107,.85)';
        ctx.fillRect(MM_X + f.x * CELL * sx - 1, MM_Y + f.y * CELL * sy - 1, 2, 2);
      }
    }
    // 蛇（只画头，自己是白的）
    if (cur.snakes) {
      for (var j = 0; j < cur.snakes.length; j++) {
        var s = cur.snakes[j];
        if (!s.alive || !s.b || !s.b.length) { continue; }
        ctx.fillStyle = s.id === me ? '#ffffff' : s.c;
        ctx.fillRect(MM_X + s.b[0][0] * CELL * sx - 1.5,
                MM_Y + s.b[0][1] * CELL * sy - 1.5, 3, 3);
      }
    }
    // 视口框
    ctx.strokeStyle = 'rgba(255,255,255,.55)';
    ctx.strokeRect(MM_X + camX * sx, MM_Y + camY * sy, VIEW_W * sx, VIEW_H * sy);
    ctx.restore();
  }

  function render(dt, now) {
    drawGrid();
    if (!cur) { return; }

    // 相机目标：我的蛇的插值头位
    var myPts = null;
    var myG = me ? glide[me] : null;
    if (myG && cur.snakes) {
      for (var i = 0; i < cur.snakes.length; i++) {
        var s = cur.snakes[i];
        if (s.id === me && s.alive && s.b && s.b.length) {
          myPts = bodySteps(s, myG);
          break;
        }
      }
    }
    if (myPts) {
      updateCamera((myPts[0][0] + 0.5) * CELL, (myPts[0][1] + 0.5) * CELL, dt, camSnap);
      camSnap = false;
    }

    // 世界边界（地图比屏幕大，有条亮边方便辨认）
    ctx.save();
    ctx.translate(-camX, -camY);
    ctx.strokeStyle = 'rgba(120,170,255,.3)';
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, W * CELL, H * CELL);
    drawFoods(now);
    drawSnakes(now);
    drawParticles();
    ctx.restore();

    drawMinimap();
  }

  // ---------------- 主循环 ----------------
  var lastTs = 0;
  function frame(ts) {
    requestAnimationFrame(frame);
    var dt = lastTs ? (ts - lastTs) : 0;
    lastTs = ts;
    if (dt > 100) { dt = 100; }   // 切标签页回来不要一次补太多
    update(dt);
    render(dt, performance.now());
  }

  // ---------------- 启动 ----------------
  buildSprites();
  drawGrid();
  requestAnimationFrame(frame);
})();
