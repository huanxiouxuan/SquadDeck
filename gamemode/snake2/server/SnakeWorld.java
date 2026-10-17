package lkserver;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 多人联机<b>贪吃蛇</b>的游戏世界——所有规则都在服务器端判定（服务端权威）。
 *
 * <p>与 {@link gamemode/snake 单机版} 的区别：那是纯客户端自娱自乐；这里是
 * 多人同屏竞技场——每条蛇的身体、果实、得分、击杀都在服务端，客户端只上报
 * 「想往哪转」和「想发表情」，拿回去的只有快照。
 *
 * <h3>规则</h3>
 * <ul>
 *   <li>地图 {@value #W}×{@value #H} 格，<b>全图可见</b>（没有战争迷雾，竞技场玩法）；</li>
 *   <li>每条蛇按自己的节奏前进：基础 {@value #BASE_STEP_MS} 毫秒一步，
 *       每吃一颗果实整体提速 {@value #STEP_SPEEDUP} 毫秒，最快
 *       {@value #MIN_STEP_MS} 毫秒——吃得越多跑得越快；</li>
 *   <li>场上常驻 {@value #FOOD_COUNT} 颗普通果实（+10 分）；每隔一段时间
 *       刷一颗<b>金色果实</b>（+50 分，{@value #GOLDEN_TTL} 毫秒内不吃消失）；</li>
 *   <li>死亡三种方式：撞墙、撞到任意蛇的身体（<b>自己的尾格让过</b>——
 *       经典规则；别人的尾格不让）、头对头相撞（双方同归于尽，不计击杀）；</li>
 *   <li>撞到别人身体 = 他的击杀；<b>尸体变果实</b>（身子每格掉一颗，
 *       全场果实封顶 {@value #MAX_FOODS} 颗，防止地图被埋了）；</li>
 *   <li>阵亡 {@value #RESPAWN_MS} 毫秒后在别处复活：身长/速度重置，
 *       分数/击杀/死亡保留；</li>
 *   <li><b>身份与离线</b>：同坦克世界——cid 标签级身份，刷新/重连拿回原来那条蛇；
 *       {@value #IDLE_MS} 毫秒没同步标记离线（不再移动、从快照里消失），
 *       {@value #TIMEOUT_MS} 毫秒才真正移除。</li>
 * </ul>
 *
 * <h3>同步方式</h3>
 * 与坦克一致：{@code POST /api/snake2/sync} 一次往返同时上交输入、拿回快照。
 * 快照是全量的（蛇身用 {@code [[x,y],...]} 紧凑表示），这个世界很小
 * （≤几十条蛇 × 每条约 15 格），全量比增量更简单也够小。
 *
 * <p><b>快照字段契约（客户端依赖，勿轻易改语义）</b>：
 * <ul>
 *   <li>{@code b} —— 蛇身格序列，{@code b[0]} 是<b>蛇头所在格</b>，
 *       后面依次是脖子、…、尾格；</li>
 *   <li>{@code d} —— 蛇的<b>飞行方向</b>（{@link #flyingDir}，即方向队列的队首），
 *       <b>不是</b>「最近一步走过的方向」{@code s.dir}。转向是玩家在两步之间下达的，
 *       若快照给出后者，客户端会照旧方向外推 → 转头瞬间头/脖撕裂。这是「转向飘移」
 *       的根因；</li>
 *   <li>{@code sf} —— 当前这一步已走的千分比（{@code (now-lastStepAt)*1000/stepMs}），
 *       {@code st} —— 当前每条蛇自己的步进毫秒数。客户端用它们把蛇头钉在
 *       「上一步已到达、下一步还没到」的确定区间里，配合<b>路径下标</b>参数化渲染
 *       （整条蛇按一个浮点路径下标取值，相邻两节的差值恒为 1 格 ⇒ 无论怎么转向、
 *       延迟多大都不会出现网格级裂缝）。</li>
 * </ul>
 *
 * <h3>并发模型</h3>
 * tick 线程（30Hz）与 HTTP 反应堆线程都会碰世界状态，所有对外方法
 * {@code synchronized}，临界区很短，这个规模足够。
 */
public final class SnakeWorld implements GameWorldPlugin {

    // ===================== 世界参数 =====================

    /** 世界宽（格）。 */
    public static final int W = 60;
    /** 世界高（格）。 */
    public static final int H = 40;
    /** 一格多少像素（与客户端画布一致：30×32=960、20×32=640）。 */
    public static final int CELL = 32;

    /** 世界 tick 间隔（毫秒）。30Hz：和坦克一致，转向/推进都用这个粒度。 */
    private static final int TICK_MS = 33;

    /** 初始步进间隔（毫秒）：一步走一格。 */
    private static final int BASE_STEP_MS = 150;
    /** 最快步进间隔（毫秒）。 */
    private static final int MIN_STEP_MS = 70;
    /** 每吃一颗普通果实，步进缩短这么多毫秒（吃到 = 变快）。 */
    private static final int STEP_SPEEDUP = 4;

    /** 场上常驻的普通果实数。 */
    private static final int FOOD_COUNT = 24;
    /** 全场果实上限（含尸体掉的），防止蛇太多把地图埋了。 */
    private static final int MAX_FOODS = 48;
    /** 金色果实存活时间（毫秒），过期消失。 */
    private static final long GOLDEN_TTL = 8000;
    /** 金色果实投放间隔（毫秒）。 */
    private static final long GOLDEN_INTERVAL = 15000;
    /** 开局多久后刷第一颗金色果实。 */
    private static final long GOLDEN_FIRST_DELAY = 10000;

    /** 初始身长（格）。 */
    private static final int START_LEN = 3;
    /** 阵亡后多久复活（毫秒）。 */
    private static final long RESPAWN_MS = 3000;
    /** 超过这么久没有任何同步就移除。 */
    private static final long TIMEOUT_MS = 30000;
    /** 离线阈值（毫秒）：超过先标记离线，不再移动、从别人快照里消失。 */
    private static final long IDLE_MS = 5000;

    /** 事件队列上限（断线重连的客户端可能落后，旧的直接丢）。 */
    private static final int EVENT_MAX = 128;

    /** 方向编码：0 上 / 1 右 / 2 下 / 3 左（客户端与服务器约定一致）。 */
    public static final int D_UP = 0, D_RIGHT = 1, D_DOWN = 2, D_LEFT = 3;
    private static final int[] DX = {0, 1, 0, -1};
    private static final int[] DY = {-1, 0, 1, 0};

    /** 玩家颜色（与坦克同一套调色板，前端按 id 取）。 */
    private static final String[] COLORS = {
            "#4ea1ff", "#ff6b6b", "#ffd166", "#06d6a0", "#c77dff",
            "#f72585", "#4cc9f0", "#b5e48c", "#ff9f1c", "#8ecae6"
    };

    // ===================== 实体 =====================

    /** 一条玩家蛇。 */
    static final class Snake {
        final String id;
        final String color;
        String name;
        String cid;

        Snake(String id, String color) {
            this.id = id;
            this.color = color;
        }

        /** 身体格，头在队首（{x,y} 格坐标）。 */
        final ArrayDeque<int[]> body = new ArrayDeque<>();
        /** 当前方向（0..3）。 */
        int dir = D_RIGHT;
        /** 待执行的转向队列（最多 2 个，快速连转不丢输入）。 */
        final ArrayDeque<Integer> dirQ = new ArrayDeque<>();

        int score;
        int kills;
        int deaths;
        /** 吃过的普通果实数（决定速度）。 */
        int eaten;
        /** 步进累加器（毫秒）。 */
        long stepAcc;
        /** 最近一次走步的时刻（毫秒）。快照的 sf 相位用它算——比 stepAcc
         *  精确（stepAcc 按 33ms tick 量化，客户端硬锚会抖）。 */
        long lastStepAt;

        boolean alive = true;
        long deadAt;

        boolean online = true;
        long lastSeen;
    }

    /** 一颗果实。golden 的 until 是过期时刻。 */
    static final class Food {
        int x, y;
        boolean golden;
        long until;
    }

    /** 世界事件（客户端放爆炸特效）。 */
    private static final class Ev {
        final long id;
        final String type;
        final int x, y;   // 像素坐标

        Ev(long id, String type, int x, int y) {
            this.id = id;
            this.type = type;
            this.x = x;
            this.y = y;
        }
    }

    // ===================== 状态 =====================

    private final Map<String, Snake> snakes = new LinkedHashMap<>();
    private final Map<String, String> cidToId = new HashMap<>();
    private final List<Food> foods = new ArrayList<>();
    private Food golden;
    private long nextGoldenAt;
    private final ArrayDeque<Ev> events = new ArrayDeque<>();
    private long evSeq;

    private final Random rnd = new Random();
    private final AtomicLong idSeq = new AtomicLong(1);
    private volatile ScheduledExecutorService ticker;

    public SnakeWorld() {
        for (int i = 0; i < FOOD_COUNT; i++) {
            spawnFood(false);
        }
        nextGoldenAt = System.currentTimeMillis() + GOLDEN_FIRST_DELAY;
    }

    // =========================================================
    // 生命周期
    // =========================================================

    public void start() {
        ScheduledExecutorService s = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "SnakeTick");
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
            System.err.println("[SnakeTick] 推进游戏时异常: " + e);
        }
    }

    // =========================================================
    // 玩家操作（HTTP 线程调用）
    // =========================================================

    /**
     * {@inheritDoc}
     *
     * <p>返回<b>完整 JSON</b>：id + 世界参数（宽/高/格子）。
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
                + ",\"cell\":" + CELL + "}";
    }

    /**
     * 加入的内部实现：分配 / 复用蛇。
     *
     * @param rawCid 客户端身份（浏览器标签级，存 sessionStorage）。同一个 cid
     *               在蛇还存在时<b>直接复用原来那条蛇</b>——刷新页面、断线重连
     *               都不会凭空多出一个号；对应蛇已被移除才发新号。
     * @return 玩家 id；<b>名字为空返回 null</b>（调用方据此拒绝加入）
     */
    private synchronized String joinInternal(String rawName, String rawCid) {
        String nm = sanitizeName(rawName);
        if (nm.isEmpty()) {
            return null;   // 没登记名字：不分配号、不生成蛇
        }
        String cid = sanitizeCid(rawCid);
        if (cid != null) {
            String oldId = cidToId.get(cid);
            if (oldId != null) {
                Snake old = snakes.get(oldId);
                if (old != null) {
                    // 同一个人回来了：复用旧号，刷新名字/在线状态，清掉残留转向
                    old.name = nm;
                    old.lastSeen = System.currentTimeMillis();
                    old.online = true;
                    old.dirQ.clear();
                    return old.id;
                }
                cidToId.remove(cid);   // 映射还在但蛇已不在（防御一手）
            }
        }
        String id = "s" + idSeq.getAndIncrement();
        Snake s = new Snake(id, COLORS[(int) (idSeq.get() % COLORS.length)]);
        s.name = nm;
        s.cid = cid;
        s.lastSeen = System.currentTimeMillis();
        s.online = true;
        spawnSnake(s);
        snakes.put(id, s);
        if (cid != null) {
            cidToId.put(cid, id);
        }
        return id;
    }

    public synchronized void leave(String id) {
        Snake s = snakes.remove(id);
        if (s != null && s.cid != null) {
            cidToId.remove(s.cid, s.id);
        }
    }

    /** 在线人数（离线未超时的 ghost 不算）。 */
    public synchronized int playerCount() {
        int n = 0;
        for (Snake s : snakes.values()) {
            if (s.online) {
                n++;
            }
        }
        return n;
    }

    /** 场上果实数（含金色，供 info 展示）。 */
    public synchronized int foodCount() {
        return foods.size() + (golden == null ? 0 : 1);
    }

    /** {@inheritDoc}（贪吃蛇：在线人数 + 地图尺寸 + 果实数）。 */
    @Override
    public synchronized String info() {
        return "{\"players\":" + playerCount()
                + ",\"w\":" + W
                + ",\"h\":" + H
                + ",\"cell\":" + CELL
                + ",\"foods\":" + foodCount() + "}";
    }

    /**
     * {@inheritDoc}
     *
     * <p>贪吃蛇的输入键：{@code d} 转向（0上/1右/2下/3左，-1 不变）、
     * {@code ev} 已收到的事件 id。缺省值与从前 GameApi 一致。
     */
    @Override
    public synchronized String sync(String id, Map<String, String> p) {
        return syncInternal(id,
                GameWorldPlugin.intOf(p, "d", -1),
                GameWorldPlugin.longOf(p, "ev", 0));
    }

    /**
     * 同步的内部实现：上交该玩家的转向意图，刷新在线时间，返回世界快照。
     *
     * @param dir      想转去的方向（{@value #D_UP}~{@value #D_LEFT}）；-1 = 不变。
     *                 非法值（掉头/重复/越界）在排队时就地过滤
     * @param clientEv 客户端已收到的最大事件 id，只回传更新的
     */
    private synchronized String syncInternal(String id, int dir, long clientEv) {
        Snake me = snakes.get(id);
        if (me != null) {
            if (dir >= D_UP && dir <= D_LEFT && me.dirQ.size() < 2) {
                int last = me.dirQ.isEmpty() ? me.dir : me.dirQ.peekLast();
                // 不能掉头（与最后一个意图相反）、同向不用重复排
                if (dir != last && dir != (last + 2) % 4) {
                    me.dirQ.offer(dir);
                }
            }
            me.lastSeen = System.currentTimeMillis();
            me.online = true;
        }
        return stateJson(id, clientEv);
    }

    // =========================================================
    // 状态快照
    // =========================================================

    private String stateJson(String pid, long clientEv) {
        long now = System.currentTimeMillis();
        StringBuilder b = new StringBuilder(4096);
        b.append("{\"t\":").append(now)
                .append(",\"w\":").append(W)
                .append(",\"h\":").append(H)
                .append(",\"cell\":").append(CELL)
                .append(",\"you\":").append(pid == null ? "null" : Json.quote(pid));

        Snake me = pid == null ? null : snakes.get(pid);

        // 本人 HUD：分数/击杀/死亡/复活倒计时/身长/当前步进
        b.append(",\"me\":");
        if (me == null) {
            b.append("null");
        } else {
            b.append("{\"score\":").append(me.score)
                    .append(",\"kills\":").append(me.kills)
                    .append(",\"deaths\":").append(me.deaths)
                    .append(",\"alive\":").append(me.alive)
                    .append(",\"respawnIn\":").append(
                            me.alive ? 0 : Math.max(0, RESPAWN_MS - (now - me.deadAt)))
                    .append(",\"len\":").append(me.body.size())
                    .append(",\"step\":").append(stepMs(me))
                    .append('}');
        }

        // 全部在线蛇（全图可见，没有迷雾；离线的对别人不存在，自己重连中除外）
        b.append(",\"snakes\":[");
        boolean first = true;
        for (Snake s : snakes.values()) {
            if (!s.online && s != me) {
                continue;
            }
            if (!first) {
                b.append(',');
            }
            first = false;
            b.append("{\"id\":").append(Json.quote(s.id))
                    .append(",\"n\":").append(Json.quote(s.name))
                    .append(",\"c\":").append(Json.quote(s.color))
                    .append(",\"d\":").append(flyingDir(s))
                    .append(",\"alive\":").append(s.alive)
                    .append(",\"k\":").append(s.kills)
                    .append(",\"sc\":").append(s.score)
                    .append(",\"st\":").append(stepMs(s))
                    // 步进相位（0~999，千分比）：按「距上次走步过了多久」
                    // 精确计算，客户端靠它把整条蛇渲染成连续滑动
                    .append(",\"sf\":").append(s.lastStepAt == 0 ? 0
                            : Math.max(0, Math.min(999,
                                    (now - s.lastStepAt) * 1000 / stepMs(s))))
                    .append(",\"b\":[");
            boolean fb = true;
            for (int[] c : s.body) {
                if (!fb) {
                    b.append(',');
                }
                fb = false;
                b.append('[').append(c[0]).append(',').append(c[1]).append(']');
            }
            b.append(']');
            b.append('}');
        }
        b.append(']');

        // 果实：普通 + 金色（金色带剩余毫秒，前端画倒计时环）
        b.append(",\"foods\":[");
        boolean ff = true;
        for (Food f : foods) {
            if (!ff) {
                b.append(',');
            }
            ff = false;
            b.append("{\"x\":").append(f.x).append(",\"y\":").append(f.y).append(",\"g\":0}");
        }
        if (golden != null) {
            if (!ff) {
                b.append(',');
            }
            b.append("{\"x\":").append(golden.x).append(",\"y\":").append(golden.y)
                    .append(",\"g\":1,\"ms\":").append(Math.max(0, golden.until - now)).append('}');
        }
        b.append(']');

        // 排行榜：在线的人按分数排序
        b.append(",\"board\":[");
        List<Snake> online = new ArrayList<>();
        for (Snake s : snakes.values()) {
            if (s.online) {
                online.add(s);
            }
        }
        online.sort(Comparator.comparingInt((Snake s) -> s.score).reversed());
        boolean fbr = true;
        for (Snake s : online) {
            if (!fbr) {
                b.append(',');
            }
            fbr = false;
            b.append("{\"id\":").append(Json.quote(s.id))
                    .append(",\"n\":").append(Json.quote(s.name))
                    .append(",\"c\":").append(Json.quote(s.color))
                    .append(",\"sc\":").append(s.score)
                    .append(",\"k\":").append(s.kills)
                    .append(",\"alive\":").append(s.alive)
                    .append('}');
        }
        b.append(']');

        // 事件（boom 等）：客户端没收到过的才发
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
                    .append(",\"x\":").append(e.x)
                    .append(",\"y\":").append(e.y)
                    .append('}');
        }
        b.append("]}");
        return b.toString();
    }

    // =========================================================
    // 游戏推进（tick 线程）
    // =========================================================

    /**
     * 下发方向：**当前这一步正在飞的方向**，而不是上一步走过的方向。
     *
     * <p>转向在服务端是「到格才生效」——排队的转向会在下一次走步时被
     * {@code poll()} 出来决定头格的落点。也就是说：队列一旦有值，蛇头此刻
     * 就已经在朝<b>新方向</b>滑了。快照若仍报旧方向，客户端会把头按旧方向
     * 外推，等下一次快照才发现落点变了——每转一次弯头身就撕开 1~2 格
     * （表现为「蛇身透明」「转向飘移」）。报「在飞的方向」后客户端的插值
     * 方向和真实飞行方向一致，转弯是顺着格子边界自然拐过去的。
     *
     * <p>连续转两次（队列有两格）时队列头已是下一步的方向，仍按它报——
     * 客户端在「多走了一格」的分支里会用 offset 平滑掉这一格的差。
     */
    private static int flyingDir(Snake s) {
        Integer q = s.dirQ.peekFirst();
        return q == null ? s.dir : q;
    }

    /** 当前步进间隔：吃得越多越快。 */
    private static int stepMs(Snake s) {
        return Math.max(MIN_STEP_MS, BASE_STEP_MS - s.eaten * STEP_SPEEDUP);
    }

    private void tick() {
        long now = System.currentTimeMillis();

        // 1) 离线 / 超时清理
        for (Iterator<Snake> it = snakes.values().iterator(); it.hasNext(); ) {
            Snake s = it.next();
            if (now - s.lastSeen > TIMEOUT_MS) {
                it.remove();
                if (s.cid != null) {
                    cidToId.remove(s.cid, s.id);
                }
            } else if (now - s.lastSeen > IDLE_MS) {
                s.online = false;
            }
        }

        // 2) 复活（阵亡够久的在线玩家）
        for (Snake s : snakes.values()) {
            if (!s.alive && s.online && now - s.deadAt >= RESPAWN_MS) {
                spawnSnake(s);
            }
        }

        // 3) 金色果实投放 / 过期
        if (golden == null && now >= nextGoldenAt) {
            Food g = spawnFood(true);
            if (g != null) {
                golden = g;
                g.until = now + GOLDEN_TTL;
            }
            nextGoldenAt = now + GOLDEN_INTERVAL;
        }
        if (golden != null && now >= golden.until) {
            golden = null;
        }

        // 4) 谁这一步该动
        List<Snake> movers = new ArrayList<>();
        for (Snake s : snakes.values()) {
            if (!s.alive || !s.online) {
                continue;
            }
            s.stepAcc += TICK_MS;
            while (s.stepAcc >= stepMs(s)) {
                s.stepAcc -= stepMs(s);
                s.lastStepAt = now;
                movers.add(s);
            }
        }
        if (movers.isEmpty()) {
            return;
        }

        // 5) 占用表：所有活蛇的当前身体格（本 tick 移动前的快照）
        Map<Integer, String> occ = new HashMap<>();
        for (Snake s : snakes.values()) {
            if (!s.alive) {
                continue;
            }
            for (int[] c : s.body) {
                occ.put(c[1] * W + c[0], s.id);
            }
        }

        // 6) 应用排队的转向，算出每条蛇这一步的意图头部
        Map<String, int[]> heads = new HashMap<>();
        for (Snake s : movers) {
            if (!s.dirQ.isEmpty()) {
                int nd = s.dirQ.poll();
                if (nd != (s.dir + 2) % 4) {   // 防御：绝不允许掉头
                    s.dir = nd;
                }
            }
            int[] h = s.body.peekFirst();
            heads.put(s.id, new int[]{h[0] + DX[s.dir], h[1] + DY[s.dir]});
        }

        // 7) 死亡判定
        Set<String> dead = new HashSet<>();
        Map<String, String> killer = new HashMap<>();
        for (Snake s : movers) {
            int[] nh = heads.get(s.id);
            // 撞墙
            if (nh[0] < 0 || nh[1] < 0 || nh[0] >= W || nh[1] >= H) {
                dead.add(s.id);
                continue;
            }
            // 头对头：双方同归于尽，不计击杀
            for (Snake o : movers) {
                if (o == s) {
                    continue;
                }
                int[] oh = heads.get(o.id);
                if (oh[0] == nh[0] && oh[1] == nh[1]) {
                    dead.add(s.id);
                    dead.add(o.id);
                }
            }
            if (dead.contains(s.id)) {
                continue;
            }
            // 撞身体
            String owner = occ.get(nh[1] * W + nh[0]);
            if (owner != null) {
                if (owner.equals(s.id)) {
                    // 自己：尾格这一步会让出来，让过（经典规则）
                    int[] tail = s.body.peekLast();
                    if (!(tail[0] == nh[0] && tail[1] == nh[1])) {
                        dead.add(s.id);
                    }
                } else {
                    dead.add(s.id);
                    killer.put(s.id, owner);
                }
            }
        }

        // 8) 应用：死的死，活的走
        for (Snake s : movers) {
            if (dead.contains(s.id)) {
                killSnake(s, killer.get(s.id), now);
                continue;
            }
            int[] nh = heads.get(s.id);
            s.body.addFirst(nh);
            Food f = foodAt(nh[0], nh[1]);
            if (f != null) {
                s.score += f.golden ? 50 : 10;
                s.eaten++;
                removeFood(f);
                if (!f.golden) {
                    spawnFood(false);   // 补一颗，保持场上果实数
                }
            } else {
                s.body.pollLast();
            }
        }
    }

    /** 击杀：记死亡/击杀、尸体掉成果实、发爆炸事件。 */
    private void killSnake(Snake s, String killerId, long now) {
        if (!s.alive) {
            return;
        }
        int[] h = s.body.peekFirst();
        int hx = h == null ? 0 : h[0];
        int hy = h == null ? 0 : h[1];

        s.alive = false;
        s.deadAt = now;
        s.deaths++;
        s.dirQ.clear();
        s.stepAcc = 0;

        if (killerId != null && !killerId.equals(s.id)) {
            Snake k = snakes.get(killerId);
            if (k != null) {
                k.kills++;
            }
        }

        // 尸体变果实（封顶，防地图被埋）
        if (foods.size() + s.body.size() <= MAX_FOODS) {
            for (int[] c : s.body) {
                Food f = new Food();
                f.x = c[0];
                f.y = c[1];
                foods.add(f);
            }
        }
        s.body.clear();
        addEvent("boom", hx * CELL + CELL / 2, hy * CELL + CELL / 2);
    }

    /** 重生：换个地方、3 节、随机方向；分数/击杀/死亡保留。 */
    private void spawnSnake(Snake s) {
        int[] spot = findSpawn();
        s.alive = true;
        s.eaten = 0;
        s.stepAcc = 0;
        s.dirQ.clear();
        s.dir = spot[2];
        s.body.clear();
        // 头在 spot，身体沿反方向铺 START_LEN 节
        for (int i = 0; i < START_LEN; i++) {
            s.body.addLast(new int[]{spot[0] - DX[s.dir] * i, spot[1] - DY[s.dir] * i});
        }
        s.lastStepAt = System.currentTimeMillis();
    }

    // =========================================================
    // 果实与格子
    // =========================================================

    /** 找一块能放下 START_LEN 节蛇的空地，返回 {x, y, dir}。 */
    private int[] findSpawn() {
        for (int attempt = 0; attempt < 400; attempt++) {
            int x = 2 + rnd.nextInt(W - 4);
            int y = 2 + rnd.nextInt(H - 4);
            int d = rnd.nextInt(4);
            boolean ok = true;
            for (int i = 0; i < START_LEN; i++) {
                if (cellOccupied(x - DX[d] * i, y - DY[d] * i)) {
                    ok = false;
                    break;
                }
            }
            if (ok) {
                return new int[]{x, y, d};
            }
        }
        return new int[]{W / 2, H / 2, D_RIGHT};   // 极端拥挤兜底
    }

    /** 格 (x,y) 是否被占用（蛇身/果实/金色/越界都算）。 */
    private boolean cellOccupied(int x, int y) {
        if (x < 0 || y < 0 || x >= W || y >= H) {
            return true;
        }
        for (Snake s : snakes.values()) {
            if (!s.alive) {
                continue;
            }
            for (int[] c : s.body) {
                if (c[0] == x && c[1] == y) {
                    return true;
                }
            }
        }
        for (Food f : foods) {
            if (f.x == x && f.y == y) {
                return true;
            }
        }
        return golden != null && golden.x == x && golden.y == y;
    }

    /** 在空格子里放一颗果实；金色由调用方设 until。 */
    private Food spawnFood(boolean golden) {
        for (int attempt = 0; attempt < 400; attempt++) {
            int x = rnd.nextInt(W);
            int y = rnd.nextInt(H);
            if (cellOccupied(x, y)) {
                continue;
            }
            Food f = new Food();
            f.x = x;
            f.y = y;
            f.golden = golden;
            if (!golden) {
                foods.add(f);
            }
            return f;
        }
        return null;
    }

    private Food foodAt(int x, int y) {
        for (Food f : foods) {
            if (f.x == x && f.y == y) {
                return f;
            }
        }
        if (golden != null && golden.x == x && golden.y == y) {
            return golden;
        }
        return null;
    }

    private void removeFood(Food f) {
        if (f.golden) {
            golden = null;
        } else {
            foods.remove(f);
        }
    }

    private void addEvent(String type, int px, int py) {
        events.addLast(new Ev(++evSeq, type, px, py));
        while (events.size() > EVENT_MAX) {
            events.pollFirst();
        }
    }

    // =========================================================
    // 清洗（规则与 GameWorld 一致：cid 只留 URL 安全字符，昵称去危险字符限 10 字）
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

    /** 昵称清洗：去掉控制字符与危险字符、限长。<b>不兜底</b>——空名字原样返回空串，
     *  由 joinInternal 拒绝加入（没登记名字不让玩）。 */
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
