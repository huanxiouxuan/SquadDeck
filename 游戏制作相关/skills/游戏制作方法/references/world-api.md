# 服务端世界（GameWorldPlugin）

## 接口

```java
package lkserver;

public interface GameWorldPlugin {
    void start();                                  // 起 tick 线程
    void stop();                                   // 停 tick（不清数据）
    String join(String rawName, String rawCid);    // 返回完整 JSON，必须含 id
    String sync(String id, Map<String, String> p); // 上报输入 + 返回快照
    void leave(String id);                         // 主动退出
    String info();                                 // 完整 JSON 概览
    int playerCount();                             // 在线人数
}
```

## 语义细节

| 方法 | 必须做到 |
|---|---|
| `start()` | 起 `ScheduledExecutorService`（daemon 线程），按 tick 间隔推进世界 |
| `stop()` | `shutdownNow()`。**不要清数据** —— 再 start 等同"重开一局"，由你自己在 start/构造时重置 |
| `join(name, cid)` | 分配或复用玩家；返回 `{"id":"p1",...}`。**同 cid 必须复用旧角色**（刷新/重连不多出号） |
| `sync(id, p)` | 读输入、刷新在线时间、返回快照。未知/非法参数**一律容错**，不能抛异常 |
| `leave(id)` | 移除玩家 + 清理他占的资源（房间座位、队伍位等） |
| `playerCount()` | 只算**在线**的（离线未超时的不算）—— 启停和删除靠它判断"有没有人在玩" |
| `info()` | 给 `GET /api/<id>/info`，随便什么 JSON，但必须是合法 JSON |

`sync` 返回 `null` → 客户端拿到 500。

## 线程模型

- tick 线程（你的 `ScheduledExecutorService`）
- HTTP 线程（内核的 NIO reactor）

两者会同时碰世界状态 → **所有对外方法 `synchronized`**。临界区别写太长
（这个规模完全够用）。

## 最小可用世界（可复制）

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

    private final Map<String, Player> players = new LinkedHashMap<>();
    private final Map<String, String> cidToId = new LinkedHashMap<>();
    private final AtomicLong seq = new AtomicLong(1);
    private volatile ScheduledExecutorService ticker;

    private static final long IDLE_MS = 5000;      // 超过标离线
    private static final long TIMEOUT_MS = 30000;  // 超过移除

    // ---------- 生命周期 ----------
    @Override public void start() {
        ScheduledExecutorService s = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "MyTick");
            t.setDaemon(true);
            return t;
        });
        ticker = s;
        s.scheduleAtFixedRate(this::safeTick, 100, 100, TimeUnit.MILLISECONDS);
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
        // ...这里推进世界...
    }

    // ---------- 玩家 ----------
    @Override
    public synchronized String join(String rawName, String rawCid) {
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

    @Override
    public synchronized void leave(String id) {
        Player p = players.remove(id);
        if (p != null && p.cid != null) { cidToId.remove(p.cid); }
    }

    @Override
    public synchronized int playerCount() {
        int n = 0;
        for (Player p : players.values()) { if (p.online) { n++; } }
        return n;
    }

    @Override
    public synchronized String info() {
        return "{\"players\":" + playerCount() + "}";
    }

    // ---------- 同步 ----------
    @Override
    public synchronized String sync(String id, Map<String, String> p) {
        Player me = players.get(id);
        if (me == null) {
            return "{\"you\":null,\"err\":\"会话已过期，请重新进入\"}";
        }
        me.lastSeen = System.currentTimeMillis();
        me.online = true;

        // 自定义输入：一律带默认值 + 容错
        int action = GameWorldPlugin.intOf(p, "a", 0);
        if (action == 1) { me.score++; }

        return snapshot(me);
    }

    private String snapshot(Player me) {
        StringBuilder b = new StringBuilder(256);
        b.append("{\"t\":").append(System.currentTimeMillis())
         .append(",\"you\":").append(Json.quote(me.id))
         .append(",\"score\":").append(me.score)
         .append(",\"players\":[");
        boolean first = true;
        for (Player p : players.values()) {
            if (!p.online) { continue; }
            if (!first) { b.append(','); }
            first = false;
            b.append("{\"id\":").append(Json.quote(p.id))
             .append(",\"n\":").append(Json.quote(p.name))
             .append(",\"sc\":").append(p.score).append('}');
        }
        b.append("]}");
        return b.toString();
    }

    // ---------- 清洗 ----------
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

## 能直接用的内核工具

| 调用 | 说明 |
|---|---|
| `Json.quote(s)` | 转义成 JSON 字符串（含引号） |
| `Json.str(map, "k", def)` | 从 `Map<String,Object>` 取字符串 |
| `Json.parse(text)` | 解析 JSON 文本 |
| `GameWorldPlugin.intOf(p,"k",def)` | **注意要带类名**（接口 static 方法） |
| `GameWorldPlugin.longOf / doubleOf / boolOf` | 同上 |

不要把这些类复制进游戏目录——父类加载器会提供它们。

## 常见设计模式

**cid 身份复用**：`cidToId` 映射 + 玩家还在就复用。这是"刷新不掉线"的关键。

**离线两层**：
- `IDLE_MS`（约 5s）→ 标 `online=false`（别人看他消失，但号还在）
- `TIMEOUT_MS`（约 30s）→ 真正移除，腾出资源

**回合制游戏**：tick 频率可以低（1Hz），只用来做超时清理；逻辑全在 `sync` 里
按动作驱动。

**房间制游戏**（五子棋那种）：`Map<String, Room>`，每个房间两个座位；
`sync` 用 `act` 参数分发（create/join/place/...）；房满时拒绝第三人。
见 `gamemode/gmv9ny2bh/server/GomokuWorld.java`（或 `D:\项目\实验-游戏添加功能\server\`）。
