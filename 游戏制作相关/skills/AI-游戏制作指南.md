# 给「开黑启动器」做游戏 —— 通用 AI 指南

> **怎么用**：把这份文件**整个**贴给任何 AI（ChatGPT / Claude / Gemini / 本地模型），
> 再说一句"按这份规范给我做一个 XX 游戏"，它就能产出可以直接导入运行的游戏。
> 不需要其它资料、不需要联网。
>
> 适用项目：**lkserver2-game**（"开黑启动器"）　最后更新：2026-10-17

---

## 0. 先理解三件事

1. 这是一个**多游戏启动器**：`gamemode/<id>/` 下一个游戏一个文件夹。
2. **服务器内核里没有任何具体游戏**。每个游戏自带前端；要联机才自带服务端代码，
   内核会在启动这个游戏时**现场编译**它的 `server/` 源码。
3. 游戏靠启动器「＋ 添加游戏」**整份导入**。导入后 **游戏 id 会被服务端改成
   `g` + base36 时间戳**（例：`gmv9ny2bh`），**不是** `game.json` 里写的那个。

由此得到最重要的一条：**客户端绝不能写死接口路径**。

---

## 1. 产出物：一个自包含文件夹

### 纯单机（3 个文件）

```
mygame/
├── game.json
├── index.html
└── game.js
```

### 联机（多一个服务端目录）

```
mygame/
├── game.json
├── index.html
├── game.js
└── server/
    └── MyWorld.java
```

**判断标准**：需要多人同局 / 需要防作弊 → 联机；否则单机。
单机游戏**不要**写 `world` 字段（否则会多出一个没人用的启停开关）。

---

## 2. game.json

```json
{
  "id": "mygame",
  "name": "我的游戏",
  "desc": "一句话简介",
  "icon": "🎮",
  "entry": "index.html",
  "world": "lkserver.MyWorld",
  "autostart": false,
  "version": 1
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 只能 `[a-z0-9_-]`，≤32 字符；与目录名一致 |
| `name` | ✅ | 显示名，≤12 字符 |
| `desc` | | 简介，≤60 字符 |
| `icon` | | emoji，或游戏目录里的图片文件名（如 `tank.ico`）；缺省 🎮 |
| `entry` | | 入口页，缺省 `index.html` |
| `world` | 联机必填 | 服务端类全限定名，如 `lkserver.MyWorld` |
| `autostart` | | `true` = 随服务器自启（只在服务器启动时读一次） |
| `version` | | 随便 |

---

## 3. 客户端（game.js）

### 3.1 取游戏 id —— 第一条红线

```js
var GID = (location.pathname.match(/\/games\/([^\/]+)/) || [])[1] || 'mygame';
var API = '/api/' + GID;
```

写死 `/api/mygame` 的游戏，直接放进 `gamemode/` 能跑，
**一旦被导入就全部 404**。

### 3.2 三个接口

| 接口 | 参数（form-urlencoded） | 返回 |
|---|---|---|
| `POST {API}/join` | `name`, `cid` | `{id, ...}`，**必须含 id** |
| `POST {API}/sync` | `id` + 自定义输入 | 世界快照（结构自定） |
| `POST {API}/leave` | `id` | `{ok:true}` |

统一 post 助手：

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

`sync` 要**一次往返同时上报输入和拿回状态**，不要拆两个请求。

错误码：**409** = 世界没启动（房主没拨开关，正常现象，提示等待）；
**404** = 游戏不存在；**403** = 非房主做了房主操作。

### 3.3 身份 cid

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

服务端靠 cid 在刷新 / 断线重连时**复用原角色**，不会多出一个号。

### 3.4 连接循环

```js
var me = null, joined = false, syncTimer = null, miss = 0;
var SYNC_MS = 100;      // 射击类 30~60；回合制 300~500 也行
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
  post(API + '/sync', { id: me /* + 输入 */ }).then(function (d) {
    miss = 0;
    if (d.you === null) { joined = false; me = null; return; }  // 会话过期，重新 join
    apply(d);
    scheduleSync(SYNC_MS);
  }).catch(function () {
    miss++;
    if (miss >= MAX_MISS) { joined = false; enter(); return; }
    scheduleSync(500);
  });
}
```

要点：**上一次应答到了再发下一次**（不要用 `setInterval` 叠请求）；
连续失败到阈值就重新 join（cid 相同 → 认回原角色）。

### 3.5 名字（启动器下发）

```js
var myName = '';
window.addEventListener('message', function (ev) {
  var d = ev.data;
  if (d && d.kaihei === 'name' && typeof d.n === 'string') {
    myName = d.n.slice(0, 10);
  }
});
```

> **表情栏和聊天框属于启动器，不属于游戏**（全服共享，走内核 `/api/chat`）。
> 游戏不要实现它们，也不要读取渲染。

### 3.6 渲染

- 逻辑用**固定 tick + 累加器**，画面在 tick 之间**插值**，低速也不会一顿一顿：
  ```js
  var TICK = 150, acc = 0, last = 0;
  function loop(ts) {
    requestAnimationFrame(loop);
    var dt = last ? Math.min(ts - last, 100) : 0; last = ts;
    acc += dt;
    var guard = 0;
    while (acc >= TICK && guard++ < 8) { acc -= TICK; tick(); }
    render(acc / TICK);
  }
  ```
- 服务端权威的游戏：快照里的格子是离散的，直接画会"一格一跳"。
  让服务端给出**步进相位**（这一步走了 0~1）和步进间隔，客户端按
  `相位 + (now - 快照到达) / 步进间隔` 连续外推；新快照到达时**保持绝对位置连续**
  （相位减 1，而不是跳变），只做极小漂移校正。
- **不要每帧 `shadowBlur`**（很慢）：预渲染到离屏 canvas，之后只 `drawImage`。
- 圆角矩形必须写标准四段 `arcTo`（下面"坑"里有）。

---

## 4. 服务端（联机才需要）

### 4.1 接口

```java
package lkserver;   // 必须：这样能直接用内核的 Json 等工具类

