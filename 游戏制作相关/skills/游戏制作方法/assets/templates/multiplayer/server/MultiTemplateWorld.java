package lkserver;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 联机模板世界：全服共享一个计数器，谁点一下 +1，所有人实时看到。
 *
 * <p>这是「最小可玩的联机骨架」，演示了做联机游戏必须处理的所有环节：
 * <ul>
 *   <li>cid 身份复用（刷新/重连不掉号）；</li>
 *   <li>sync 一次往返：上报动作 + 拿回快照；</li>
 *   <li>离线（IDLE）与超时（TIMEOUT）两层清理；</li>
 *   <li>所有对外方法 synchronized（tick 线程 + HTTP 线程并发）。</li>
 * </ul>
 *
 * <p>换成你的玩法时：把 {@code total} 换成一局世界状态，
 * 把 {@code a} 参数换成你的输入（方向、坐标、落子……）。
 */
public final class MultiTemplateWorld implements GameWorldPlugin {

    private static final long TICK_MS = 1000;      // 回合制用低频 tick 做清理就够
    private static final long IDLE_MS = 5000;
    private static final long TIMEOUT_MS = 30000;

    /** 一个玩家。 */
    static final class Player {
        final String id;
        String name;
        String cid;
        int score;
        boolean online = true;
        long lastSeen;

        Player(String id) {
            this.id = id;
        }
    }

    private final Map<String, Player> players = new LinkedHashMap<>();
    private final Map<String, String> cidToId = new LinkedHashMap<>();
    private final AtomicLong seq = new AtomicLong(1);
    private volatile ScheduledExecutorService ticker;

    /** 全服累计点击数（换成你自己的世界状态）。 */
    private int total;

    // =========================================================
    // 生命周期
    // =========================================================

    @Override
    public void start() {
        ScheduledExecutorService s = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "MultiTemplateTick");
            t.setDaemon(true);
            return t;
        });
        ticker = s;
        s.scheduleAtFixedRate(this::safeTick, TICK_MS, TICK_MS, TimeUnit.MILLISECONDS);
    }

    @Override
    public void stop() {
        ScheduledExecutorService s = ticker;
        if (s != null) {
            s.shutdownNow();
        }
    }

    private void safeTick() {
        try {
            tick();
        } catch (RuntimeException e) {
            System.err.println("[MultiTemplateTick] " + e);
        }
    }

    /** 只做清理；回合制游戏的逻辑放在 sync 里按动作驱动。 */
    private synchronized void tick() {
        long now = System.currentTimeMillis();
        players.values().removeIf(p -> now - p.lastSeen > TIMEOUT_MS);
        for (Player p : players.values()) {
            if (now - p.lastSeen > IDLE_MS) {
                p.online = false;
            }
        }
    }

    // =========================================================
    // 玩家
    // =========================================================

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
            cidToId.remove(cid);
        }

        String id = "p" + seq.getAndIncrement();
        Player p = new Player(id);
        p.name = sanitizeName(rawName);
        p.cid = cid;
        p.lastSeen = System.currentTimeMillis();
        players.put(id, p);
        if (cid != null) {
            cidToId.put(cid, id);
        }
        return "{\"id\":" + Json.quote(id) + "}";
    }

    @Override
    public synchronized void leave(String id) {
        Player p = players.remove(id);
        if (p != null && p.cid != null) {
            cidToId.remove(p.cid);
        }
    }

    @Override
    public synchronized int playerCount() {
        int n = 0;
        for (Player p : players.values()) {
            if (p.online) {
                n++;
            }
        }
        return n;
    }

    @Override
    public synchronized String info() {
        return "{\"players\":" + playerCount() + ",\"total\":" + total + "}";
    }

    // =========================================================
    // 同步
    // =========================================================

    /**
     * {@inheritDoc}
     *
     * <p>本模板的输入就一个：{@code a=1} 表示"点了一下"。
     * 换玩法时把这里换成你的输入（方向、坐标……），记得给默认值、别抛异常。
     */
    @Override
    public synchronized String sync(String id, Map<String, String> p) {
        Player me = players.get(id);
        if (me == null) {
            // 会话过期：客户端看到 you=null 会重新 join
            return "{\"you\":null,\"err\":\"会话已过期，请重新进入\"}";
        }
        me.lastSeen = System.currentTimeMillis();
        me.online = true;

        if (GameWorldPlugin.intOf(p, "a", 0) == 1) {
            total++;
            me.score++;
        }
        return snapshot(me);
    }

    private String snapshot(Player me) {
        StringBuilder b = new StringBuilder(512);
        b.append("{\"t\":").append(System.currentTimeMillis())
                .append(",\"you\":").append(Json.quote(me.id))
                .append(",\"total\":").append(total)
                .append(",\"myScore\":").append(me.score)
                .append(",\"online\":").append(playerCount())
                .append(",\"players\":[");

        boolean first = true;
        for (Player p : players.values()) {
            if (!p.online) {
                continue;
            }
            if (!first) {
                b.append(',');
            }
            first = false;
            b.append("{\"id\":").append(Json.quote(p.id))
                    .append(",\"n\":").append(Json.quote(p.name))
                    .append(",\"sc\":").append(p.score)
                    .append('}');
        }
        b.append("]}");
        return b.toString();
    }

    // =========================================================
    // 清洗（所有玩家输入都要过一遍）
    // =========================================================

    private static String sanitizeCid(String raw) {
        if (raw == null) {
            return null;
        }
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < raw.length() && b.length() < 32; i++) {
            char c = raw.charAt(i);
            if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
                    || (c >= '0' && c <= '9') || c == '-' || c == '_') {
                b.append(c);
            }
        }
        return b.length() == 0 ? null : b.toString();
    }

    private static String sanitizeName(String raw) {
        if (raw == null) {
            return "玩家";
        }
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
