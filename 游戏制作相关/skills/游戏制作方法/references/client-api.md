# 客户端（game.js）

## 0. 取游戏 id —— 最容易犯的错

游戏被导入后，目录名 / id 会变成 `g` + base36 时间戳（例：`gmv9ny2bh`），
**不是** `game.json` 里写的那个。任何写死的 `/api/xxx` 在导入后都会 404。

```js
var GID = (location.pathname.match(/\/games\/([^\/]+)/) || [])[1] || 'mygame';
var API = '/api/' + GID;
```

写完之后 `grep` 一遍，确保没有别处硬编码 `/api/`。

## 1. 统一的 post 助手

```js
function post(path, params) {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    cache: 'no-store'
  }).then(function (r) { return r.json(); });
}
```

## 2. 身份（cid）

同一个浏览器标签一个稳定 cid，存 `sessionStorage`。服务端靠它复用角色：
刷新页面 / 断线重连不会多出一个号，房间座位也还在。

```js
function getCid() {
  var c = sessionStorage.getItem('mygameCid');
  if (!c) {
    c = 'c' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    sessionStorage.setItem('mygameCid', c);
  }
  return c;
}
```

## 3. 连接生命周期

```js
var me = null, joined = false, syncTimer = null, miss = 0;
var SYNC_MS = 100;          // 射击类 30~60；回合制可以 300~500
var MAX_MISS = 3;

function enter() {
  post(API + '/join', { name: myName, cid: getCid() }).then(function (d) {
    if (!d || !d.id) { throw new Error((d && d.error) || 'join failed'); }
    me = d.id; joined = true; miss = 0;
    scheduleSync(0);
  }).catch(function (e) {
    joinErr.textContent = e.message || '连不上服务器';
  });
}

function scheduleSync(ms) {
  if (syncTimer) { clearTimeout(syncTimer); }
  syncTimer = setTimeout(syncLoop, ms == null ? SYNC_MS : ms);
}

function syncLoop() {
  if (!joined || !me) { return; }
  post(API + '/sync', { id: me /* + 你的输入 */ }).then(function (d) {
    miss = 0;
    if (d.you === null) {        // 会话过期（超时/服务器重启）
      joined = false; me = null;
      return;                    // 重新 join
    }
    apply(d);
    scheduleSync(SYNC_MS);
  }).catch(function () {
    miss++;
    if (miss >= MAX_MISS) { joined = false; enter(); return; }
    scheduleSync(500);
  });
}
```

要点：
- **一次 sync 同时上报输入 + 拿回状态**，不要拆两个请求。
- 上一次的应答到了再发下一次（不要 `setInterval` 叠请求）。
- 连续失败到阈值就重新 join（cid 相同 → 服务端认回原角色）。

## 4. 处理 409（世界没启动）

世界没被房主拨开时，`join` 返回 409 + `{"error":"游戏未启动…"}`。
把这个原因**照实显示**，并可以自动重试：

```js
joinErr.textContent = d.error + '，正在自动重试…';
setTimeout(enter, 2000);
```

不要吞成"连不上服务器" —— 服务器明明开着，那句话会误导玩家。

## 5. 名字登记（唯一需要的启动器联动）

```js
var myName = '';
window.addEventListener('message', function (ev) {
  var d = ev.data;
  if (d && d.kaihei === 'name' && typeof d.n === 'string') {
    myName = d.n.slice(0, 10);
  }
});
```

> **表情栏和聊天框是启动器自己的功能**（全服共享，走内核 `/api/chat`），
> 与游戏零协议。游戏不要实现它们，也不要读取渲染。

## 6. 渲染

### 单机 / 自走游戏：固定 tick + 插值

```js
var TICK = 150, acc = 0, last = 0;

function loop(ts) {
  requestAnimationFrame(loop);
  var dt = last ? Math.min(ts - last, 100) : 0;
  last = ts;
  acc += dt;
  var guard = 0;
  while (acc >= TICK && guard++ < 8) { acc -= TICK; tick(); }   // 逻辑按固定步长
  render(acc / TICK);                                          // 画面按相位插值
}
```

`prevState` → `state` 之间按 `acc / TICK` 线性插值，低速档也不会一顿一顿。

### 服务端权威游戏：按服务端节拍外推

快照里的格子是离散的，直接画会"一格一跳"。做法：
- 服务端在快照里给出**当前步进相位**（这一步走了多少，0~1）和**步进间隔**
- 客户端按 `相位 + (now - 快照到达时间) / 步进间隔` 连续外推
- 相邻两节沿路径取值，保证网格距离 ≤ 1 格（不会出现"裂缝"）

详见 `references/pitfalls.md` 里"同步与插值"。

### 性能

- **不要每帧 `shadowBlur`**：改成离屏 canvas 预渲染成 sprite，之后 `drawImage`。
- 大画布只画视口内的东西（裁剪），别整张地图每帧重绘。
- 圆角矩形用**标准四段 `arcTo`**（见 pitfalls 第一条）。

## 7. 收尾

- `beforeunload` / 离开时 `post(API + '/leave', { id: me })`
- 切标签页（`document.hidden`）时可以暂停渲染节省资源
- 所有服务端返回的字符串（名字）**渲染前转义**，别直接塞 `innerHTML`