public interface GameWorldPlugin {
    void start();                                  // 起 tick 线程
    void stop();                                   // 停 tick（不清数据）
    String join(String rawName, String rawCid);    // 返回完整 JSON，必须含 id
    String sync(String id, Map<String,String> p);  // 上报输入 + 返回快照
    void leave(String id);
    String info();                                 // 完整 JSON
    int playerCount();                             // 在线人数（启停/删除用它判断有人在玩）
}
```

### 4.2 完整最小实现（可直接用）

```java
package lkserver;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

public final class MyWorld implements GameWorldPlugin {

    static final class Player {
        final String id;
        String name, cid;
        int score;
        boolean online = true;
        long lastSeen;
        Player(String id) { this.id = id; }
    }

    private static final long TICK_MS = 500;
    private static final long IDLE_MS = 5000;
    private static final long TIMEOUT_MS = 30000;

    private final Map<String, Player> players = new LinkedHashMap<>();
    private final Map<String, String> cidToId = new LinkedHashMap<>();
    private final AtomicLong seq = new AtomicLong(1);
    private volatile ScheduledExecutorService ticker;
    private int total;   // ← 换成你的世界状态

    @Override public void start() {
        ScheduledExecutorService s = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "MyTick");
            t.setDaemon(true);
            return t;
        });
        ticker = s;
        s.scheduleAtFixedRate(this::safeTick, TICK_MS, TICK_MS, TimeUnit.MILLISECONDS);
    }

    @Override public void stop() {
        ScheduledExecutorService s = ticker;
        if (s != null) { s.shutdownNow(); }
    }

    private void safeTick() {
        try { tick(); } catch (RuntimeException e) {
            System.err.println("[MyTick] " + e);
        }
    }

    private synchronized void tick() {
        long now = System.currentTimeMillis();
        players.values().removeIf(p -> now - p.lastSeen > TIMEOUT_MS);
        for (Player p : players.values()) {
            if (now - p.lastSeen > IDLE_MS) { p.online = false; }
        }
        // 这里推进世界（回合制可以什么都不做）
    }

    @Override public synchronized String join(String rawName, String rawCid) {
        String cid = sanitizeCid(rawCid);
        if (cid != null) {
            String old = cidToId.get(cid);
            if (old != null && players.containsKey(old)) {
                Player p = players.get(old);
                p.name = sanitizeName(rawName);
                p.lastSeen = System.currentTimeMillis();
                p.online = true;
                return "{\"id\":" + Json.quote(p.id) + "}";
            }
        }
        String id = "p" + seq.getAndIncrement();
        Player p = new Player(id);
        p.name = sanitizeName(rawName);
        p.cid = cid;
        p.lastSeen = System.currentTimeMillis();
        players.put(id, p);
        if (cid != null) { cidToId.put(cid, id); }
        return "{\"id\":" + Json.quote(id) + "}";
    }

    @Override public synchronized void leave(String id) {
        Player p = players.remove(id);
        if (p != null && p.cid != null) { cidToId.remove(p.cid); }
    }

    @Override public synchronized int playerCount() {
        int n = 0;
        for (Player p : players.values()) { if (p.online) { n++; } }
        return n;
    }

    @Override public synchronized String info() {
        return "{\"players\":" + playerCount() + ",\"total\":" + total + "}";
    }

    @Override public synchronized String sync(String id, Map<String, String> p) {
        Player me = players.get(id);
        if (me == null) {
            return "{\"you\":null,\"err\":\"会话已过期，请重新进入\"}";
        }
        me.lastSeen = System.currentTimeMillis();
        me.online = true;

        if (GameWorldPlugin.intOf(p, "a", 0) == 1) { total++; me.score++; }  // ← 换成你的输入

        return "{\"t\":" + System.currentTimeMillis()
                + ",\"you\":" + Json.quote(me.id)
                + ",\"total\":" + total
                + ",\"myScore\":" + me.score
                + ",\"online\":" + playerCount() + "}";
    }

    private static String sanitizeCid(String raw) {
        if (raw == null) { return null; }
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < raw.length() && b.length() < 32; i++) {
            char c = raw.charAt(i);
            if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
                    || (c >= '0' && c <= '9') || c == '-' || c == '_') { b.append(c); }
        }
        return b.length() == 0 ? null : b.toString();
    }

    private static String sanitizeName(String raw) {
        if (raw == null) { return "玩家"; }
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < raw.length() && b.length() < 10; i++) {
            char c = raw.charAt(i);
            if (c >= 0x20 && c != '<' && c != '>' && c != '&' && c != '"' && c != '\\') {
                b.append(c);
            }
        }
        String s = b.toString().trim();
        return s.isEmpty() ? "玩家" : s;
    }
}
```

### 4.3 必须遵守

- 所有对外方法 **`synchronized`**（tick 线程 + HTTP 线程并发）
- `sync` / `join` 对**任意垃圾参数都不能抛异常**（抛了就返回 500，客户端同步链会断）
- 玩家要清理：`IDLE` 标离线（5s 左右）+ `TIMEOUT` 移除（30s 左右）
- 内核可用工具：`Json.quote(s)`、`Json.str(map,"k",def)`、`Json.parse(text)`、
  `GameWorldPlugin.intOf/longOf/doubleOf/boolOf`（**注意带类名**）
- 服务端源码需要 **JDK**（有 `javac`）才能现场编译；只有 JRE 时改用 `server.jar`

---

## 5. 导入 / 启停 / 删除

- **导入**：启动器「＋ 添加游戏」→ 选**含 `game.json` 的那一层**
  （**不要**双击进 `server/`）。`game.json` 本体不上传（服务端按新 id 重写）。
  上限：单文件 32MB、总量 512MB、文件数 2000。
- **启停**：联机游戏由**房主**拨开关（上开 / 下关）；同时最多 4 个世界在跑；
  **里面还有玩家时停不掉**。
- **删除**：每个游戏左上角 ✕（房主专属），连同整个目录删掉，不可恢复。
- 改**前端**：存盘即生效（Ctrl+F5）。
- 改**服务端**：开关关了再开（会重新编译加载），不用重编 jar、不用重启服务器。

---

## 6. 常见坑（症状 → 解法）

| 症状 | 根因 / 解法 |
|---|---|
| 导入后点进去是"这个游戏还没开工" | 导入时选进了 `server/` 子目录。重导，选含 `game.json` 的那层 |
| 导入后接口全 404 | 客户端写死了 `/api/xxx`。改用 `location.pathname` 取 id |
| 拨开关失败、接口一直 409 | `world` 类名错，或源码没 `package lkserver;` |
| join 成功却进不去 | 返回 JSON 里没有 `id` |
| 画面一格一跳 / 一顿一顿 | 直接画离散快照。要做插值 / 相位外推 |
| 圆角矩形几乎填不出色（像透明） | `arcTo` 的 P1 与 P2 重合会退化成直线。四段标准写法，`r` 夹到半边长 |
| 低端机卡顿 | 每帧 `shadowBlur`。改离屏 sprite 缓存 |
| 改了 `autostart` 不生效 | 只在服务器启动时读一次，改完要重启服务器 |
| 偶发 `ConcurrentModificationException` | 方法没加 `synchronized` |
| 房间/座位永远被占 | 离线玩家没清理（IDLE + TIMEOUT） |
| 名字撑坏布局 / 注入 HTML | 服务端清洗 + 前端转义后再插入 |

**标准圆角矩形**（四个控制点两两不同）：

```js
function roundRect(ctx, x, y, w, h, r) {
  var rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y,     x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x,     y + h, rr);
  ctx.arcTo(x,     y + h, x,     y,     rr);
  ctx.arcTo(x,     y,     x + w, y,     rr);
  ctx.closePath();
}
```

---

## 7. 交付前自检

- [ ] `node --check game.js` 通过
- [ ] `game.json` 的 `id` 只含 `[a-z0-9_-]`，与目录名一致
- [ ] 全文没有硬编码 `/api/<名字>`（搜一遍）
- [ ] 联机：`world` 类名正确、源码 `package lkserver;`、`implements GameWorldPlugin`
- [ ] 联机：`join` 返回含 `id` 的 JSON
- [ ] 联机：所有对外方法 `synchronized`
- [ ] 联机：`sync` 面对乱参数不崩
- [ ] 名字清洗 + 渲染转义
- [ ] 写了 `test-<id>.js` 并跑通
- [ ] **导入实测**：不是占位页、开关能拨、真能玩

---

## 8. 给 AI 的提示词模板（可直接复制）

> 按上面的《给「开黑启动器」做游戏》规范，给我做一个 **【游戏名】**。
> 要求：
> - 类型：【纯单机 / 联机】
> - 玩法：【一句话描述核心玩法与操作】
> - 人数：【单人 / 2 人同屏 / 多人同时在线】
> - 是否需要房间：【不需要 / 需要房间码加入】
>
> 产出：一个完整的游戏文件夹（game.json + index.html + game.js，联机再加
> server/XxxWorld.java），代码要能直接运行。最后按第 7 节自检清单逐条确认。
