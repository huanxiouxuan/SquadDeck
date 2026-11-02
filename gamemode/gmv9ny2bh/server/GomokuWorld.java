package lkserver;

import java.util.ArrayList;
import java.util.HashMap;
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
 * 五子棋对弈世界——服务端权威的<b>房间制</b>两人棋局。
 *
 * <p>与 {@link SnakeWorld}（大乱斗竞技场）不同，这里是「开房对弈」模型：
 * <ul>
 *   <li>玩家进游戏后先在<b>大厅</b>，可以<b>创建房间</b>（拿到一个 4 位房间码）
 *       或<b>用房间码加入</b>别人的房间；</li>
 *   <li>每个房间<b>只坐两人</b>（先到坐黑先手、后到坐白后手），第三个人
 *       加入会被拒绝（{@code 房间已满}）——不会变成围观局；</li>
 *   <li>房间可以<b>同时开很多个</b>，互相独立、互不干扰；</li>
 *   <li>全部判定在服务端：谁该走、落子合不合法、五连胜负，都在这里算，
 *       客户端只是「上报落点 + 拿回棋盘」。</li>
 * </ul>
 *
 * <h3>怎么走接口（房间码从哪来）</h3>
 * 加入/建房都不改通用接口签名——{@code join(name, cid)} 只负责建立「我是谁」的
 * 会话；房间相关的动作全部走 {@code sync} 的自定义参数 {@code act}：
 * <ul>
 *   <li>{@code act=create} —— 创建房间，返回房间码（自己坐黑）；</li>
 *   <li>{@code act=join&room=ABCD} —— 用房间码加入（坐白）；</li>
 *   <li>{@code act=place&x=7&y=7} —— 落子（只认轮到你时）；</li>
 *   <li>{@code act=resign} —— 认输；</li>
 *   <li>{@code act=again} —— 对局结束后双方再来一局（交换先后手）；</li>
 *   <li>{@code act=leave} —— 退出房间回大厅；</li>
 *   <li>不带 act（或空）—— 只拉一次房间/大厅状态。</li>
 * </ul>
 * 响应里带 {@code room}（在房间里时的完整局面）或 {@code null}（在大厅），
 * 以及 {@code err}（本次操作被拒绝的原因，如「房间已满」「还没轮到你」）。
 *
 * <p>约定与其它世界一致：{@code join}/{@code info} 返回完整 JSON；所有对外方法
 * {@code synchronized}；{@code stop()} 只停 tick，不清数据。
 */
public final class GomokuWorld implements GameWorldPlugin {

    // ===================== 世界参数 =====================

    /** 棋盘线数：15 路（15×15 交点）。 */
    public static final int BOARD = 15;

    /** 房间码长度。 */
    private static final int CODE_LEN = 4;
    /** 房间码字符集：去掉了容易看错的 0/O/1/I。 */
    private static final String CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    /** tick 间隔（毫秒）。下棋是回合制，低频即可——只用来做清理。 */
    private static final int TICK_MS = 1000;
    /** 离线阈值：超过这么久没同步先标记离线（对手能看到「掉线」）。 */
    private static final long IDLE_MS = 6000;
    /** 超时阈值：超过这么久没同步就把玩家请出去（腾出座位）。 */
    private static final long TIMEOUT_MS = 90000;
    /** 空房间（两人都走了）保留这么久后删除。 */
    private static final long EMPTY_ROOM_TTL_MS = 120000;

    /**
     * AI 每步的思考时间上限（毫秒）。实际耗时通常远低于它——迭代加深一旦算出
     * 必胜/必败就直接收手，中局一般几十毫秒，开局甚至只要几毫秒。
     *
     * <p>为什么卡在 250ms 而不是给足 1 秒：{@code GomokuWorld} 的对外方法全部
     * {@code synchronized}，AI 思考期间会把整个世界锁住（别的房间也一起等）。
     * 250ms 是"棋力够用 + 不让人明显感到卡"的折中；正解是把思考挪到锁外做，
     * 见 README「已知限制」。
     */
    private static final long AI_BUDGET_MS = 250;
    /** AI 最大搜索层数。深到 8 层收益很小，却容易把预算吃满。 */
    private static final int AI_MAX_DEPTH = 6;
    /**
     * AI 落子的固定延迟（毫秒）。
     *
     * <p>它算得只要几十毫秒，**但立刻落子会让人措手不及**——没有"对手在思考"的节奏感，
     * 看起来像本地脚本而不是一个对手。所以算完不马上放，而是排到 800ms 后再执行；
     * 配合客户端 500ms 的轮询，玩家实际感知到的应手间隔约 0.8~1.3 秒。
     *
     * <p>关键是**不能在 HTTP 请求里 sleep**：那 800ms 会连同 {@code synchronized}
     * 一起把整个世界锁住。这里排的是独立调度线程的任务，人类那次请求立刻返回。
     */
    private static final long AI_DELAY_MS = 800;

