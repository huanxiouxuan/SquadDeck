package lkserver;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 多人联机<b>坦克大战</b>的游戏世界——所有规则都在服务器端判定（服务端权威）。
 *
 * <p>与上一版（贪吃蛇）相比，核心变化：
 * <ul>
 *   <li>位置由「格子」变成「连续的像素坐标 + 朝向角」，tick 从 8Hz 提到 30Hz；</li>
 *   <li>地图上有一张<b>可破坏的障碍物网格</b>——每格 {@value #OBSTACLE_HP} 点耐久，
 *       被子弹打掉耐久后消失；整图密度约一半；</li>
 *   <li>坦克有 {@value #MAX_HP} 点血（前端画成 5 颗心）；</li>
 *   <li>坦克分成<b>车身</b>与<b>炮塔</b>两部分，都按 90°/秒 转（转 90° 要 1 秒）：
 *       车身追「移动方向」，炮塔追「鼠标瞄准」，开炮沿炮塔朝向；</li>
 *   <li><b>转身优先</b>：车身还没转到移动方向之前，坦克原地不动（只转身）；</li>
 *   <li><b>弹药</b>：弹匣 {@value #MAX_AMMO} 发，打一发少一发，补弹计时每开一炮重新起算、
 *       {@value #RELOAD_MS} 毫秒后补回 1 发，弹匣空了就打不出来；
 *       两发之间还要间隔 {@value #FIRE_COOLDOWN_MS} 毫秒；</li>
 *   <li><b>视野</b>：车身正前方左右各 45°、半径 10 格的扇形；<b>视野外的敌人不下发给客户端</b>；</li>
 *   <li><b>警戒</b>：<b>视野外</b>的敌人开火时（20 格内，即"听得见枪声"），
 *       下发一个「指向他的角度」，前端在车身外一格闪警告标志；</li>
 *   <li>子弹实体：生成、飞行（60 格/秒）、命中障碍/坦克、超时消失。</li>
 *   <li><b>身份与离线</b>：客户端带 cid（标签级身份）加入，同一个 cid 重连会
 *       拿回原来那辆车，不会多出号；{@value #IDLE_MS} 毫秒没同步先标记离线
 *       （别人看不见、打不中、不再动作），{@value #TIMEOUT_MS} 毫秒才真正移除。</li>
 * </ul>
 *
 * <h3>同步方式</h3>
 * 客户端把「按键 + 瞄准角 + 是否开火 + 已收到的最后事件 id」随状态请求一起发上来
 * （见 {@code POST /api/sync}），服务器把最新世界快照返回。障碍物整张地图只在下发一次，
 * 之后只回传「变化的格子」（按 revision 增量），避免每帧重传整张地图。
 *
 * <h3>并发模型</h3>
 * 世界状态会被两类线程访问：tick 线程（30Hz）与 HTTP 反应堆线程。
 * 所有对外方法都加 {@code synchronized}，临界区很短，这个规模足够。
 */
public final class GameWorld implements GameWorldPlugin {

    // ===================== 世界与物理参数 =====================

    /** 世界宽（格）。地图比一屏大得多，"坦克永远在画面中心"才有意义。 */
    public static final int W = 80;
    /** 世界高（格）。 */
    public static final int H = 60;

    /** 一格多少像素。 */
    public static final int CELL = 32;

    /** 一个 tick 的间隔（毫秒）。30Hz：射击游戏需要比 8Hz 细得多的推进粒度。 */
    private static final int TICK_MS = 33;

    /** 坦克碰撞半边长（像素），坦克按 2*half 见方的方块算。前端也用它来画。 */
    public static final int TANK_HALF = 13;

    /** 坦克移动速度（像素/秒）。 */
    private static final double TANK_SPEED = 165;

    /** 子弹速度：1 秒飞 60 格（60 × 32 = 1920 像素/秒）。 */
    private static final double BULLET_SPEED = 60 * (double) CELL;

    /** 车身转向角速度（弧度/秒）：90°/s —— 车身转 90° 正好用 1 秒。 */
    private static final double BODY_TURN_RATE = Math.PI / 2;

    /** 炮塔转向角速度（弧度/秒）：90°/s —— 炮塔转 90° 也要 1 秒。 */
    private static final double TURRET_TURN_RATE = Math.PI / 2;

    /** 子弹半径（像素）。 */
    private static final double BULLET_R = 5;

    /** 两发之间的最小间隔（毫秒）：1 秒一发。 */
    private static final long FIRE_COOLDOWN_MS = 1000;

    /** 弹匣容量：最多 5 发（前端画成左上角竖排的 5 格弹药条，一格一发）。 */
    public static final int MAX_AMMO = 5;

    /** 每打掉一发后，每隔这么久补回 1 发。 */
    private static final long RELOAD_MS = 2000;

    /** 视野半角（弧度）：车身正前方左右各 45°。 */
    private static final double VISION_HALF = Math.PI / 4;

    /** 视野半径（像素）：10 格。 */
    private static final double VISION_RANGE = 10 * (double) CELL;

    /** 警戒标志持续多久（毫秒）：敌人开火后这段时间内一直闪。 */
    private static final long WARN_MS = 1400;

    /**
     * 「听得见枪声」的半径（像素）：<b>视野外</b>但在这个距离内的敌人开火时，
     * 会给玩家一个方向警戒标志（20 格 = 视野半径的 2 倍）。
     * 再远的枪声不报警，免得地图另一头有人开炮也乱闪。
     */
    private static final double WARN_RANGE = 20 * (double) CELL;

    /** 子弹存活上限（毫秒），打不到东西也会自己消失。 */
    private static final long BULLET_LIFE_MS = 2600;

    /** 坦克初始/满血血量（前端显示为 5 颗心）。 */
    public static final int MAX_HP = 5;

    /** 障碍物每格的耐久；子弹伤害 1，所以打 10 次破坏。 */
    public static final int OBSTACLE_HP = 3;

    /** 子弹对障碍/坦克的伤害。 */
    private static final int BULLET_DAMAGE = 1;

    /** 阵亡后多久复活。 */
    private static final long RESPAWN_MS = 3000;

    /** 超过这么久没有任何同步就判定掉线并移除。 */
    private static final long TIMEOUT_MS = 30000;

    /**
     * 「离线」阈值（毫秒）：超过这么久没同步，先把这辆车标记为离线——
     * 从别人的视野/排行榜里消失、打不中（子弹直接穿过）、也不再移动和开火，
     * 但账号本身还留着；真正移除要等到 {@link #TIMEOUT_MS}。
     *
     * <p>分两层是为了「掉线一会儿又回来」（刷新页面、网络抖动、切后台）时不丢号，
     * 同时避免 ghost 在场上乱跑。配合 {@code /api/join} 的 cid 复用，
     * 断线重连拿回的是原来那辆车，不会凭空多出一个号。
     *
     * <p>取 5 秒而不是更短：客户端断线后最坏约 4 秒才完成重连
     * （3 次 miss × 300ms 重试 + 一个来回），高延迟链路（如热点跨网）下
     * 不能因为"sync 慢"就把人家判成隐身。
     */
    private static final long IDLE_MS = 5000;

    /** 障碍变更日志最多保留多少条，超了就让客户端重新拉整图。 */
    private static final int MAP_LOG_MAX = 4096;

    /** 事件队列最多保留多少条（客户端断线重连后可能落后，旧的直接丢）。 */
    private static final int EVENT_MAX = 128;

    /** 按键位：1 上 / 2 下 / 4 左 / 8 右。 */
    public static final int K_UP = 1;
    public static final int K_DOWN = 2;
    public static final int K_LEFT = 4;
    public static final int K_RIGHT = 8;

    private static final String[] COLORS = {
            "#4ea1ff", "#ff6b6b", "#ffd166", "#06d6a0", "#c77dff",
            "#f72585", "#4cc9f0", "#b5e48c", "#ff9f1c", "#8ecae6"
    };

    // ===================== 实体 =====================

    /** 一辆玩家坦克。 */
    public static final class Tank {
        final String id;
        String name;
        String color;

        double x;
        double y;

        /** 鼠标瞄准角（弧度）——炮塔要转过去的「目标方向」。 */
        double aim;
        /** 炮塔当前朝向（弧度），以 {@link #TURRET_TURN_RATE} 的角速度追 {@link #aim}。 */
        double turret;
        /** 车身当前朝向（弧度），以 {@link #BODY_TURN_RATE} 的角速度追「移动方向」。 */
        double body;

        int hp = MAX_HP;
        int kills;
        boolean alive = true;
        long deadAt;

        /** 当前按住的移动键位（位掩码）。 */
        int keys;
        /** 是否按住开火。 */
        boolean firing;
        long lastFire;

        /** 弹匣剩余弹药：打一发少一发，空了就打不出来。 */
        int ammo = MAX_AMMO;
        /** 下一发补弹的时刻（0 = 当前没有待补的）。 */
        long reloadAt;
        /**
         * 累计开炮次数 / 累计补弹次数（单调递增，永不清零）。
         * 快照里下发它们是有原因的：弹匣空着还按着开火时，"补弹 + 开火"会在
         * <b>同一个 tick</b> 内发生，客户端从 ammo 上看是 0→0，根本察觉不到，
         * 于是开炮/换弹音效都会哑掉。有了这两个计数器就不会漏。
         */
        int shots;
        int reloads;

        long lastSeen;

        /**
         * 客户端身份（{@code /api/join} 带来的 cid，浏览器标签级）。
         * 同一个 cid 再次加入时直接复用这辆车，而不是另发一个新号——
         * 否则断线重连会凭空多出一个号，旧的还会在场上跑 30 秒。
         */
        String cid;

        /** 是否在线：tick 按 {@code lastSeen} 与 {@link #IDLE_MS} 比较刷新。 */
        boolean online = true;

        Tank(String id, String name, String color) {
            this.id = id;
            this.name = name;
            this.color = color;
        }
    }

    /** 一颗子弹。 */
    private static final class Bullet {
        double x;
        double y;
        double vx;
        double vy;
        final String owner;
        long bornAt;

        Bullet(double x, double y, double vx, double vy, String owner, long bornAt) {
            this.x = x;
            this.y = y;
            this.vx = vx;
            this.vy = vy;
            this.owner = owner;
            this.bornAt = bornAt;
        }
    }

    /** 一次障碍物耐久变化，按 revision 记录，用于增量下发。 */
    private static final class Change {
        final long rev;
        final int x;
        final int y;
        final int hp;

        Change(long rev, int x, int y, int hp) {
            this.rev = rev;
            this.x = x;
            this.y = y;
            this.hp = hp;
        }
    }

    /**
     * 一条「世界事件」——用来让客户端播特效/音效（障碍被摧毁、坦克被击毁）。
     * 带自增 id，客户端把已收到的最大 id 回传，服务器只下发更新的那些。
     */
    private static final class Ev {
        final long id;
        final String type;
        final double x;
        final double y;

        Ev(long id, String type, double x, double y) {
            this.id = id;
            this.type = type;
            this.x = x;
            this.y = y;
        }
    }

    private final Map<String, Tank> tanks = new LinkedHashMap<>();
    /**
     * 客户端身份 cid → 坦克 id。用来把「同一个人」认出来：断线重连时
     * 同一个 cid 会拿回原来那辆车，不会变成两个号。
     */
    private final Map<String, String> cidToId = new LinkedHashMap<>();
    private final List<Bullet> bullets = new ArrayList<>();
    /** 障碍物耐久，按行主序存：index = y*W + x，0 表示空地。 */
    private final byte[] obs = new byte[W * H];

    private final ArrayDeque<Change> mapLog = new ArrayDeque<>();
    private long mapRev;
    private long mapBaseRev;

    private final ArrayDeque<Ev> events = new ArrayDeque<>();
    private long evSeq;

    private final Random rnd = new Random();
    private final AtomicLong idSeq = new AtomicLong(1);
    private volatile ScheduledExecutorService ticker;

    public GameWorld() {
        generateMap();
    }

    // =========================================================
    // 生命周期
    // =========================================================

    public void start() {
        ScheduledExecutorService s = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "GameTick");
            t.setDaemon(true);
            return t;
        });
        ticker = s;
        s.scheduleAtFixedRate(this::safeTick, TICK_MS, TICK_MS, TimeUnit.MILLISECONDS);
    }

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
            System.err.println("[GameTick] 推进游戏时异常: " + e);
        }
    }

    // =========================================================
    // 玩家操作（HTTP 线程调用）
    // =========================================================

    /**
     * {@inheritDoc}
     *
     * <p>返回<b>完整 JSON</b>：id + 世界参数（宽/高/格子/血量），客户端一次拿全，
     * 不用再问一次 info。
     */
    @Override
    public synchronized String join(String rawName, String rawCid) {
        String id = joinInternal(rawName, rawCid);
        if (id == null) {
            // 空名字（没在启动器登记）不让进——匿名没有身份，聊天/游戏全停用
            return "{\"err\":\"请先在启动器右上角「名字登记」里填个名字（≤10 字）\"}";
        }
        return "{\"id\":" + Json.quote(id)
                + ",\"w\":" + W
                + ",\"h\":" + H
                + ",\"cell\":" + CELL
                + ",\"hp\":" + MAX_HP + "}";
    }

    /**
     * 加入的内部实现：分配 / 复用玩家 id。
     *
     * @param rawCid 客户端身份（浏览器标签级，存 sessionStorage）。
     *               同一个 cid 在车还存在时<b>直接复用原来那辆车</b>——
     *               断线重连、刷新页面都不会凭空多出一个号；
     *               只有对应坦克已被移除（leave 或超时）才发新号。
     *               传 null/不合法时行为退回改版前（每次都是新号）。
     * @return 玩家 id；<b>名字为空返回 null</b>（调用方据此拒绝加入）
     */
    private synchronized String joinInternal(String rawName, String rawCid) {
        String nm = sanitizeName(rawName);
        if (nm.isEmpty()) {
            return null;   // 没登记名字：不分配号、不生成坦克
        }
        String cid = sanitizeCid(rawCid);
        if (cid != null) {
            String oldId = cidToId.get(cid);
            if (oldId != null) {
                Tank old = tanks.get(oldId);
                if (old != null) {
                    // 同一个人回来了：复用旧号，只刷新名字/在线状态/残留输入
                    old.name = nm;
                    old.lastSeen = System.currentTimeMillis();
                    old.online = true;
                    old.keys = 0;
                    old.firing = false;
                    return old.id;
                }
                // 映射还在但坦克已不在（leave/超时都会解绑，这里是防御一手）
                cidToId.remove(cid);
            }
        }
        String id = "p" + idSeq.getAndIncrement();
        Tank t = new Tank(id, nm, COLORS[(int) (idSeq.get() % COLORS.length)]);
        t.cid = cid;
        t.lastSeen = System.currentTimeMillis();
        t.online = true;
        spawn(t);
        tanks.put(id, t);
        if (cid != null) {
            cidToId.put(cid, id);
        }
        return id;
    }

    public synchronized void leave(String id) {
        Tank t = tanks.remove(id);
        if (t != null) {
            bullets.removeIf(b -> b.owner.equals(id));
            if (t.cid != null) {
                cidToId.remove(t.cid, id);
            }
        }
    }

    /** 在线人数（离线未超时的 ghost 不算）。 */
    public synchronized int playerCount() {
        int n = 0;
        for (Tank t : tanks.values()) {
            if (t.online) {
                n++;
            }
        }
        return n;
    }

    /** {@inheritDoc}（坦克：在线人数 + 地图尺寸）。 */
    @Override
    public synchronized String info() {
        return "{\"players\":" + playerCount()
                + ",\"w\":" + W
                + ",\"h\":" + H
                + ",\"cell\":" + CELL + "}";
    }

    /**
     * {@inheritDoc}
     *
     * <p>坦克的输入键：{@code k} 按键掩码、{@code a} 瞄准角、{@code f} 开火、
     * {@code rev} 客户端障碍 revision、{@code ev} 已收到的事件 id。
     * 缺省值与从前 GameApi 里的解析完全一致，老客户端行为不变。
     */
    @Override
    public synchronized String sync(String id, Map<String, String> p) {
        return syncInternal(id,
                GameWorldPlugin.intOf(p, "k", 0),
                GameWorldPlugin.doubleOf(p, "a", 0),
                GameWorldPlugin.boolOf(p, "f", false),
                GameWorldPlugin.longOf(p, "rev", -1),
                GameWorldPlugin.longOf(p, "ev", 0));
    }

    /**
     * 同步的内部实现：写入该玩家的输入（按键/瞄准/开火），刷新在线时间，返回世界快照。
     *
     * @param keys      按键位掩码（见 {@link #K_UP} 等）
     * @param aim       瞄准角（弧度）
     * @param fire      是否按住开火
     * @param clientRev 客户端已有的障碍 revision；小于 0 或已过期则整图下发
     * @param clientEv  客户端已收到的最大事件 id，只回传更新的
     */
    private synchronized String syncInternal(String id, int keys, double aim, boolean fire,
                                             long clientRev, long clientEv) {
        Tank me = tanks.get(id);
        if (me != null) {
            me.keys = keys & (K_UP | K_DOWN | K_LEFT | K_RIGHT);
            if (Double.isFinite(aim)) {
                me.aim = aim;
            }
            me.firing = fire;
            me.lastSeen = System.currentTimeMillis();
            me.online = true;
        }
        return stateJson(id, clientRev, clientEv);
    }

    /** 只刷新在线时间（给不跑 sync 的调用方留的兼容入口）。 */
    public synchronized void touch(String id) {
        Tank t = tanks.get(id);
        if (t != null) {
            t.lastSeen = System.currentTimeMillis();
        }
    }

    // =========================================================
    // 状态快照
    // =========================================================

    private String stateJson(String pid, long clientRev, long clientEv) {
        long now = System.currentTimeMillis();
        StringBuilder b = new StringBuilder(2048);
        b.append("{\"t\":").append(now)
                .append(",\"w\":").append(W)
                .append(",\"h\":").append(H)
                .append(",\"cell\":").append(CELL)
                .append(",\"tankHalf\":").append(TANK_HALF)
                .append(",\"obsHp\":").append(OBSTACLE_HP)
                .append(",\"vhalf\":").append(f3(VISION_HALF))
                .append(",\"vrange\":").append(f1(VISION_RANGE))
                .append(",\"you\":").append(pid == null ? "null" : Json.quote(pid));

        Tank me = pid == null ? null : tanks.get(pid);

        // 本人关键信息（相机、血量 HUD、弹药条、换弹进度用）
        b.append(",\"me\":");
        if (me == null) {
            b.append("null");
        } else {
            long reloadIn = 0;
            if (me.ammo < MAX_AMMO && me.reloadAt > 0) {
                reloadIn = Math.max(0, me.reloadAt - now);
            }
            b.append("{\"hp\":").append(me.hp)
                    .append(",\"alive\":").append(me.alive)
                    .append(",\"kills\":").append(me.kills)
                    .append(",\"ammo\":").append(me.ammo)
                    .append(",\"maxAmmo\":").append(MAX_AMMO)
                    .append(",\"reloadIn\":").append(reloadIn)
                    .append(",\"reloadMs\":").append(RELOAD_MS)
                    .append(",\"shots\":").append(me.shots)
                    .append(",\"reloads\":").append(me.reloads)
                    .append('}');
        }

        // 坦克：只下发「自己」+「视野扇形内」的敌人；视野外的敌人对客户端完全不可见
        b.append(",\"tanks\":[");
        boolean first = true;
        for (Tank t : tanks.values()) {
            // 离线的人对别人不存在（自己重连中除外，免得屏幕卡住）
            if (!t.online && t != me) {
                continue;
            }
            if (me != null && t != me && !visibleTo(me, t)) {
                continue;
            }
            if (!first) {
                b.append(',');
            }
            first = false;
            b.append("{\"id\":").append(Json.quote(t.id))
                    .append(",\"n\":").append(Json.quote(t.name))
                    .append(",\"c\":").append(Json.quote(t.color))
                    .append(",\"x\":").append(f1(t.x))
                    .append(",\"y\":").append(f1(t.y))
                    .append(",\"a\":").append(f3(t.turret))
                    .append(",\"ba\":").append(f3(t.body))
                    .append(",\"hp\":").append(t.hp)
                    .append(",\"alive\":").append(t.alive)
                    .append(",\"k\":").append(t.kills);
            b.append('}');
        }
        b.append(']');

        // 排行榜：在线的人都在（只有名字/击杀/血量，没有坐标），不受视野影响
        b.append(",\"board\":[");
        boolean fb = true;
        for (Tank t : tanks.values()) {
            if (!t.online) {
                continue;
            }
            if (!fb) {
                b.append(',');
            }
            fb = false;
            b.append("{\"id\":").append(Json.quote(t.id))
                    .append(",\"n\":").append(Json.quote(t.name))
                    .append(",\"c\":").append(Json.quote(t.color))
                    .append(",\"k\":").append(t.kills)
                    .append(",\"hp\":").append(t.hp)
                    .append(",\"alive\":").append(t.alive)
                    .append('}');
        }
        b.append(']');

        // 警戒：<b>视野外</b>（但在"听得见枪声"范围内）的敌人刚开过火
        //   → 给出「指向他的角度 + 距离 + 还要闪多久」，前端在车身外一格闪警告标志。
        //   视野内的敌人不用报——你自己看得见。
        b.append(",\"warns\":[");
        boolean fw = true;
        if (me != null) {
            for (Tank t : tanks.values()) {
                if (t == me || !t.alive || !t.online || t.lastFire <= 0 || visibleTo(me, t)) {
                    continue;
                }
                long left = WARN_MS - (now - t.lastFire);
                if (left <= 0) {
                    continue;
                }
                double dx = t.x - me.x;
                double dy = t.y - me.y;
                double d = Math.hypot(dx, dy);
                if (d > WARN_RANGE) {
                    continue;
                }
                if (!fw) {
                    b.append(',');
                }
                fw = false;
                b.append("{\"a\":").append(f3(Math.atan2(dy, dx)))
                        .append(",\"d\":").append(f1(d))
                        .append(",\"left\":").append(left)
                        .append('}');
            }
        }
        b.append(']');

        // 子弹：自己的全发，别人的只发视野内的
        b.append(",\"bullets\":[");
        boolean f2 = true;
        for (Bullet bu : bullets) {
            if (me != null && !bu.owner.equals(me.id) && !inVision(me, bu.x, bu.y)) {
                continue;
            }
            if (!f2) {
                b.append(',');
            }
            f2 = false;
            b.append("{\"x\":").append(f1(bu.x))
                    .append(",\"y\":").append(f1(bu.y))
                    .append(",\"vx\":").append(f1(bu.vx))
                    .append(",\"vy\":").append(f1(bu.vy))
                    .append('}');
        }
        b.append(']');

        // 事件：只要是客户端还没收到过的就发（前端再按视野过滤要不要出声/出特效）
        b.append(",\"events\":[");
        boolean fe = true;
        for (Ev e : events) {
            if (e.id <= clientEv) {
                continue;
            }
            if (!fe) {
                b.append(',');
            }
            fe = false;
            b.append("{\"id\":").append(e.id)
                    .append(",\"type\":").append(Json.quote(e.type))
                    .append(",\"x\":").append(f1(e.x))
                    .append(",\"y\":").append(f1(e.y))
                    .append('}');
        }
        b.append(']');

        // 障碍物：整图 或 增量
        b.append(",\"map\":");
        if (clientRev < 0 || clientRev < mapBaseRev) {
            b.append("{\"rev\":").append(mapRev).append(",\"full\":true,\"cells\":[");
            boolean f3 = true;
            for (int y = 0; y < H; y++) {
                for (int x = 0; x < W; x++) {
                    int hp = obs[y * W + x];
                    if (hp <= 0) {
                        continue;
                    }
                    if (!f3) {
                        b.append(',');
                    }
                    f3 = false;
                    b.append('[').append(x).append(',').append(y).append(',').append(hp).append(']');
                }
            }
            b.append("]}");
        } else {
            b.append("{\"rev\":").append(mapRev).append(",\"full\":false,\"ch\":[");
            boolean f4 = true;
            for (Change c : mapLog) {
                if (c.rev <= clientRev) {
                    continue;
                }
                if (!f4) {
                    b.append(',');
                }
                f4 = false;
                b.append('[').append(c.x).append(',').append(c.y).append(',').append(c.hp).append(']');
            }
            b.append("]}");
        }
        b.append('}');
        return b.toString();
    }

    /** 点 (x,y) 是否在 me 的视野扇形内（以<b>车身</b>正前方为轴，左右各 45°、半径 10 格）。 */
    private boolean inVision(Tank me, double x, double y) {
        double dx = x - me.x;
        double dy = y - me.y;
        if (dx * dx + dy * dy > VISION_RANGE * VISION_RANGE) {
            return false;
        }
        return Math.abs(normAngle(Math.atan2(dy, dx) - me.body)) <= VISION_HALF;
    }

    /** 敌人 other 是否在我视野内（阵亡的不显示）。 */
    private boolean visibleTo(Tank me, Tank other) {
        return other.alive && inVision(me, other.x, other.y);
    }

    /** 记一条世界事件（供客户端放爆炸特效/音效）。 */
    private void addEvent(String type, double x, double y) {
        events.addLast(new Ev(++evSeq, type, x, y));
        while (events.size() > EVENT_MAX) {
            events.pollFirst();
        }
    }

    // =========================================================
    // 游戏推进
    // =========================================================

    private void tick() {
        long now = System.currentTimeMillis();
        double dt = TICK_MS / 1000.0;

        synchronized (this) {
            // 1) 在线状态刷新 + 掉线清理
            Iterator<Map.Entry<String, Tank>> it = tanks.entrySet().iterator();
            while (it.hasNext()) {
                Tank t = it.next().getValue();
                t.online = now - t.lastSeen <= IDLE_MS;
                if (now - t.lastSeen > TIMEOUT_MS) {
                    it.remove();
                    if (t.cid != null) {
                        cidToId.remove(t.cid, t.id);
                    }
                }
            }
            // 2) 复活
            for (Tank t : tanks.values()) {
                if (!t.alive && now - t.deadAt >= RESPAWN_MS) {
                    respawn(t);
                }
            }
            // 3) 炮塔转向 + 换弹 + 坦克移动 + 开火（离线的不动也不开火）
            for (Tank t : tanks.values()) {
                if (!t.alive || !t.online) {
                    continue;
                }
                // 炮塔始终以有限角速度追鼠标方向——车停着也能转炮口
                t.turret = turnToward(t.turret, t.aim, TURRET_TURN_RATE * dt);

                // 换弹：每开一炮就把"补弹时刻"往后推 RELOAD_MS；到点补 1 发。
                // 因为补弹计时会被下一炮重置，所以连着打空 5 发后，确实要干等
                // 2 秒才补得上第 6 发——这正是"打完后无法射击"的由来。
                if (t.ammo < MAX_AMMO && t.reloadAt > 0 && now >= t.reloadAt) {
                    t.ammo++;
                    t.reloads++;
                    t.reloadAt = (t.ammo < MAX_AMMO) ? now + RELOAD_MS : 0;
                }
                if (t.ammo >= MAX_AMMO) {
                    t.reloadAt = 0;
                }

                moveTank(t, dt);

                // 开火三条件：按住了、还有弹、距上一发够久
                if (t.firing && t.ammo > 0 && now - t.lastFire >= FIRE_COOLDOWN_MS) {
                    fire(t, now);
                }
            }
            // 4) 子弹推进
            stepBullets(now, dt);
        }
    }

    private void moveTank(Tank t, double dt) {
        double dx = 0;
        double dy = 0;
        if ((t.keys & K_RIGHT) != 0) {
            dx += 1;
        }
        if ((t.keys & K_LEFT) != 0) {
            dx -= 1;
        }
        if ((t.keys & K_DOWN) != 0) {
            dy += 1;
        }
        if ((t.keys & K_UP) != 0) {
            dy -= 1;
        }
        if (dx == 0 && dy == 0) {
            return;
        }
        // 车身转向：朝「移动方向」以 BODY_TURN_RATE 慢慢转过去（90° 要 1 秒）
        double want = Math.atan2(dy, dx);
        t.body = turnToward(t.body, want, BODY_TURN_RATE * dt);
        // 「转身优先」：车头还没对准移动方向之前，坦克原地不动，先把身转过来
        if (Math.abs(normAngle(want - t.body)) > 1e-3) {
            return;
        }
        double len = Math.hypot(dx, dy);
        double step = TANK_SPEED * dt;
        dx = dx / len * step;
        dy = dy / len * step;

        // 分轴推进：撞上了就只停那一个轴，贴着障碍滑行，手感更好
        double nx = t.x + dx;
        if (!blocked(nx, t.y)) {
            t.x = nx;
        }
        double ny = t.y + dy;
        if (!blocked(t.x, ny)) {
            t.y = ny;
        }
    }

    /** 坦克（按半边长 TANK_HALF 的方块）放在 (cx,cy) 时是否撞障碍或出界。 */
    private boolean blocked(double cx, double cy) {
        double minX = cx - TANK_HALF;
        double maxX = cx + TANK_HALF;
        double minY = cy - TANK_HALF;
        double maxY = cy + TANK_HALF;
        if (minX < 0 || minY < 0 || maxX > W * (double) CELL || maxY > H * (double) CELL) {
            return true;
        }
        int x0 = (int) Math.floor(minX / CELL);
        int x1 = (int) Math.floor((maxX - 1e-6) / CELL);
        int y0 = (int) Math.floor(minY / CELL);
        int y1 = (int) Math.floor((maxY - 1e-6) / CELL);
        for (int y = y0; y <= y1; y++) {
            for (int x = x0; x <= x1; x++) {
                if (x < 0 || y < 0 || x >= W || y >= H) {
                    continue;
                }
                if (obs[y * W + x] > 0) {
                    return true;
                }
            }
        }
        return false;
    }

    private void fire(Tank t, long now) {
        t.lastFire = now;
        t.ammo = Math.max(0, t.ammo - 1);      // 打一发少一发
        t.shots++;
        t.reloadAt = now + RELOAD_MS;           // 补弹计时从这一炮重新起算
        // 炮弹沿「炮塔朝向」出膛——不是车身朝向，也不是鼠标的瞬时方向，
        // 这样炮口转到哪、子弹就从哪飞出去，和画面里看到的一致。
        double muzzle = TANK_HALF + 6;
        double bx = t.x + Math.cos(t.turret) * muzzle;
        double by = t.y + Math.sin(t.turret) * muzzle;
        int cx = (int) Math.floor(bx / CELL);
        int cy = (int) Math.floor(by / CELL);
        // 炮口正好顶在障碍上（贴着墙开火）：直接算命中那格，不再生成子弹。
        // 否则就会出现"贴着墙怎么打都打不掉"的怪现象。
        if (cx >= 0 && cy >= 0 && cx < W && cy < H && obs[cy * W + cx] > 0) {
            damageObstacle(cx, cy, BULLET_DAMAGE);
            return;
        }
        bullets.add(new Bullet(bx, by,
                Math.cos(t.turret) * BULLET_SPEED,
                Math.sin(t.turret) * BULLET_SPEED,
                t.id, now));
    }

    private void stepBullets(long now, double dt) {
        Iterator<Bullet> it = bullets.iterator();
        while (it.hasNext()) {
            Bullet b = it.next();
            if (now - b.bornAt > BULLET_LIFE_MS) {
                it.remove();
                continue;
            }
            // 子步进：子弹一 tick 走的路比障碍格还长，拆成若干小步防止"穿透"
            double total = Math.hypot(b.vx, b.vy) * dt;
            int steps = Math.max(1, (int) Math.ceil(total / 8.0));
            double sx = b.vx * dt / steps;
            double sy = b.vy * dt / steps;
            boolean dead = false;
            for (int i = 0; i < steps && !dead; i++) {
                b.x += sx;
                b.y += sy;
                dead = bulletCollide(b, now);
            }
            if (dead) {
                it.remove();
            }
        }
    }

    /** 子弹命中判定；返回 true 表示该子弹应当消失。 */
    private boolean bulletCollide(Bullet b, long now) {
        // 出界
        if (b.x < 0 || b.y < 0 || b.x >= W * (double) CELL || b.y >= H * (double) CELL) {
            return true;
        }
        // 撞障碍：命中格扣 1 点耐久
        int cx = (int) Math.floor(b.x / CELL);
        int cy = (int) Math.floor(b.y / CELL);
        if (cx >= 0 && cy >= 0 && cx < W && cy < H) {
            int idx = cy * W + cx;
            if (obs[idx] > 0) {
                damageObstacle(cx, cy, BULLET_DAMAGE);
                return true;
            }
        }
        // 撞坦克（离线的打不中，子弹直接穿过去）
        for (Tank t : tanks.values()) {
            if (!t.alive || !t.online || t.id.equals(b.owner)) {
                continue;
            }
            if (Math.abs(t.x - b.x) <= TANK_HALF + BULLET_R
                    && Math.abs(t.y - b.y) <= TANK_HALF + BULLET_R) {
                damageTank(t, b.owner, now);
                return true;
            }
        }
        return false;
    }

    private void damageObstacle(int x, int y, int dmg) {
        int idx = y * W + x;
        int hp = obs[idx];
        if (hp <= 0) {
            return;
        }
        int nhp = Math.max(0, hp - dmg);
        obs[idx] = (byte) nhp;
        recordChange(x, y, nhp);
        if (nhp == 0) {
            // 整格被打没了 → 记一条事件，客户端在视野内就会播爆炸音效/特效
            addEvent("obs", (x + 0.5) * CELL, (y + 0.5) * CELL);
        }
    }

    private void recordChange(int x, int y, int hp) {
        long rev = ++mapRev;
        mapLog.addLast(new Change(rev, x, y, hp));
        while (mapLog.size() > MAP_LOG_MAX) {
            Change evicted = mapLog.pollFirst();
            if (evicted != null) {
                mapBaseRev = Math.max(mapBaseRev, evicted.rev);
            }
        }
    }

    private void damageTank(Tank victim, String shooterId, long now) {
        if (!victim.alive) {
            return;
        }
        victim.hp -= BULLET_DAMAGE;
        if (victim.hp <= 0) {
            victim.hp = 0;
            victim.alive = false;
            victim.deadAt = now;
            victim.keys = 0;
            victim.firing = false;
            Tank shooter = tanks.get(shooterId);
            if (shooter != null) {
                shooter.kills++;
            }
            addEvent("kill", victim.x, victim.y);
        }
    }

    private void respawn(Tank t) {
        t.alive = true;
        t.hp = MAX_HP;
        t.keys = 0;
        t.firing = false;
        t.ammo = MAX_AMMO;
        t.reloadAt = 0;
        spawn(t);
    }

    // =========================================================
    // 地图
    // =========================================================

    /**
     * 生成一张<b>高密度</b>战场：障碍物约占全场一半。
     *
     * <p>做法是把地图切成 6×6 的「房间」，每个房间里放一个 4×4 的实心块，
     * 于是房间的右侧 2 列和下方 2 行天然留成走廊。再让块随机向走廊「长出」1 格——
     * 只会把 2 格宽的走廊压成 1 格宽（坦克 26px 宽、走廊 32px，仍能通行），
     * 因此<b>走廊永远是连通的</b>，不会出现被墙封死的死区。
     */
    private void generateMap() {
        final int P = 6;    // 房间边长（格）
        final int B = 4;    // 房间里实心块的边长（格）
        for (int by = 0; by < H; by += P) {
            for (int bx = 0; bx < W; bx += P) {
                if (rnd.nextDouble() < 0.06) {
                    continue;   // 少量空房间，制造开阔的遭遇区
                }
                for (int j = 0; j < B; j++) {
                    for (int i = 0; i < B; i++) {
                        if (rnd.nextDouble() < 0.97) {
                            fill(bx + i, by + j);
                        }
                    }
                }
                // 往右侧走廊"长"出 1 格（永远给右侧留出至少 1 格）
                for (int j = 0; j < B; j++) {
                    if (rnd.nextDouble() < 0.35) {
                        fill(bx + B, by + j);
                    }
                }
                // 往下侧走廊"长"出 1 格
                for (int i = 0; i < B; i++) {
                    if (rnd.nextDouble() < 0.35) {
                        fill(bx + i, by + B);
                    }
                }
            }
        }
        sealIsolatedPockets();
    }

    /**
     * 把「孤立的空地」补成墙：只保留最大的一块连通空地，其余零散空格全部填死。
     *
     * <p>为什么需要这一步：上面填实心块时留了 3% 的漏填概率（想做出粗糙的"碎砖"质感），
     * 于是偶尔会在 4×4 的实心块正中间戳出一个<b>被墙包死的单格空洞</b>。
     * 坦克进不去（只能沿上下左右走），玩家却会在墙上看到一个莫名其妙的一格缺口。
     * 补掉之后，走廊就是<b>严格 100% 连通</b>的——不会再有走不到的死区。
     */
    private void sealIsolatedPockets() {
        final int n = W * H;
        final int[] comp = new int[n];
        java.util.Arrays.fill(comp, -1);
        final int[] stack = new int[n];
        int id = 0, bestId = -1, bestSize = -1;
        for (int i = 0; i < n; i++) {
            if (comp[i] != -1 || obs[i] != 0) {
                continue;
            }
            int sp = 0, size = 0;
            stack[sp++] = i;
            comp[i] = id;
            while (sp > 0) {
                int cur = stack[--sp];
                size++;
                int cx = cur % W, cy = cur / W;
                if (cx > 0) {
                    int k = cur - 1;
                    if (comp[k] == -1 && obs[k] == 0) { comp[k] = id; stack[sp++] = k; }
                }
                if (cx < W - 1) {
                    int k = cur + 1;
                    if (comp[k] == -1 && obs[k] == 0) { comp[k] = id; stack[sp++] = k; }
                }
                if (cy > 0) {
                    int k = cur - W;
                    if (comp[k] == -1 && obs[k] == 0) { comp[k] = id; stack[sp++] = k; }
                }
                if (cy < H - 1) {
                    int k = cur + W;
                    if (comp[k] == -1 && obs[k] == 0) { comp[k] = id; stack[sp++] = k; }
                }
            }
            if (size > bestSize) { bestSize = size; bestId = id; }
            id++;
        }
        for (int i = 0; i < n; i++) {
            if (obs[i] == 0 && comp[i] != bestId) {
                obs[i] = (byte) OBSTACLE_HP;    // 够不着的空地 → 补成实心墙
            }
        }
    }

    /** 把 (x,y) 置为满耐久的障碍（越界忽略）。 */
    private void fill(int x, int y) {
        if (x >= 0 && y >= 0 && x < W && y < H) {
            obs[y * W + x] = (byte) OBSTACLE_HP;
        }
    }

    /** 找一块空地放坦克（不与障碍重叠、离别的坦克别太近）。 */
    private void spawn(Tank t) {
        t.aim = 0;
        t.turret = 0;
        t.body = 0;
        for (int attempt = 0; attempt < 400; attempt++) {
            double px = (2 + rnd.nextInt(W - 4) + 0.5) * CELL;
            double py = (2 + rnd.nextInt(H - 4) + 0.5) * CELL;
            if (blocked(px, py)) {
                continue;
            }
            boolean far = true;
            for (Tank o : tanks.values()) {
                if (o == t || !o.alive) {
                    continue;
                }
                if (Math.hypot(o.x - px, o.y - py) < 6 * CELL) {
                    far = false;
                    break;
                }
            }
            if (!far) {
                continue;
            }
            t.x = px;
            t.y = py;
            t.aim = 0;
            return;
        }
        // 极端拥挤兜底：从地图中心向外找第一个空点
        for (int r = 0; r < Math.max(W, H); r++) {
            for (int dy = -r; dy <= r; dy++) {
                for (int dx = -r; dx <= r; dx++) {
                    double px = (W / 2 + dx + 0.5) * CELL;
                    double py = (H / 2 + dy + 0.5) * CELL;
                    if (!blocked(px, py)) {
                        t.x = px;
                        t.y = py;
                        t.aim = 0;
                        return;
                    }
                }
            }
        }
        t.x = CELL * 1.5;
        t.y = CELL * 1.5;
        t.aim = 0;
    }

    // =========================================================
    // 小工具
    // =========================================================

    /** 一位小数，压缩 JSON 体积。 */
    private static String f1(double v) {
        if (!Double.isFinite(v)) {
            return "0";
        }
        return String.format(java.util.Locale.ROOT, "%.1f", v);
    }

    /** 三位小数（角度用）。 */
    private static String f3(double v) {
        if (!Double.isFinite(v)) {
            return "0";
        }
        return String.format(java.util.Locale.ROOT, "%.3f", v);
    }

    /** 把角度规整到 (-π, π]。 */
    private static double normAngle(double a) {
        while (a > Math.PI) {
            a -= Math.PI * 2;
        }
        while (a <= -Math.PI) {
            a += Math.PI * 2;
        }
        return a;
    }

    /**
     * 以限定的最大角步长把 {@code cur} 转向 {@code target}（走最短的一边）。
     * 转不过去就只走 {@code maxDelta}，用来实现"转 90° 要固定时长"的手感。
     */
    private static double turnToward(double cur, double target, double maxDelta) {
        double d = normAngle(target - cur);
        if (Math.abs(d) <= maxDelta) {
            return normAngle(target);
        }
        return normAngle(cur + Math.signum(d) * maxDelta);
    }

    /**
     * 客户端身份清洗：只保留 {@code [A-Za-z0-9_-]}、最长 32 字符，
     * 不合格就返回 null（当作没传）——每次都发新号，行为退回改版之前。
     */
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

    /** 昵称清洗：去掉控制字符与危险字符、限长（与启动器「名字登记」栏的 10 字上限一致）。
     *  <b>不兜底</b>——空名字原样返回空串，由 joinInternal 拒绝加入。 */
    private static String sanitizeName(String raw) {
        if (raw == null) {
            return "";
        }
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < raw.length() && b.length() < 10; i++) {
            char c = raw.charAt(i);
            if (c >= 0x20 && c != '<' && c != '>' && c != '&' && c != '"' && c != '\\') {
                b.append(c);
            }
        }
        return b.toString().trim();
    }
}
