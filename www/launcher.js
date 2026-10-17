/* 开黑启动器前端：左侧游戏列表 + iframe 载入选中的游戏 + 添加游戏。
   数据来自 GET /api/games（服务端扫描 gamemode/ 目录）。
   添加游戏 = 从任意磁盘选文件夹导入：POST /api/games/import 建目录、写 game.json，
   再逐文件 POST /api/games/upload 把文件复制进 gamemode/<id>/。 */
(function () {
  'use strict';

  var listEl = document.getElementById('list');
  var stage = document.getElementById('stage');
  var curNameEl = document.getElementById('curName');
  var modal = document.getElementById('modal');
  var addBtn = document.getElementById('addBtn');
  var refreshBtn = document.getElementById('refreshBtn');
  var nameInput = document.getElementById('gname');
  var descInput = document.getElementById('gdesc');
  var errEl = document.getElementById('gErr');
  var importBtn = document.getElementById('importBtn');
  var cancelBtn = document.getElementById('cancelBtn');

  // =========================================================
  // 表情栏 + 聊天（启动器自己的功能，与游戏完全无关）：
  // 表情点一下进公共聊天频道；右侧聊天框可打任意文字。
  // 两边都走内核 /api/chat（全服一个房间）——不经过任何游戏的协议，
  // 游戏接不接、运不运行都不影响；切游戏、甚至不选游戏，记录都接着算。
  // 服务器只按长度截断，不做字符过滤：这是启动器的聊天室，不是游戏输入协议。
  //
  // 【表情库】想换成你自己的表情就改下面这一行——纯文本数组，增删随意。
  // =========================================================
  var EMOJI_LIST = ['👍', '👏', '❤️', '🔥', '🎉', '😂', '😎', '😱', '💀', '🚀', '⭐', '💪'];

  var games = [];
  var current = null;
  var isHost = false;   // 是不是房主（开服务器那台电脑）——只有房主能拨启停开关

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // 图标渲染：图片文件名（.png/.jpg/.gif/.svg/.webp/.ico）发 <img>，
  // 相对名解析到游戏自己的目录（/games/<id>/）；其余按 emoji 文本渲染。
  // 图片加载失败时退回默认 emoji，不会留个碎图标。
  function iconHtml(g) {
    var icon = g.icon || '\uD83C\uDFAE';
    if (/\.(png|jpe?g|gif|svg|webp|ico)$/i.test(icon)) {
      var base = g.url || ('/games/' + encodeURIComponent(g.id) + '/');
      var src = /^(https?:\/\/|\/)/.test(icon) ? icon : base + icon;
      return '<img src="' + esc(src) + '" alt="" draggable="false" ' +
             'onerror="this.parentNode.textContent=\'\uD83C\uDFAE\'">';
    }
    return esc(icon);
  }

  // ---------- 列表 ----------

  function load() {
    fetch('/api/games', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        games = (d && d.games) || [];
        isHost = !!(d && d.host);
        render();
        var prev = current;
        if (!current || !games.some(function (g) { return g.id === current; })) {
          current = games.length ? games[0].id : null;
        }
        if (current) {
          // 只有「刷新后还是同一个游戏」才不重载 iframe；当前游戏被删了就换第一个并重载
          select(current, current === prev);
        } else {
          curNameEl.textContent = '还没有游戏';
          stage.src = 'about:blank';
        }
      })
      .catch(function () {
        listEl.innerHTML = '<div class="empty">连不上服务器……<br>请确认服务器窗口还开着。</div>';
        curNameEl.textContent = '离线';
      });
  }

  function render() {
    if (!games.length) {
      listEl.innerHTML = '<div class="empty">游戏库是空的。<br>点下面的「＋ 添加游戏」<br>把第一个游戏放进来。</div>';
      return;
    }
    var html = '';
    games.forEach(function (g) {
      var srv = g.srv === true;   // 有服务端世界（联机游戏）才有开关
      var run = g.run === true;   // 世界此刻在跑
      var sw = '';
      if (srv) {
        sw = '<button type="button" class="vsw' + (run ? ' on' : '') + (isHost ? '' : ' locked') +
             '" data-id="' + esc(g.id) + '" title="' +
             (isHost ? (run ? '运行中 · 点一下关闭' : '未启动 · 点一下启动')
                     : '只有房主（开服务器的人）可以启停游戏') +
             '"><span class="knob"></span></button>';
      }
      var del = '<button type="button" class="del' + (isHost ? '' : ' locked') +
              '" data-id="' + esc(g.id) + '" title="' +
              (isHost ? '删除这个游戏' : '只有房主（开服务器的人）可以删除游戏') +
              '">✕</button>';
      html += '<div class="game-item' + (g.id === current ? ' active' : '') +
              '" data-id="' + esc(g.id) + '" title="' + esc(g.desc || g.name) + '">' + del +
              '<div class="icon">' + iconHtml(g) + '</div>' +
              '<div class="meta"><b>' + esc(g.name) + '</b><span>' + esc(g.desc || '') + '</span>' +
              (srv ? '<span class="state' + (run ? ' run' : '') + '">' +
                     (run ? '● 运行中' : '○ 未启动') + '</span>' : '') +
              '</div>' + sw + '</div>';
    });
    listEl.innerHTML = html;
  }

  listEl.addEventListener('click', function (e) {
    // 删除叉、启停开关都要先拦住，别触发下面的「选中游戏」
    var del = e.target.closest ? e.target.closest('.del') : null;
    if (del) {
      deleteGame(del.getAttribute('data-id'), del);
      return;
    }
    var sw = e.target.closest ? e.target.closest('.vsw') : null;
    if (sw) {
      toggleGame(sw.getAttribute('data-id'), sw);
      return;
    }
    var item = e.target.closest ? e.target.closest('.game-item') : null;
    if (item) {
      // 名字门禁：没登记名字不给选游戏（聊天/表情同理），闪名字框引导
      if (!hasName()) { flashNameBox(); return; }
      select(item.getAttribute('data-id'));
    }
  });

  // ---------- 游戏启停开关（房主专属） ----------
  // 上 = 开，下 = 关。POST /api/games/<id>/start|stop；好友点拨不动（抖动 + 提示）。
  // 切完刷新列表拿新状态（同一个游戏不会重载 iframe）。

  function showToast(msg) {
    var t = document.getElementById('toast');
    if (!t) { return; }
    t.textContent = msg;
    t.classList.remove('hidden');
    if (showToast._timer) { clearTimeout(showToast._timer); }
    showToast._timer = setTimeout(function () { t.classList.add('hidden'); }, 2200);
  }

  function findGame(id) {
    for (var i = 0; i < games.length; i++) {
      if (games[i].id === id) { return games[i]; }
    }
    return null;
  }

  function toggleGame(id, btn) {
    var g = findGame(id);
    if (!g || g.srv !== true) { return; }
    if (!isHost) {
      btn.classList.remove('shake');
      void btn.offsetWidth;   // 强制重排，让抖动动画能重放
      btn.classList.add('shake');
      showToast('只有房主（开服务器的人）可以启停游戏');
      return;
    }
    var starting = g.run !== true;
    btn.classList.add('busy');
    fetch('/api/games/' + encodeURIComponent(id) + (starting ? '/start' : '/stop'), {
      method: 'POST', cache: 'no-store'
    })
      .then(function (r) {
        return r.json().then(function (d) { return { ok: r.ok, d: d }; },
          function () { return { ok: r.ok, d: null }; });
      })
      .then(function (x) {
        btn.classList.remove('busy');
        if (!x.ok) {
          throw new Error((x.d && x.d.error) || '操作失败');
        }
        load();   // 刷新运行状态
      })
      .catch(function (e) {
        showToast(e && e.message ? e.message : String(e));
      });
  }

  // ---------- 删除游戏（每个游戏左上角的小叉，房主专属）----------
  // 会把这个游戏的整个文件夹删掉、不可恢复；正在运行的先停掉再删（有玩家则拒绝）。
  function deleteGame(id, btn) {
    var g = findGame(id);
    if (!g) { return; }
    if (!isHost) {
      btn.classList.remove('shake');
      void btn.offsetWidth;   // 强制重排，让抖动动画能重放
      btn.classList.add('shake');
      showToast('只有房主（开服务器的人）可以删除游戏');
      return;
    }
    var msg = '删除「' + g.name + '」？\n\n会把这个游戏的文件夹整个删掉，不能恢复。';
    if (g.srv === true && g.run === true) {
      msg = '删除「' + g.name + '」？\n\n它正在运行，会先把它停掉，再删掉整个文件夹，不能恢复。';
    }
    if (!window.confirm(msg)) { return; }

    btn.classList.add('busy');
    fetch('/api/games/' + encodeURIComponent(id) + '/delete', { method: 'POST', cache: 'no-store' })
      .then(function (r) {
        return r.json().then(function (d) { return { ok: r.ok, d: d }; },
          function () { return { ok: r.ok, d: null }; });
      })
      .then(function (x) {
        if (!x.ok) {
          btn.classList.remove('busy');
          throw new Error((x.d && x.d.error) || '删除失败');
        }
        showToast('已删除「' + g.name + '」');
        if (current === id) { current = null; stage.src = 'about:blank'; }
        load();   // 重新拉列表（当前游戏被删时会自动切到第一个）
      })
      .catch(function (e) {
        btn.classList.remove('busy');
        showToast(e && e.message ? e.message : String(e));
      });
  }

  /** 选中并载入一个游戏；点当前项相当于刷新重开。 */
  function select(id, keepSrc) {
    var g = null;
    for (var i = 0; i < games.length; i++) {
      if (games[i].id === id) { g = games[i]; break; }
    }
    if (!g) { return; }
    current = id;
    curNameEl.textContent = g.name;
    if (!keepSrc) {
      stage.src = g.url || ('/games/' + encodeURIComponent(id) + '/');
    }
    render();
  }

  // ---------- 添加游戏：从任意磁盘选文件夹，导入到 gamemode/ ----------
  // 流程：选文件夹（webkitdirectory）→ 识别 game.json → POST /api/games/import 建目录
  //       → 逐文件 POST /api/games/upload → 刷新列表并自动载入新游戏。

  var MAX_FILE_BYTES = 32 * 1024 * 1024;    // 与服务端 GameModes.MAX_IMPORT_FILE 一致
  var MAX_TOTAL_BYTES = 512 * 1024 * 1024;  // 与 GameModes.MAX_IMPORT_TOTAL 一致

  var dirPicker = document.getElementById('dirPicker');
  var pickBtn = document.getElementById('pickBtn');
  var pickInfo = document.getElementById('pickInfo');
  var warnEl = document.getElementById('gWarn');
  var progEl = document.getElementById('gProg');
  var progBar = document.getElementById('gBar');
  var progTxt = document.getElementById('gProgTxt');

  var picked = null;   // { root, name, desc, icon, entry, api, files:[{rel,file}], total }

  function fmtSize(n) {
    if (n >= 1024 * 1024) { return (n / 1048576).toFixed(1) + ' MB'; }
    if (n >= 1024) { return (n / 1024).toFixed(1) + ' KB'; }
    return n + ' B';
  }

  function resetPicker() {
    picked = null;
    dirPicker.value = '';
    pickInfo.textContent = '还没选择文件夹';
    warnEl.textContent = '';
    errEl.textContent = '';
    nameInput.value = '';
    descInput.value = '';
    importBtn.disabled = true;
    progEl.classList.add('hidden');
    progBar.style.width = '0%';
  }

  function openModal() {
    resetPicker();
    modal.classList.remove('hidden');
    nameInput.focus();
  }
  function closeModal() { modal.classList.add('hidden'); }

  addBtn.addEventListener('click', openModal);
  refreshBtn.addEventListener('click', function () { load(); });
  cancelBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', function (e) { if (e.target === modal) { closeModal(); } });
  pickBtn.addEventListener('click', function () { dirPicker.click(); });
  dirPicker.addEventListener('change', analyzePicked);

  /** 分析选中的文件夹：去重、找 game.json、算体积、预填表单。 */
  function analyzePicked() {
    var list = dirPicker.files;
    if (!list || !list.length) { return; }

    var map = Object.create(null);   // 防止文件名恰好叫 __proto__ 时出怪事
    var root = '';
    var dupWarn = '';
    var i, f, rel, slash;
    for (i = 0; i < list.length; i++) {
      f = list[i];
      rel = f.webkitRelativePath || '';
      if (rel) {
        slash = rel.indexOf('/');
        if (!root) { root = rel.substring(0, slash < 0 ? rel.length : slash); }
        rel = slash >= 0 ? rel.substring(slash + 1) : '';
      } else {
        rel = f.name;   // 浏览器不支持目录选择时退化成平铺文件
      }
      if (!rel) { continue; }
      if (map[rel] && !dupWarn) { dupWarn = '有同名文件，后选的会覆盖先选的'; }
      map[rel] = { rel: rel, file: f };
    }
    var files = Object.keys(map).map(function (k) { return map[k]; });
    if (!files.length) {
      errEl.textContent = '这个文件夹里没有可导入的文件。';
      importBtn.disabled = true;
      return;
    }
    if (!root) { root = '导入的游戏'; }

    var total = 0;
    files.forEach(function (x) { total += x.file.size; });

    // game.json：能解析就用它的 name/desc/icon/entry/api；本体不上传（服务端会按新 id 重写）
    var jsonFile = map['game.json'] ? map['game.json'].file : null;
    var warns = [];
    if (dupWarn) { warns.push(dupWarn); }
    var metaReady = Promise.resolve(null);
    if (jsonFile) {
      if (jsonFile.size > 64 * 1024) {
        warns.push('game.json 超过 64KB，已跳过，按普通文件夹导入');
      } else {
        metaReady = jsonFile.text().then(function (t) {
          try { return JSON.parse(t); }
          catch (e) { warns.push('game.json 解析失败，按普通文件夹导入'); return null; }
        });
      }
    } else {
      warns.push('没有找到 game.json，将用下面的名称/简介自动生成');
    }

    metaReady.then(function (meta) {
      var uploads = files.filter(function (x) { return x.rel !== 'game.json'; });
      var entry = (meta && typeof meta.entry === 'string' && meta.entry) ? meta.entry : 'index.html';
      var hasEntry = uploads.some(function (x) { return x.rel === entry; });

      // 明显的「选错文件夹」：既没有 game.json、也没有任何网页文件——
      // 多半是把 server/（服务端源码）之类的子目录当成了游戏目录。
      // 直接拦下，别导入一个只有源码、点进去是占位页的空壳。
      var hasHtml = uploads.some(function (x) { return /\.html?$/i.test(x.rel); });
      if (!jsonFile && !hasHtml) {
        errEl.textContent = '这看起来不是游戏文件夹：没有 game.json，也没有网页文件（.html）。'
            + '请退到上一级，选「包含 game.json / index.html 的那一层」再导入。';
        pickInfo.textContent = '选中的文件夹：' + root;
        importBtn.disabled = true;
        return;
      }

      if (!hasEntry) {
        warns.push('没有找到入口页 ' + entry + '，导入后会显示占位页');
      }

      var tooBig = uploads.filter(function (x) { return x.file.size > MAX_FILE_BYTES; });
      if (tooBig.length) {
        errEl.textContent = '文件 ' + tooBig[0].rel + ' 超过 32MB 上限，没法导入。';
        importBtn.disabled = true;
        return;
      }
      if (total > MAX_TOTAL_BYTES) {
        errEl.textContent = '总体积超过 512MB 上限，没法一次导入。';
        importBtn.disabled = true;
        return;
      }

      picked = {
        root: root,
        name: (meta && typeof meta.name === 'string' && meta.name) ? meta.name : root,
        desc: (meta && typeof meta.desc === 'string') ? meta.desc : '',
        icon: (meta && typeof meta.icon === 'string') ? meta.icon : '',
        entry: entry,
        api: (meta && typeof meta.api === 'string') ? meta.api : '',
        world: (meta && typeof meta.world === 'string') ? meta.world : '',
        autostart: !!(meta && meta.autostart),
        files: uploads,
        total: total
      };
      nameInput.value = picked.name.slice(0, 12);
      descInput.value = picked.desc.slice(0, 60);
      pickInfo.innerHTML = '<b>' + esc(root) + '</b><br>' + uploads.length + ' 个文件 · ' +
        fmtSize(total) + (jsonFile ? '<br>已识别 game.json' : '');
      warnEl.textContent = warns.join('；');
      errEl.textContent = '';
      importBtn.disabled = false;
    });
  }

  /** 导入：先建目录，再逐个上传文件，完成后自动载入新游戏。 */
  function importGame() {
    if (!picked) { return; }
    var name = (nameInput.value || '').trim();
    if (!name) {
      errEl.textContent = '先给游戏起个名字。';
      nameInput.focus();
      return;
    }
    importBtn.disabled = true;
    cancelBtn.disabled = true;
    errEl.textContent = '';
    progEl.classList.remove('hidden');
    progBar.style.width = '0%';
    progTxt.textContent = '正在创建游戏…';

    fetch('/api/games/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name,
        desc: (descInput.value || '').trim(),
        icon: picked.icon,
        entry: picked.entry,
        api: picked.api,
        world: picked.world,
        autostart: picked.autostart,
        files: picked.files.map(function (x) { return { p: x.rel, s: x.file.size }; })
      }),
      cache: 'no-store'
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!(d && d.ok && d.game)) {
          throw new Error((d && d.error) || '服务器拒绝了导入');
        }
        var id = d.game.id;
        var n = picked.files.length;
        var done = 0;
        var chain = Promise.resolve();
        picked.files.forEach(function (x) {
          chain = chain.then(function () {
            progTxt.textContent = '正在导入 ' + (done + 1) + '/' + n + '：' + x.rel;
            return fetch('/api/games/upload?game=' + encodeURIComponent(id) +
                '&path=' + encodeURIComponent(x.rel), {
              method: 'POST',
              headers: { 'Content-Type': 'application/octet-stream' },
              body: x.file,
              cache: 'no-store'
            })
              .then(function (r) { return r.json(); })
              .then(function (u) {
                if (!(u && u.ok)) {
                  throw new Error((u && u.error) || ('上传失败：' + x.rel));
                }
                done++;
                progBar.style.width = Math.round(done / n * 100) + '%';
              });
          });
        });
        return chain.then(function () { return id; });
      })
      .then(function (id) {
        progTxt.textContent = '导入完成';
        closeModal();
        load();
        current = id;
        select(id);
      })
      .catch(function (e) {
        importBtn.disabled = false;
        cancelBtn.disabled = false;
        progEl.classList.add('hidden');
        errEl.textContent = (e && e.message ? e.message : e) +
          '。已传上去的文件留在 gamemode/ 里，可以重试，或到资源管理器删掉那个目录再试。';
      });
  }
  importBtn.addEventListener('click', importGame);

  // ---------- 名字登记（右上角） ----------
  // 进游戏不用再输入名字：这里登记的名字会下发给 iframe 里的游戏（点「开始」即用），
  // 同时也是聊天和表情动态栏里你自己那条的名字。≤10 字，本地记住，刷新不丢。
  //
  // 【名字门禁】没登记名字 = 没有身份，聊天/表情/选游戏全部停用：
  // 这是开黑启动器——进来第一件事是报上名字。登记后自动恢复，无需刷新。

  var nameReg = document.getElementById('playerName');
  var chatInput = document.getElementById('chatInput');
  var chatSend = document.getElementById('chatSend');
  var emoteList = document.getElementById('emoteList');
  var nameFlashTimer = null;

  function playerName() {
    return (nameReg.value || '').trim().slice(0, 10);
  }
  function hasName() {
    return playerName().length > 0;
  }
  function sendName(n) {
    try {
      if (stage && stage.contentWindow) {
        stage.contentWindow.postMessage({ kaihei: 'name', n: n }, location.origin);
      }
    } catch (e) { /* 忽略 */ }
  }

  /** 按「有没有名字」开/关聊天与表情控件。无名字：输入框和按钮全部禁用，
   *  placeholder 改成引导语；登记后即刻恢复。 */
  function refreshNameGate() {
    var ok = hasName();
    chatInput.disabled = !ok;
    chatSend.disabled = !ok;
    var btns = emoteList.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) { btns[i].disabled = !ok; }
    chatInput.placeholder = ok ? '打字聊天，回车发送…' : '先在右上角登记名字（≤10 字）';
  }

  /** 被门禁拦下时：名字框红框抖两下 +  toast 说明。 */
  function flashNameBox() {
    showToast('请先在右上角「名字登记」里填个名字（≤10 字）');
    nameReg.classList.remove('flash');
    void nameReg.offsetWidth;   // 强制重排，让动画重放
    nameReg.classList.add('flash');
    if (nameFlashTimer) { clearTimeout(nameFlashTimer); }
    nameFlashTimer = setTimeout(function () { nameReg.classList.remove('flash'); }, 1200);
    try { nameReg.focus(); } catch (e) { /* 忽略 */ }
  }

  try { nameReg.value = localStorage.getItem('kaiheiName') || ''; } catch (e) { /* 忽略 */ }
  refreshNameGate();
  nameReg.addEventListener('input', function () {
    var v = (nameReg.value || '').slice(0, 10);
    try { localStorage.setItem('kaiheiName', v); } catch (e) { /* 忽略 */ }
    sendName(v);
    refreshNameGate();
  });
  // iframe 每次载入（切换游戏 / 刷新）后，把当前名字补发给新游戏
  stage.addEventListener('load', function () {
    sendName(playerName());
    // 切游戏会重载 iframe，焦点跟着丢到启动器页面；载入完就还给游戏，
    // 换完游戏 WASD 直接能用，不用先点一下游戏窗口。
    try { stage.focus(); } catch (e) { /* 忽略 */ }
  });

  // ---------- 焦点管理：别让启动器把键盘从游戏手里抢走 ----------
  // 游戏在 iframe 里跑，键盘事件只派发给「当前焦点所在的那个文档」。点启动器
  // 上的按钮/列表项会把焦点抓到启动器页面，之后 WASD/方向键全部失灵——
  // 典型现象：点完表情就不会操控了，点回游戏画面才恢复。两层对策：
  //
  // 1) mousedown 阶段 preventDefault：鼠标点这些区域不抢焦点，iframe 里的
  //    游戏继续收键盘。输入框（名字登记、导入表单）除外，该聚焦还让它聚焦。
  // 2) click 之后把焦点还给 iframe：覆盖键盘激活（Tab+Enter 点到按钮）和
  //    个别不认 mousedown preventDefault 的浏览器；关掉导入弹框后也同样
  //    生效，不会出现「导完游戏键盘死了」。
  var NO_STEAL = 'header, #list, #emoteBar';   // 这几块整体都不抢焦点（含内部按钮）

  function isFormField(t) {
    return !!(t && t.closest && t.closest('input, textarea, select, [contenteditable]'));
  }

  document.addEventListener('mousedown', function (e) {
    var t = e.target;
    if (!t || t.nodeType !== 1 || !t.closest) { return; }
    if (isFormField(t)) { return; }
    if (t.tagName === 'BUTTON' || t.closest(NO_STEAL)) { e.preventDefault(); }
  }, true);

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || t.nodeType !== 1 || !t.closest) { return; }
    if (isFormField(t)) { return; }
    // 聊天行里点来点去（输入框、发送按钮）不碰焦点：留着慢慢聊，
    // 想用键盘玩游戏时点一下游戏画面，焦点自然就过去了。
    if (t.closest('.chat-row')) { return; }
    if (t.tagName !== 'BUTTON' && !t.closest(NO_STEAL)) { return; }
    // 焦点还在 iframe 里就别撤（鼠标点击的正常路径：mousedown 已拦过，没丢过焦）；
    // 被按钮拿着（键盘激活等）才先 blur 再还给 iframe。
    if (document.activeElement && document.activeElement !== stage &&
        document.activeElement.blur) {
      document.activeElement.blur();
    }
    try { stage.focus(); } catch (err) { /* iframe 还没就绪也无所谓 */ }
  }, true);

  // ---------- 表情栏 + 聊天（启动器自己的功能，与游戏无关）----------
  // 左边：动态栏（自己 + 服务器里所有人的消息和表情，带名字）；
  // 右边：表情选择区 + 聊天输入框。
  //
  // 表情和聊天都走内核 /api/chat 公共频道（全服一个房间）：
  // 不经过任何游戏的协议——游戏接不接、运不运行都不影响；切游戏、
  // 甚至不选游戏，记录都接着算。每人每 1.5 秒增量轮询一次。
  // 消息里的名字取右上角「名字登记」栏的值。

  var emoteFeed = document.getElementById('emoteFeed');
  var emoteSent = document.getElementById('emoteSent');
  var sentTimer = null;
  var FEED_MAX = 30;    // 动态栏只留最新 30 条：超出即移除最旧的，不向上堆叠扩展
  var chatLastId = 0;   // 已拉到的最大消息 id（增量轮询的锚点）

  EMOJI_LIST.forEach(function (e) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = e;
    b.title = '发送 ' + e;
    b.addEventListener('click', function () { sendEmoji(e, b); });
    emoteList.appendChild(b);
  });
  // 表情按钮是动态创建的，比名字段的首次 refreshNameGate() 晚——补刷一次，
  // 否则无名字进来时输入框禁了、这 12 个按钮还点得动（登记后的恢复靠 input
  // 事件刷新，本来就有；漏的只是「初始禁用」这一时序）。
  refreshNameGate();

  /** 动态栏加一条。isEmoji = 纯表情/符号串 → 大号显示；否则按聊天文本。
   *  自动滚底只在「本来就在底部附近」时做：往上翻看历史时新消息不拽人。 */
  function feedAdd(name, content, isMe, isEmoji) {
    var empty = emoteFeed.querySelector('.feed-empty');
    if (empty) { empty.remove(); }
    var nearBottom = emoteFeed.scrollTop + emoteFeed.clientHeight
        >= emoteFeed.scrollHeight - 24;
    var item = document.createElement('div');
    item.className = 'feed-item' + (isMe ? ' me' : '') + (isEmoji ? '' : ' txt');
    var nb = document.createElement('b');
    nb.textContent = name || '玩家';
    var sp = document.createElement('span');
    sp.textContent = content;
    item.appendChild(nb);
    item.appendChild(sp);
    emoteFeed.appendChild(item);
    while (emoteFeed.children.length > FEED_MAX) {
      emoteFeed.removeChild(emoteFeed.firstChild);
    }
    if (nearBottom) { emoteFeed.scrollTop = emoteFeed.scrollHeight; }
  }

  /** 纯表情/符号串（没有字母、数字、汉字）且够短 → 按表情样式显示。 */
  function looksLikeEmoji(s) {
    return s.length <= 10 && /^[^\p{L}\p{N}]+$/u.test(s);
  }

  /**
   * 发一条到公共频道（表情或聊天文本）。
   * 发送成功后才进动态栏；顺手把返回的 id 记成轮询锚点——
   * 自己这条就不会被接下来的轮询重复渲染一遍。
   */
  function postChat(text, isEmoji) {
    if (!hasName()) { flashNameBox(); return; }   // 门禁双保险：控件禁用也可能被脚本/键盘绕过
    var t = (text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!t) { return; }
    var who = playerName() || '我';
    fetch('/api/chat', {
      method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: who, text: t })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.ok) {
          if (typeof d.id === 'number' && d.id > chatLastId) { chatLastId = d.id; }
          feedAdd(who, t, true, isEmoji);
        }
      })
      .catch(function () { /* 发送失败：本地不显示，下条再说 */ });
  }

  /** 增量轮询公共频道；chatLastId = 0 时后端回看最近 20 条（首屏历史）。 */
  function pollChat() {
    if (document.hidden) { return; }   // 标签页藏起来就别刷了，省点流量
    fetch('/api/chat?after=' + chatLastId, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var msgs = (d && d.msgs) || [];
        for (var i = 0; i < msgs.length; i++) {
          var m = msgs[i];
          feedAdd(m.name, m.text, false, looksLikeEmoji(m.text));
          if (m.id > chatLastId) { chatLastId = m.id; }
        }
      })
      .catch(function () { /* 轮询失败：下一秒再来 */ });
  }
  pollChat();
  setInterval(pollChat, 1500);

  function sendEmoji(e, btn) {
    if (!hasName()) { flashNameBox(); return; }   // 门禁双保险
    // 本地反馈：按钮缩一下 + 右侧显示"已发送 ♻"，1.6 秒后淡出
    if (btn) {
      btn.style.transform = 'scale(.82)';
      setTimeout(function () { btn.style.transform = ''; }, 120);
    }
    emoteSent.textContent = '已发送 ' + e;
    if (sentTimer) { clearTimeout(sentTimer); }
    sentTimer = setTimeout(function () { emoteSent.textContent = ''; }, 1600);
    // 进公共频道：服务器里所有人的启动器底栏都能看到
    postChat(e, true);
  }

  function submitChat() {
    var v = chatInput.value;
    chatInput.value = '';
    if (v.trim()) { postChat(v, looksLikeEmoji(v.trim())); }
    // 焦点留在输入框：可以连着聊；想用键盘玩游戏就点一下游戏画面
  }
  chatSend.addEventListener('click', submitChat);
  chatInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitChat();
    }
  });

  // 每 5 秒悄悄刷新一次列表：房主拨动开关后，好友这边几秒内就能看到
  // 「运行中 / 未启动」的变化（同一个游戏不会重载 iframe，见 load/select 的 keepSrc）
  setInterval(load, 5000);

  load();
})();