    /** 四个方向（dx,dy）：横 / 竖 / 正斜 / 反斜。 */
    private static final int[][] DIRS = {{1, 0}, {0, 1}, {1, 1}, {1, -1}};

    // ===================== 实体 =====================

    /** 一个玩家（浏览器标签级身份，cid 复用）。 */
    static final class Player {
        final String id;
        String name;
        String cid;
        /** 所在房间码；{@code null} = 还在大厅。 */
        String room;
        /** 座位：1 = 黑（先手），2 = 白（后手），0 = 未入座。 */
        int seat;
        boolean online = true;
        /**
         * 是不是 AI 棋手。
         *
         * <p>AI 走的是<b>和真人完全一样的通道</b>（同一个 {@link Room} 座位、同一个
         * {@link #place} 判定、同一套胜负检查），只是它的落点由
         * {@code GomokuAI.think()} 算出来而不是由浏览器上报。这样：AI 不需要任何
         * 特殊协议，客户端也分不出"对面是人还是 AI"，联机路径一行没改。
         */
        boolean bot;
        long lastSeen;

        Player(String id) {
            this.id = id;
        }
    }

    /** 一个棋局房间。 */
    static final class Room {
        final String code;
        /** 黑方（先手）/ 白方（后手），可以为 null（等人）。 */
        Player black;
        Player white;
        /** 棋盘：{@code cells[y][x]}，0 空 / 1 黑 / 2 白。 */
        final int[][] cells = new int[BOARD][BOARD];
        /** 该谁走：1 黑 / 2 白。 */
        int turn = 1;
        /** 胜方：0 未定 / 1 黑 / 2 白 / 3 平局。 */
        int winner;
        /** 最近一手 {x,y}，没有则 null。 */
        int[] last;
        /** 获胜连线（客户端高亮），没有则 null。 */
        List<int[]> win;
        /** 已落子数。 */
        int moves;
        long createdAt;
        long lastActive;

        // ---- AI 相关（r.ai = false 时全部无效）----
        /** 本房间是不是"人机对战"。 */
        boolean ai;
        /** 最近一次 AI 思考的结果，直接透给前端展示。 */
        int aiMs;
        int aiNodes;
        int aiDepth;
        int aiScore;
        /** AI 已经走过的步数（前端用来显示"AI 已应手 N 次"）。 */
        int aiMoves;
        /** 是否已经排了一次"稍后落子"的任务——防止 tick 反复排队。 */
        boolean aiPending;

        Room(String code) {
            this.code = code;
            long now = System.currentTimeMillis();
            this.createdAt = now;
            this.lastActive = now;
        }
    }

    // ===================== 状态 =====================

    private final Map<String, Player> players = new LinkedHashMap<>();
    private final Map<String, String> cidToId = new HashMap<>();
    private final Map<String, Room> rooms = new LinkedHashMap<>();
    private final Random rnd = new Random();
    private final AtomicLong idSeq = new AtomicLong(1);
    private volatile ScheduledExecutorService ticker;
    /** AI 落子的调度线程：让"思考 → 落子"之间隔一拍，又不占用 HTTP 请求线程。 */
    private volatile ScheduledExecutorService aiPool;

    // =========================================================
    // 生命周期
    // =========================================================

