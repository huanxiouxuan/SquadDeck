/* ============================================================
 * 联机模板客户端：全服计数
 *
 * 演示要点：
 *   - 从 location.pathname 取游戏 id（导入后 id 会变，绝不能写死）
 *   - join → sync 循环（上报输入 + 拿回快照，一次往返）
 *   - cid 身份复用（刷新/重连不掉号）
 *   - 409（世界没启动）照实提示 + 自动重试
 *   - 断线到阈值就重新 join
 * ============================================================ */
(function () {
  'use strict';

  // ★ 必须动态取 id：导入后是 g<base36>，不是 game.json 里那个
  var GID = (location.pathname.match(/\/games\/([^\/]+)/) || [])[1] || 'multi-template';
  var API = '/api/' + GID;

  var SYNC_MS = 200;     // 回合制/低频够用；射击类可以 33~60
  var MAX_MISS = 4;      // 连续失败这么多次就重新 join

  var elCount = document.getElementById('count');
  var elMine = document.getElementById('mine');
  var elOnline = document.getElementById('online');
  var elPlayers = document.getElementById('players');
  var elStatus = document.getElementById('status');
  var elHit = document.getElementById('hit');
  var overlay = document.getElementById('overlay');
  var elEnter = document.getElementById('enter');
  var elErr = document.getElementById('err');

  var me = null;
  var joined = false;
  var syncTimer = null;
  var miss = 0;
  var pendingHit = false;
  var myName = '';

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
      var c = sessionStorage.getItem('multiTemplateCid');
      if (!c) {
        c = 'c' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        sessionStorage.setItem('multiTemplateCid', c);
      }
      return c;
    } catch (e) { return null; }
  }

  // ---------------- 进入 ----------------

  function enter() {
    elEnter.disabled = true;
    elErr.textContent = '';
    post(API + '/join', { name: myName || '玩家', cid: getCid() }).then(function (d) {
      if (!d || !d.id) {
        throw new Error((d && (d.error || d.err)) || 'join failed');
      }
      me = d.id;
      joined = true;
      miss = 0;
      overlay.classList.add('hidden');
      elHit.disabled = false;
      elStatus.textContent = '';
      scheduleSync(0);
    }).catch(function (e) {
      elEnter.disabled = false;
      var msg = e && e.message ? e.message : '连不上服务器';
      // 409 是"世界没启动"，不是连不上——照实说，并自动重试
      elErr.textContent = msg + (/未启动/.test(msg) ? '' : '，请确认服务器窗口还开着');
      if (/未启动/.test(msg)) {
        elErr.textContent = msg + '，正在自动重试…';
        setTimeout(enter, 2000);
      }
    });
  }

  function scheduleSync(ms) {
    if (syncTimer) { clearTimeout(syncTimer); }
    syncTimer = setTimeout(syncLoop, ms == null ? SYNC_MS : ms);
  }

  function syncLoop() {
    if (!joined || !me) { return; }
    var params = { id: me };
    if (pendingHit) { params.a = 1; pendingHit = false; }

    post(API + '/sync', params).then(function (d) {
      miss = 0;
      elStatus.textContent = '';
      if (d && d.you === null) {
        // 会话过期（超时被请走 / 服务器重启）
        joined = false; me = null;
        elHit.disabled = true;
        overlay.classList.remove('hidden');
        elErr.textContent = '会话已过期，请重新进入';
        elEnter.disabled = false;
        return;
      }
      apply(d);
      scheduleSync(SYNC_MS);
    }).catch(function () {
      miss++;
      if (miss >= MAX_MISS) {
        joined = false; me = null;
        elHit.disabled = true;
        overlay.classList.remove('hidden');
        elErr.textContent = '与服务器断开了，正在重连…';
        elEnter.disabled = false;
        setTimeout(enter, 1500);
        return;
      }
      elStatus.textContent = '同步失败 ' + miss + '/' + MAX_MISS + '，重试中…';
      scheduleSync(600);
    });
  }

  // ---------------- 渲染 ----------------

  function apply(d) {
    if (!d) { return; }
    elCount.textContent = d.total || 0;
    elMine.textContent = d.myScore || 0;
    elOnline.textContent = d.online || 0;

    var html = '';
    (d.players || []).forEach(function (p) {
      html += '<li><span>' + esc(p.n) + (p.id === me ? '（你）' : '') + '</span>'
            + '<b>' + (p.sc || 0) + '</b></li>';
    });
    elPlayers.innerHTML = html || '<li class="sub">还没有人</li>';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ---------------- 交互 ----------------

  elEnter.addEventListener('click', enter);

  elHit.addEventListener('click', function () {
    if (!joined) { return; }
    pendingHit = true;
    if (syncTimer) { clearTimeout(syncTimer); }
    syncLoop();          // 立即同步，不等下一次定时
  });

  // 启动器的「名字登记」（表情/聊天是启动器功能，与游戏无关，不用管）
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (d && d.kaihei === 'name' && typeof d.n === 'string' && d.n) {
      myName = d.n.slice(0, 10);
    }
  });

  // 离开时主动退出（尽力而为）
  window.addEventListener('beforeunload', function () {
    if (me) { post(API + '/leave', { id: me }); }
  });
})();
