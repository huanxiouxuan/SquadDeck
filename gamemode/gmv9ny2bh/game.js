/* ============================================================
 * 五子棋对弈（房间制两人对局）· 客户端
 *
 * 关键点：游戏是「可导入」的，导入后服务端会给它一个**全新的 id**
 * （形如 g1a2b3c），所以这里绝不能写死 /api/gomoku——
 * 一律从 location.pathname 里解析出当前游戏 id，再拼接口前缀。
 *
 * 与服务端的往返：POST /api/<id>/join   建立会话（拿 player id）
 *                  POST /api/<id>/sync   上交动作 + 拿回状态（act 见下）
 *    act=create          创建房间（执黑）
 *    act=join&room=XXXX  用房间码加入（执白）
 *    act=place&x=&y=     落子
 *    act=resign / again / leave
 * ============================================================ */
(function () {
  'use strict';

  // ---- 动态解析游戏 id（导入后 id 会变，不能写死）----
  var GID = (location.pathname.match(/\/games\/([^\/]+)/) || [])[1] || 'gomoku';
  var API = '/api/' + GID;

  // ---- 棋盘几何（BOARD 会在 join 后以服务端为准）----
  var BOARD = 15;
  var CELL = 40, PAD = 28;
  var SIZE = PAD * 2 + (BOARD - 1) * CELL;   // 15 路 = 616
  var SYNC_MS = 500;      // 状态轮询间隔（回合制，低频就够）
  var MAX_MISS = 4;       // 连续同步失败这么多次就重新进入

  // ---------------- DOM ----------------
  var canvas = document.getElementById('board');
  var ctx = canvas.getContext('2d');
  var ovWelcome = document.getElementById('ovWelcome');
  var ovLobby = document.getElementById('ovLobby');
  var btnEnter = document.getElementById('btnEnter');
  var enterErr = document.getElementById('enterErr');
  var btnCreate = document.getElementById('btnCreate');
  var btnJoin = document.getElementById('btnJoin');
  var roomInput = document.getElementById('roomInput');
  var lobbyInfo = document.getElementById('lobbyInfo');
  var lobbyErr = document.getElementById('lobbyErr');
  var cardRoom = document.getElementById('cardRoom');
  var roomCodeEl = document.getElementById('roomCode');
  var copyCode = document.getElementById('copyCode');
  var seatBlack = document.getElementById('seatBlack');
  var seatWhite = document.getElementById('seatWhite');
  var tagBlack = document.getElementById('tagBlack');
  var tagWhite = document.getElementById('tagWhite');
  var cardState = document.getElementById('cardState');
  var turnLine = document.getElementById('turnLine');
  var btnAgain = document.getElementById('btnAgain');
  var btnResign = document.getElementById('btnResign');
  var btnLeave = document.getElementById('btnLeave');
  var toastEl = document.getElementById('toast');
  var statusEl = document.getElementById('status');

  // ---------------- 运行时状态 ----------------
  var me = null;              // 服务端分配的 player id
  var state = null;           // 最新快照
  var pendingAct = null;      // 下一次 sync 要带的一次性动作
  var joined = false;
  var syncTimer = null;
  var missCount = 0;
  var lastShownErr = null;
  var toastTimer = null;

  // ---------------- 网络 ----------------
  function post(path, params) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      cache: 'no-store'
    }).then(function (r) { return r.json(); });
  }

  function getCid() {
    try {
      var c = sessionStorage.getItem('gomokuCid');
      if (!c) {
        c = 'c' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        sessionStorage.setItem('gomokuCid', c);
      }
      return c;
    } catch (e) { return null; }
  }

  // ---------------- 加入 / 同步 ----------------
  function enter() {
    btnEnter.disabled = true;
    enterErr.textContent = '';
    var params = { name: nameFromLauncher() };
    var cid = getCid();
    if (cid) { params.cid = cid; }
    post(API + '/join', params).then(function (d) {
      if (!d || !d.id) { throw new Error((d && d.err) || (d && d.error) || 'join failed'); }
      me = d.id;
      joined = true;
      missCount = 0;
      if (d.board && d.board !== BOARD) { BOARD = d.board; resizeCanvas(); }
      ovWelcome.classList.add('hidden');
      statusEl.textContent = '';
      scheduleSync(0);
    }).catch(function (err) {
      joined = false;
      btnEnter.disabled = false;
      var msg = (err && err.message && err.message !== 'join failed')
          ? err.message : '连不上服务器，请确认服务器窗口还开着';
      enterErr.textContent = msg;
    });
  }

  function scheduleSync(delay) {
    if (syncTimer) { clearTimeout(syncTimer); }
    syncTimer = setTimeout(syncLoop, delay == null ? SYNC_MS : delay);
  }

  function syncLoop() {
    if (!joined || !me) { return; }
    var params = { id: me };
    if (pendingAct) {
      for (var k in pendingAct) {
        if (Object.prototype.hasOwnProperty.call(pendingAct, k)) { params[k] = pendingAct[k]; }
      }
      pendingAct = null;
    }
    post(API + '/sync', params).then(function (d) {
      missCount = 0;
      statusEl.textContent = '';
      applyState(d);
      scheduleSync(SYNC_MS);
    }).catch(function () {
      missCount++;
      if (missCount >= MAX_MISS) {
        // 掉线：回到欢迎页重新进入（cid 相同 → 座位还在）
        joined = false;
        me = null;
        statusEl.textContent = '';
        showWelcome('与服务器断开了，正在重连…');
        setTimeout(enter, 1500);
        return;
      }
      statusEl.textContent = '同步失败 ' + missCount + '/' + MAX_MISS + '，重试中…';
      scheduleSync(600);
    });
  }

  function applyState(d) {
    if (!d) { return; }
    if (d.you === null) {
      // 会话过期（超时被请走 / 服务器重启）：重新进入
      joined = false;
      me = null;
      showWelcome('会话已过期，请重新进入');
      return;
    }
    state = d;
    if (d.board && d.board !== BOARD) { BOARD = d.board; resizeCanvas(); }
    if (d.err && d.err !== lastShownErr) {
      toast(d.err);
    }
    lastShownErr = d.err || null;
    render();
  }

  /** 发一个一次性动作，并立刻同步（不等轮询）。 */
  function doAct(obj) {
    pendingAct = obj;
    if (syncTimer) { clearTimeout(syncTimer); }
    syncLoop();
  }

  // ---------------- 视图 ----------------
  function showWelcome(msg) {
    ovWelcome.classList.remove('hidden');
    ovLobby.classList.add('hidden');
    btnEnter.disabled = false;
    if (msg) { enterErr.textContent = msg; }
  }

  function render() {
    var room = state && state.room ? state.room : null;

    // 覆盖层切换
    if (!joined) {
      ovWelcome.classList.remove('hidden');
    } else if (!room) {
      ovWelcome.classList.add('hidden');
      ovLobby.classList.remove('hidden');
      lobbyInfo.textContent = '在线 ' + (state.players || 0) + ' 人 · 房间 '
          + (state.rooms || 0) + ' 个';
      lobbyErr.textContent = state.err || '';
    } else {
      ovWelcome.classList.add('hidden');
      ovLobby.classList.add('hidden');
    }

    // 侧栏
    if (room) {
      cardRoom.style.display = '';
      cardState.style.display = '';
      renderRoom(room);
    } else {
      cardRoom.style.display = 'none';
      cardState.style.display = 'none';
    }

    drawBoard(room);
  }

  function renderRoom(room) {
    roomCodeEl.textContent = room.code;

    // 座位
    fillSeat(seatBlack, tagBlack, room.black, room.turn === 1 && room.winner === 0, '黑');
    fillSeat(seatWhite, tagWhite, room.white, room.turn === 2 && room.winner === 0, '白');

    // 状态行
    turnLine.className = 'turnline';
    if (room.winner === 3) {
      turnLine.textContent = '平局';
      turnLine.classList.add('over');
    } else if (room.winner === 1 || room.winner === 2) {
      var winSeat = room.winner;
      turnLine.textContent = (winSeat === room.youSeat)
          ? '🎉 你赢了！' : '你输了';
      turnLine.classList.add('over');
    } else if (room.state === 'waiting') {
      turnLine.textContent = '等待对手加入…把房间码发给朋友';
    } else if (room.turn === room.youSeat) {
      turnLine.textContent = '轮到你了（' + (room.youSeat === 1 ? '黑' : '白') + '）';
      turnLine.classList.add('mine');
    } else {
      turnLine.textContent = '对方思考中…';
    }

    // 按钮
    var playing = room.state === 'playing';
    var over = room.winner !== 0;
    btnResign.style.display = playing ? '' : 'none';
    btnAgain.style.display = over ? '' : 'none';
  }

  function fillSeat(seatEl, tagEl, p, active, label) {
    var who = seatEl.querySelector('.who');
    seatEl.classList.toggle('active', !!active);
    if (!p) {
      who.textContent = label + ' · 等待';
      tagEl.textContent = '';
      tagEl.className = 'tag';
      return;
    }
    var mine = p.id === me;
    who.textContent = label + ' · ' + p.n + (mine ? '（你）' : '');
    if (p.on) {
      tagEl.textContent = p.turn ? '该他走' : '在线';
      tagEl.className = 'tag on';
    } else {
      tagEl.textContent = '掉线';
      tagEl.className = 'tag off';
    }
  }

  // ---------------- 画板 ----------------
  function resizeCanvas() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    SIZE = PAD * 2 + (BOARD - 1) * CELL;
    canvas.width = SIZE * dpr;
    canvas.height = SIZE * dpr;
    canvas.style.width = SIZE + 'px';
    canvas.style.height = SIZE + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawBoard(room) {
    // 木色棋盘底
    var g = ctx.createLinearGradient(0, 0, SIZE, SIZE);
    g.addColorStop(0, '#e9cf9b');
    g.addColorStop(1, '#d8b374');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, SIZE, SIZE);

    // 网格
    ctx.strokeStyle = 'rgba(90,62,30,.75)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var i = 0; i < BOARD; i++) {
      var p = PAD + i * CELL;
      ctx.moveTo(PAD, p); ctx.lineTo(SIZE - PAD, p);
      ctx.moveTo(p, PAD); ctx.lineTo(p, SIZE - PAD);
    }
    ctx.stroke();

    // 外框加粗
    ctx.strokeStyle = 'rgba(70,46,20,.9)';
    ctx.lineWidth = 2;
    ctx.strokeRect(PAD, PAD, (BOARD - 1) * CELL, (BOARD - 1) * CELL);

    // 星位（15 路的五个点）
    ctx.fillStyle = 'rgba(70,46,20,.9)';
    [[3, 3], [11, 3], [3, 11], [11, 11], [7, 7]].forEach(function (s) {
      if (s[0] >= BOARD || s[1] >= BOARD) { return; }
      ctx.beginPath();
      ctx.arc(PAD + s[0] * CELL, PAD + s[1] * CELL, 3.5, 0, Math.PI * 2);
      ctx.fill();
    });

    if (!room) { return; }

    // 棋子
    for (var y = 0; y < BOARD; y++) {
      for (var x = 0; x < BOARD; x++) {
        var v = room.cells[y][x];
        if (v) { drawStone(x, y, v); }
      }
    }

    // 最后一手：小红点
    if (room.last) {
      ctx.fillStyle = '#ff4d4d';
      ctx.beginPath();
      ctx.arc(PAD + room.last[0] * CELL, PAD + room.last[1] * CELL, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // 获胜连线：金色高亮
    if (room.win && room.win.length) {
      var a = room.win[0];
      var b = room.win[room.win.length - 1];
      ctx.strokeStyle = 'rgba(255,196,60,.95)';
      ctx.lineWidth = 6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(PAD + a[0] * CELL, PAD + a[1] * CELL);
      ctx.lineTo(PAD + b[0] * CELL, PAD + b[1] * CELL);
      ctx.stroke();
    }
  }

  function drawStone(x, y, seat) {
    var cx = PAD + x * CELL, cy = PAD + y * CELL, r = CELL * 0.43;
    // 落影
    ctx.fillStyle = 'rgba(0,0,0,.22)';
    ctx.beginPath();
    ctx.arc(cx + 1.5, cy + 2, r, 0, Math.PI * 2);
    ctx.fill();
    // 棋子本体
    var g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.15, cx, cy, r);
    if (seat === 1) {
      g.addColorStop(0, '#6f6f6f');
      g.addColorStop(0.55, '#1e1e1e');
      g.addColorStop(1, '#000000');
    } else {
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.75, '#eef1f6');
      g.addColorStop(1, '#c2c8d4');
    }
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = seat === 1 ? 'rgba(0,0,0,.5)' : 'rgba(120,128,142,.55)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // ---------------- 交互 ----------------
  function pointToCell(e) {
    var rect = canvas.getBoundingClientRect();
    var px = (e.clientX - rect.left) / rect.width * SIZE;
    var py = (e.clientY - rect.top) / rect.height * SIZE;
    var gx = Math.round((px - PAD) / CELL);
    var gy = Math.round((py - PAD) / CELL);
    if (gx < 0 || gy < 0 || gx >= BOARD || gy >= BOARD) { return null; }
    var dx = px - (PAD + gx * CELL), dy = py - (PAD + gy * CELL);
    if (Math.sqrt(dx * dx + dy * dy) > CELL * 0.5) { return null; }
    return [gx, gy];
  }

  canvas.addEventListener('click', function (e) {
    if (!state || !state.room) { return; }
    var room = state.room;
    if (room.state !== 'playing' || room.turn !== room.youSeat) { return; }
    var c = pointToCell(e);
    if (!c) { return; }
    if (room.cells[c[1]][c[0]] !== 0) { return; }
    doAct({ act: 'place', x: c[0], y: c[1] });
  });

  btnEnter.addEventListener('click', enter);

  btnCreate.addEventListener('click', function () {
    lobbyErr.textContent = '';
    doAct({ act: 'create' });
  });

  function joinByCode() {
    var code = (roomInput.value || '').trim().toUpperCase();
    if (code.length !== 4) {
      lobbyErr.textContent = '请输入 4 位房间码';
      return;
    }
    lobbyErr.textContent = '';
    doAct({ act: 'join', room: code });
  }
  btnJoin.addEventListener('click', joinByCode);
  roomInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { joinByCode(); }
  });

  btnResign.addEventListener('click', function () {
    if (confirm('确定认输吗？')) { doAct({ act: 'resign' }); }
  });
  btnAgain.addEventListener('click', function () { doAct({ act: 'again' }); });
  btnLeave.addEventListener('click', function () {
    pendingAct = { act: 'leave' };
    doAct({ act: 'leave' });
    lastShownErr = null;
  });

  copyCode.addEventListener('click', function () {
    var code = roomCodeEl.textContent;
    if (!code || code === '----') { return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(function () { toast('房间码已复制：' + code); });
    } else {
      toast('房间码：' + code);
    }
  });

  // 启动器转发来的名字。空名字不透传兜底名——服务端会拒并提示去登记，
  // 这里原样带上错误原因（见 enter() 的 catch）。
  var myName = '';
  function nameFromLauncher() { return myName || ''; }
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (d && d.kaihei === 'name' && typeof d.n === 'string' && d.n) {
      myName = d.n.slice(0, 10);
    }
  });

  // ---------------- 小工具 ----------------
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    if (toastTimer) { clearTimeout(toastTimer); }
    toastTimer = setTimeout(function () { toastEl.classList.add('hidden'); }, 2200);
  }

  // 启动
  resizeCanvas();
  drawBoard(null);
})();