    @Override
    public void start() {
        ScheduledExecutorService s = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "GomokuTick");
            t.setDaemon(true);
            return t;
        });
        ticker = s;
        s.scheduleAtFixedRate(this::safeTick, TICK_MS, TICK_MS, TimeUnit.MILLISECONDS);

        ScheduledExecutorService a = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "GomokuAI");
            t.setDaemon(true);
            return t;
        });
        aiPool = a;
    }

    @Override
    public void stop() {
        ScheduledExecutorService s = ticker;
        if (s != null) {
            s.shutdownNow();
        }
        ScheduledExecutorService a = aiPool;
        if (a != null) {
            a.shutdownNow();
        }
    }

    private void safeTick() {
        try {
            tick();
        } catch (RuntimeException e) {
            System.err.println("[GomokuTick] 清理时异常: " + e);
        }
    }

    /** 低频维护：标记离线、请走超时玩家、删掉空房间。 */
    private synchronized void tick() {
        long now = System.currentTimeMillis();

        // 1) 玩家：超时请走 / 空闲标离线
        for (Iterator<Player> it = players.values().iterator(); it.hasNext(); ) {
            Player p = it.next();
            if (now - p.lastSeen > TIMEOUT_MS) {
                it.remove();
                if (p.cid != null) {
                    cidToId.remove(p.cid, p.id);
                }
                vacate(p);
            } else if (now - p.lastSeen > IDLE_MS) {
                p.online = false;
            }
        }

        // 2) 空房间：两人都没了就删
        for (Iterator<Room> it = rooms.values().iterator(); it.hasNext(); ) {
            Room r = it.next();
            if (r.black == null && r.white == null
                    && now - r.lastActive > EMPTY_ROOM_TTL_MS) {
                it.remove();
            }
        }

        // 3) 兜底：人机对战里若轮到 AI 却没排任务（异常漏掉 / 刚变成先手），这里补一次，
        //    避免玩家盯着一个不动的棋盘。正常情况下 place/again 已经排过了，不会重复。
        for (Room r : rooms.values()) {
            if (r.ai) {
                scheduleBotTurn(r);
            }
        }
    }

    /**
     * 排一次"AI 稍后落子"的任务。
     *
     * <p>三条约束：
     * <ul>
     *   <li><b>只排一次</b>——{@code aiPending} 挡住 tick 的重复排队；</li>
     *   <li><b>不占请求线程</b>——延迟在独立调度线程里等，人类的 HTTP 请求立刻返回，
     *       否则那 800ms 会连着 {@code synchronized} 把整个世界锁住；</li>
     *   <li><b>执行时重新校验</b>——800ms 里人可能已经退出、认输或房间被清掉，
     *       所以任务体要在锁内重新调 {@link #botTurn}，它会自己判断"还该不该走"。</li>
     * </ul>
     */
    private void scheduleBotTurn(Room r) {
        if (!r.ai || r.aiPending || r.winner != 0
                || r.black == null || r.white == null) {
            return;
        }
        Player bot = r.black.bot ? r.black : (r.white.bot ? r.white : null);
        if (bot == null || r.turn != bot.seat) {
            return;
        }
        ScheduledExecutorService a = aiPool;
        if (a == null) {
            // 世界还没 start（理论上不会）：退回同步落子，至少不能卡住房间
            botTurn(r, System.currentTimeMillis());
            return;
        }
        r.aiPending = true;
        try {
            a.schedule(() -> {
                synchronized (GomokuWorld.this) {
                    r.aiPending = false;
                    botTurn(r, System.currentTimeMillis());
                }
            }, AI_DELAY_MS, TimeUnit.MILLISECONDS);
        } catch (RuntimeException e) {
            // 调度器已关闭（世界 stop 中）：别让房间永远 pending
            r.aiPending = false;
        }
    }

    // =========================================================
    // 玩家会话（HTTP 线程调用）
    // =========================================================

    /**
     * {@inheritDoc}
     *
     * <p>返回 id + 棋盘大小。同 cid 在玩家还在时复用旧号——刷新页面/断线重连
     * 不会凭空多出一个人，而且<b>原来的房间、座位都还在</b>。
     */
    @Override
    public synchronized String join(String rawName, String rawCid) {
        String id = joinInternal(rawName, rawCid);
        if (id == null) {
            // 空名字（没在启动器登记）不让进——匿名没有身份，聊天/游戏全停用
            return "{\"err\":\"请先在启动器右上角「名字登记」里填个名字（≤10 字）\"}";
        }
        return "{\"id\":" + Json.quote(id)
                + ",\"board\":" + BOARD + "}";
    }

    private synchronized String joinInternal(String rawName, String rawCid) {
        String nm = sanitizeName(rawName);
        if (nm.isEmpty()) {
            return null;   // 没登记名字：不分配号、不建玩家
        }
        String cid = sanitizeCid(rawCid);
        if (cid != null) {
            String oldId = cidToId.get(cid);
            if (oldId != null) {
                Player old = players.get(oldId);
                if (old != null) {
                    old.name = nm;
                    old.lastSeen = System.currentTimeMillis();
                    old.online = true;
                    return old.id;
                }
                cidToId.remove(cid);
            }
        }
        String id = "p" + idSeq.getAndIncrement();
        Player p = new Player(id);
        p.name = nm;
        p.cid = cid;
        p.lastSeen = System.currentTimeMillis();
        players.put(id, p);
        if (cid != null) {
            cidToId.put(cid, id);
        }
        return id;
    }

    /** 主动退出：离开房间 + 移除玩家。 */
    @Override
    public synchronized void leave(String id) {
        Player p = players.remove(id);
        if (p != null) {
            if (p.cid != null) {
                cidToId.remove(p.cid, p.id);
            }
            vacate(p);
        }
    }

    /** 在线人数。 */
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

    /** {@inheritDoc}（五子棋：在线人数 + 房间数 + 棋盘大小）。 */
    @Override
    public synchronized String info() {
        int seats = 0;
        for (Room r : rooms.values()) {
            if (r.black != null) {
                seats++;
            }
            if (r.white != null) {
                seats++;
            }
        }
        return "{\"players\":" + playerCount()
                + ",\"rooms\":" + rooms.size()
                + ",\"seats\":" + seats
                + ",\"board\":" + BOARD + "}";
    }

    // =========================================================
    // 同步（一次往返：上交动作 + 拿回状态）
    // =========================================================

    @Override
    public synchronized String sync(String id, Map<String, String> p) {
        return syncInternal(id, p == null ? null : p.get("act"), p);
    }

    private synchronized String syncInternal(String id, String act, Map<String, String> p) {
        long now = System.currentTimeMillis();
        Player me = players.get(id);
        if (me == null) {
            // 会话过期（超时被请走 / 服务器重启）：客户端据此重新 join
            return "{\"t\":" + now + ",\"you\":null,\"err\":"
                    + Json.quote("会话已过期，请重新进入") + "}";
        }
        me.lastSeen = now;
        me.online = true;

        String err = null;
        if (act != null && !act.isEmpty()) {
            switch (act) {
                case "create":
                    err = createRoom(me, now, p != null && "1".equals(p.get("ai")));
                    break;
                case "join":
                    err = joinRoom(me, p == null ? null : p.get("room"), now);
                    break;
                case "place":
                    err = place(me, GameWorldPlugin.intOf(p, "x", -1),
                            GameWorldPlugin.intOf(p, "y", -1), now);
                    break;
                case "resign":
                    err = resign(me, now);
                    break;
                case "again":
                    err = again(me, now);
                    break;
                case "leave":
                    err = leaveRoom(me);
                    break;
                default:
                    err = "未知操作: " + act;
                    break;
            }
        }
        return stateJson(me, err);
    }

    // =========================================================
    // 房间操作（都在 synchronized 里，返回值 = 错误信息或 null）
    // =========================================================

    /**
     * 创建房间：建房者坐黑，等对手入座。
     *
     * @param vsAi {@code true} 表示人机对战——立刻把一个 AI 棋手塞到白座上，
     *             于是房间一建好就是"两人齐、可以下"，不用等谁加入
     */
    private String createRoom(Player me, long now, boolean vsAi) {
        if (me.room != null) {
            return "你已经在房间里了（房间码 " + me.room + "），先退出再创建";
        }
        String code = newCode();
        if (code == null) {
            return "房间太多啦，稍后再试";
        }
        Room r = new Room(code);
        r.black = me;
        me.room = code;
        me.seat = 1;
        rooms.put(code, r);
        if (vsAi) {
            Player bot = newBot("AI 棋手");
            bot.room = code;
            bot.seat = 2;
            r.white = bot;
            r.ai = true;
            r.lastActive = now;
        }
        return null;
    }

    /** 造一个 AI 棋手。它<b>不进 players 表</b>——不受超时清理影响，也不计入在线人数。 */
    private Player newBot(String name) {
        Player p = new Player("bot" + idSeq.getAndIncrement());
        p.name = name;
        p.bot = true;
        p.online = true;
        p.lastSeen = Long.MAX_VALUE;   // 永不过期
        return p;
    }

    /** 用房间码加入：坐白（空位）。 */
    private String joinRoom(Player me, String rawCode, long now) {
        String code = normalizeCode(rawCode);
        if (code == null) {
            return "请输入 4 位房间码";
        }
        Room r = rooms.get(code);
        if (r == null) {
            return "房间不存在（码 " + code + "）";
        }
        if (me.room != null) {
            if (me.room.equals(code)) {
                return null;   // 幂等：已经在里面了
            }
            return "你已经在别的房间里了（房间码 " + me.room + "）";
        }
        // 限定两人：两个座位都有人就满员
        if (r.black != null && r.white != null) {
            return "房间已满（限定两人一局）";
        }
        if (r.black == null) {
            r.black = me;
            me.seat = 1;
        } else {
            r.white = me;
            me.seat = 2;
        }
        me.room = code;
        r.lastActive = now;
        // 两人到齐、且还没开下：开新局（重置棋盘，黑先）
        if (r.black != null && r.white != null && r.winner == 0 && r.moves == 0) {
            r.turn = 1;
        }
        return null;
    }

    /** 落子。 */
    private String place(Player me, int x, int y, long now) {
        Room r = currentRoom(me);
        if (r == null) {
            return "你还没进房间";
        }
        if (r.winner != 0) {
            return "本局已结束，点「再来一局」";
        }
        if (r.black == null || r.white == null) {
            return "还在等对手加入";
        }
        if (me.seat != r.turn) {
            return r.turn == 1 ? "现在轮到黑方" : "现在轮到白方";
        }
        if (x < 0 || y < 0 || x >= BOARD || y >= BOARD) {
            return "落点超出棋盘";
        }
        if (r.cells[y][x] != 0) {
            return "这里已经有子了";
        }
        putStone(r, x, y, me.seat, now);
        // 人机对战：轮到 AI 就排一次"稍后落子"，让对手看起来在想棋
        scheduleBotTurn(r);
        return null;
    }

    /** 真正把一颗子放上去，并判定胜负 / 换手。人类走子和 AI 走子共用这一段。 */
    private void putStone(Room r, int x, int y, int seat, long now) {
        r.cells[y][x] = seat;
        r.last = new int[]{x, y};
        r.moves++;
        r.lastActive = now;

        List<int[]> line = checkWin(r, x, y, seat);
        if (line != null) {
            r.winner = seat;
            r.win = line;
        } else if (r.moves >= BOARD * BOARD) {
            r.winner = 3;   // 下满 = 平局
        } else {
            r.turn = 3 - r.turn;
        }
    }

    /**
     * 让 AI 走一步（立刻执行）。
     *
     * <p>它只会被 {@link #scheduleBotTurn} 排的延迟任务调用，或者在调度器没起来时兜底调用——
     * 也就是说 AI 的落子<b>永远不会挡在人类的请求里</b>。进来先重新校验一遍
     * "还是不是它的回合"，因为排队这 800ms 里局面可能已经变了。
     */
    private void botTurn(Room r, long now) {
        if (!r.ai || r.winner != 0 || r.black == null || r.white == null) {
            return;
        }
        Player bot = r.black.bot ? r.black : (r.white.bot ? r.white : null);
        if (bot == null || r.turn != bot.seat) {
            return;
        }
        GomokuAI.Move m = GomokuAI.think(r.cells, bot.seat, AI_BUDGET_MS, AI_MAX_DEPTH);
        int x = m.x;
        int y = m.y;
        if (x < 0 || y < 0 || x >= BOARD || y >= BOARD || r.cells[y][x] != 0) {
            // 兜底：AI 给的点不可用（理论上不会发生）——退化到第一个空位，绝不能让房间卡住
            boolean done = false;
            for (int yy = 0; yy < BOARD && !done; yy++) {
                for (int xx = 0; xx < BOARD && !done; xx++) {
                    if (r.cells[yy][xx] == 0) {
                        x = xx;
                        y = yy;
                        done = true;
                    }
                }
            }
            if (!done) {
                return;
            }
        }
        r.aiMs = (int) m.ms;
        r.aiNodes = (int) Math.min(Integer.MAX_VALUE, m.nodes);
        r.aiDepth = m.depth;
        r.aiScore = m.score;
        r.aiMoves++;
        putStone(r, x, y, bot.seat, now);
    }

    /** 认输：对方胜。 */
    private String resign(Player me, long now) {
        Room r = currentRoom(me);
        if (r == null) {
            return "你还没进房间";
        }
        if (r.winner != 0) {
            return "本局已结束";
        }
        if (r.black == null || r.white == null) {
            return "还没开始，无需认输";
        }
        r.winner = me.seat == 1 ? 2 : 1;
        r.lastActive = now;
        return null;
    }

    /** 再来一局：清盘重开，交换先后手（更公平）。 */
    private String again(Player me, long now) {
        Room r = currentRoom(me);
        if (r == null) {
            return "你还没进房间";
        }
        if (r.winner == 0) {
            return "本局还没结束";
        }
        if (r.black == null || r.white == null) {
            return "对手已经走了，等他回来";
        }
        for (int y = 0; y < BOARD; y++) {
            for (int x = 0; x < BOARD; x++) {
                r.cells[y][x] = 0;
            }
        }
        // 交换黑白（两边互换座位）
        Player b = r.black;
        r.black = r.white;
        r.white = b;
        if (r.black != null) {
            r.black.seat = 1;
        }
        if (r.white != null) {
            r.white.seat = 2;
        }
        r.turn = 1;
        r.winner = 0;
        r.last = null;
        r.win = null;
        r.moves = 0;
        r.lastActive = now;
        r.aiMoves = 0;
        r.aiMs = 0;
        r.aiNodes = 0;
        r.aiDepth = 0;
        r.aiScore = 0;
        // 交换先后手后 AI 可能坐到了黑位，得让它先走（同样隔一拍）
        scheduleBotTurn(r);
        return null;
    }

    /** 退出房间回大厅。 */
    private String leaveRoom(Player me) {
        if (me.room == null) {
            return null;
        }
        vacate(me);
        return null;
    }

    /** 把玩家从其房间的座位上摘下来（房间空了就留着等 TTL 清理）。 */
    private void vacate(Player p) {
        Room r = p.room == null ? null : rooms.get(p.room);
        if (r != null) {
            if (r.black == p) {
                r.black = null;
            }
            if (r.white == p) {
                r.white = null;
            }
            // 人走了，AI 也不必留着——否则房间永远"不是空的"，TTL 清不掉，会一直涨
            if (r.ai) {
                if (r.black != null && r.black.bot) {
                    r.black = null;
                }
                if (r.white != null && r.white.bot) {
                    r.white = null;
                }
                r.ai = false;
            }
            r.lastActive = System.currentTimeMillis();
            // 对手走了：本局直接作废，回来重新开
            if (r.winner == 0 && r.moves > 0) {
                r.winner = 3;
            }
        }
        p.room = null;
        p.seat = 0;
    }

    private Room currentRoom(Player me) {
        return me.room == null ? null : rooms.get(me.room);
    }

    /** 以 (x,y) 为落点，检查 seat 是否连成 5 子；连了返回整条线，否则 null。 */
    private static List<int[]> checkWin(Room r, int x, int y, int seat) {
        for (int[] d : DIRS) {
            List<int[]> line = new ArrayList<>();
            line.add(new int[]{x, y});
            for (int s = 1; s < BOARD; s++) {
                int nx = x + d[0] * s;
                int ny = y + d[1] * s;
                if (nx < 0 || ny < 0 || nx >= BOARD || ny >= BOARD || r.cells[ny][nx] != seat) {
                    break;
                }
                line.add(new int[]{nx, ny});
            }
            for (int s = 1; s < BOARD; s++) {
                int nx = x - d[0] * s;
                int ny = y - d[1] * s;
                if (nx < 0 || ny < 0 || nx >= BOARD || ny >= BOARD || r.cells[ny][nx] != seat) {
                    break;
                }
                line.add(new int[]{nx, ny});
            }
            if (line.size() >= 5) {
                return line;
            }
        }
        return null;
    }

    // =========================================================
    // 状态快照
    // =========================================================

    private String stateJson(Player me, String err) {
        long now = System.currentTimeMillis();
        StringBuilder b = new StringBuilder(2048);
        b.append("{\"t\":").append(now)
                .append(",\"you\":").append(Json.quote(me.id))
                .append(",\"name\":").append(Json.quote(me.name))
                .append(",\"board\":").append(BOARD)
                .append(",\"rooms\":").append(rooms.size())
                .append(",\"players\":").append(playerCount());

        Room r = currentRoom(me);
        b.append(",\"room\":");
        if (r == null) {
            b.append("null");
        } else {
            b.append(roomJson(r, me));
        }

        b.append(",\"err\":").append(err == null ? "null" : Json.quote(err));
        b.append('}');
        return b.toString();
    }

    private String roomJson(Room r, Player me) {
        StringBuilder b = new StringBuilder(1200);
        String state = r.winner != 0 ? "over"
                : (r.black != null && r.white != null ? "playing" : "waiting");
        b.append("{\"code\":").append(Json.quote(r.code))
                .append(",\"state\":").append(Json.quote(state))
                .append(",\"turn\":").append(r.turn)
                .append(",\"winner\":").append(r.winner)
                .append(",\"youSeat\":").append(me.seat)
                .append(",\"moves\":").append(r.moves);

        b.append(",\"last\":");
        if (r.last == null) {
            b.append("null");
        } else {
            b.append('[').append(r.last[0]).append(',').append(r.last[1]).append(']');
        }

        b.append(",\"win\":");
        if (r.win == null) {
            b.append("null");
        } else {
            b.append('[');
            boolean f = true;
            for (int[] c : r.win) {
                if (!f) {
                    b.append(',');
                }
                f = false;
                b.append('[').append(c[0]).append(',').append(c[1]).append(']');
            }
            b.append(']');
        }

        b.append(",\"black\":");
        appendSeat(b, r.black, r, 1);
        b.append(",\"white\":");
        appendSeat(b, r.white, r, 2);

        // 人机对战：把 AI 最近一次的"思考过程"透出去，前端直接显示
        // "0.03 秒 · 深度 6 · 812 节点"——视频里这一行就是"AI 真的在算"的证据
        b.append(",\"ai\":");
        if (!r.ai) {
            b.append("null");
        } else {
            int botSeat = (r.black != null && r.black.bot) ? 1 : 2;
            b.append("{\"seat\":").append(botSeat)
                    .append(",\"ms\":").append(r.aiMs)
                    .append(",\"nodes\":").append(r.aiNodes)
                    .append(",\"depth\":").append(r.aiDepth)
                    .append(",\"score\":").append(r.aiScore)
                    .append(",\"moves\":").append(r.aiMoves)
                    .append('}');
        }

        // 棋盘：外层 y、内层 x
        b.append(",\"cells\":[");
        for (int y = 0; y < BOARD; y++) {
            if (y > 0) {
                b.append(',');
            }
            b.append('[');
            for (int x = 0; x < BOARD; x++) {
                if (x > 0) {
                    b.append(',');
                }
                b.append(r.cells[y][x]);
            }
            b.append(']');
        }
        b.append("]}");
        return b.toString();
    }

    private void appendSeat(StringBuilder b, Player p, Room r, int seat) {
        if (p == null) {
            b.append("null");
            return;
        }
        b.append("{\"id\":").append(Json.quote(p.id))
                .append(",\"n\":").append(Json.quote(p.name))
                .append(",\"on\":").append(p.online)
                .append(",\"bot\":").append(p.bot)
                // 该座位是不是「正轮到走」（客户端高亮用）
                .append(",\"turn\":").append(r.winner == 0 && r.turn == seat)
                .append('}');
    }

    // =========================================================
    // 工具
    // =========================================================

    /** 生成一个没被占用的房间码。 */
    private String newCode() {
        for (int attempt = 0; attempt < 1000; attempt++) {
            StringBuilder b = new StringBuilder(CODE_LEN);
            for (int i = 0; i < CODE_LEN; i++) {
                b.append(CODE_CHARS.charAt(rnd.nextInt(CODE_CHARS.length())));
            }
            String c = b.toString();
            if (!rooms.containsKey(c)) {
                return c;
            }
        }
        return null;
    }

    /** 归一化玩家输入的房间码：去空白、转大写；格式不对返回 null。 */
    private static String normalizeCode(String raw) {
        if (raw == null) {
            return null;
        }
        String s = raw.trim().toUpperCase(java.util.Locale.ROOT);
        if (s.length() != CODE_LEN) {
            return null;
        }
        for (int i = 0; i < s.length(); i++) {
            if (CODE_CHARS.indexOf(s.charAt(i)) < 0) {
                return null;
            }
        }
        return s;
    }

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
