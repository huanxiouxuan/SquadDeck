package lkserver;

import java.util.ArrayList;
import java.util.List;

/**
 * 五子棋 AI —— Negamax 搜索 + Alpha-Beta 剪枝。
 *
 * <h3>为什么用这套方法</h3>
 * 五子棋是<b>完全信息、确定性、零和、无随机</b>的双人博弈：双方看到同一个棋盘，
 * 落子没有运气成分，我的收益恰好就是对手的损失。这类问题最合适的建模就是
 * <b>极大极小搜索</b>——把"我走一步、对手走一步"展开成一棵树，假设双方都走最优，
 * 反推出当前最好的一步。Negamax 是 minimax 的等价写法（每层换个视角、取负号），
 * 代码量少一半，结果完全一致。
 *
 * <p>但 15×15 的分支因子在 200 左右，裸搜 6 层是 200^6，算到天亮也下不完。
 * 真正让它可用的是三件事：
 * <ol>
 *   <li><b>Alpha-Beta 剪枝</b>——已经确定"这一步不可能比手上的选择更好"时，
 *       剩下的分支直接跳过。理想情况下同深度只需开方量级的节点。</li>
 *   <li><b>候选点限制</b>——五子棋的落点几乎总在已有棋子附近（距离 ≤ 2 格），
 *       远端空格在任何局面下都不比邻近点更有价值，直接排除。</li>
 *   <li><b>启发式排序</b>——候选点按"下这里能形成多强的棋型"降序试，
 *       先试最像的。排序越好，剪枝发生得越早。</li>
 * </ol>
 *
 * <h3>评估函数</h3>
 * 棋盘上有 {@code 72} 条长度 ≥5 的线（15 横 + 15 竖 + 21 斜↘ + 21 斜↗）。
 * 把每条线切成所有长度为 5 的窗口，看窗口里"只有我方子"能放几颗，按表
 * {@link #WINDOW} 加分：1 颗 1 分、2 颗 12、3 颗 120、4 颗 1500、5 颗直接算胜。
 * 对手的窗口对称扣分（略加权，逼 AI 先补自己的洞）。
 *
 * <p>这是<b>启发式</b>，不是精确胜负判定，只在搜索到达叶子时用——所以深度和
 * 评估质量是同一个问题的两面，二者一起决定"棋力"。
 *
 * <h3>线程安全</h3>
 * 每次 {@link #think} 新建一个实例，棋盘副本、节点计数等状态全部私有，
 * 可以被多个房间的 tick 线程同时调用。
 */
public final class GomokuAI {

    /** 棋盘边长（15 路）。 */
    public static final int N = 15;
    private static final int CELLS = N * N;

    /** 窗口评分表：下标 = 窗口内我方棋子数。 */
    private static final int[] WINDOW = {0, 1, 12, 120, 1500, 100_000_000};
    /** 五连分值，同时是搜索里"已分出胜负"的阈值。 */
    public static final int WIN_SCORE = 100_000_000;

    private static final int INF = Integer.MAX_VALUE / 4;

    /** 搜索的最大层数（偶数：保证叶子处轮到对方、评估视角一致）。 */
    private static final int MAX_DEPTH = 8;
    /** 缓冲区层数上限。 */
    private static final int MAX_PLY = MAX_DEPTH + 2;

    private static final int[][] DIRS = {{1, 0}, {0, 1}, {1, 1}, {1, -1}};

    // ===================== 预计算：72 条线 =====================

    private static final int LINE_COUNT;
    private static final int[][] LINES;
    /** 每个格子落在哪 4 条线上（横 / 竖 / 两条斜），用于增量维护。 */
    private static final int[][] CELL_LINES = new int[CELLS][4];

    static {
        List<int[]> list = new ArrayList<>();
        for (int y = 0; y < N; y++) {
            int[] l = new int[N];
            for (int x = 0; x < N; x++) {
                l[x] = y * N + x;
            }
            list.add(l);
        }
        for (int x = 0; x < N; x++) {
            int[] l = new int[N];
            for (int y = 0; y < N; y++) {
                l[y] = y * N + x;
            }
            list.add(l);
        }
        for (int x = 0; x < N; x++) {
            addDiagonal(list, x, 0, 1, 1);
            addDiagonal(list, x, N - 1, 1, -1);
        }
        for (int y = 1; y < N; y++) {
            addDiagonal(list, 0, y, 1, 1);
        }
        for (int y = 0; y < N - 1; y++) {
            addDiagonal(list, 0, y, 1, -1);
        }
        LINES = list.toArray(new int[0][]);
        LINE_COUNT = LINES.length;

        for (int li = 0; li < LINE_COUNT; li++) {
            for (int idx : LINES[li]) {
                int[] slot = CELL_LINES[idx];
                for (int s = 0; s < 4; s++) {
                    if (slot[s] == 0) {
                        slot[s] = li + 1;   // 存 li+1，0 表示空位
                        break;
                    }
                }
            }
        }
    }

    private static void addDiagonal(List<int[]> out, int sx, int sy, int dx, int dy) {
        List<Integer> tmp = new ArrayList<>(N);
        int x = sx;
        int y = sy;
        while (x >= 0 && y >= 0 && x < N && y < N) {
            tmp.add(y * N + x);
            x += dx;
            y += dy;
        }
        if (tmp.size() >= 5) {
            int[] a = new int[tmp.size()];
            for (int i = 0; i < a.length; i++) {
                a[i] = tmp.get(i);
            }
            out.add(a);
        }
    }

    // ===================== 对外结果 =====================

    /** 一次思考的结果。所有字段都给上层展示用（前端要显示"想了多久 / 算了多少节点"）。 */
    public static final class Move {
        public final int x;
        public final int y;
        public final int score;
        /** 完成的搜索深度；0 表示没来得及搜（用了快速启发式）。 */
        public final int depth;
        public final long nodes;
        public final long ms;
        /** 是否因为时间用尽提前收手（此时 depth 是最后一次完整搜索的深度）。 */
        public final boolean timedOut;

        Move(int x, int y, int score, int depth, long nodes, long ms, boolean timedOut) {
            this.x = x;
            this.y = y;
            this.score = score;
            this.depth = depth;
            this.nodes = nodes;
            this.ms = ms;
            this.timedOut = timedOut;
        }
    }

    // ===================== 实例状态 =====================

    private final int[] b = new int[CELLS];
    /** 每个空位周围 2 格内的棋子数：筛选"有意义的落点"用，搜索中增量维护。 */
    private final int[] nbr = new int[CELLS];
    /** 每条线上有多少颗子：整条线全空就跳过评估，搜索中增量维护。 */
    private final int[] lineStones = new int[LINE_COUNT];

    private final int[] moveBuf = new int[MAX_PLY * CELLS];
    private final long[] keyBuf = new long[MAX_PLY * CELLS];

    private long nodes;
    private long deadline;
    private boolean timedOut;
    private boolean prune = true;
    private int maxDepth = MAX_DEPTH;

    // ===================== 对外入口 =====================

    /**
     * 计算一步棋（默认最多 8 层，受时间预算约束）。
     *
     * @param cells    棋盘，{@code cells[y][x]}，0 = 空，非 0 = 已有子
     * @param seat     我方棋子值（1 或 2）
     * @param budgetMs 思考时间上限（毫秒）。迭代加深：浅层先算出一步，时间有富余
     *                 就再深一层，超时则沿用上一次完整结果
     */
    public static Move think(int[][] cells, int seat, long budgetMs) {
        return think(cells, seat, budgetMs, MAX_DEPTH);
    }

    /**
     * 计算一步棋，并限制最大搜索层数。
     *
     * <p>固定深度是<b>做实验对比</b>用的（"深度 2 对深度 4 谁强"），对局里用上面的重载。
     */
    public static Move think(int[][] cells, int seat, long budgetMs, int maxDepth) {
        GomokuAI ai = new GomokuAI();
        ai.maxDepth = Math.max(2, Math.min(MAX_DEPTH, maxDepth));
        ai.load(cells);
        return ai.search(seat, budgetMs);
    }

    /** 评估局面（seat 视角，越大越有利）。测试与讲解用。 */
    public static int evaluate(int[][] cells, int seat) {
        GomokuAI ai = new GomokuAI();
        ai.load(cells);
        return ai.evalSeat(seat);
    }

    /** 判断在 (x,y) 落 seat 后是否五连。 */
    public static boolean isFiveAt(int[][] cells, int x, int y, int seat) {
        GomokuAI ai = new GomokuAI();
        ai.load(cells);
        ai.b[y * N + x] = seat;
        return ai.isFive(y * N + x, seat);
    }

    /** 开/关 Alpha-Beta 剪枝——<b>只给实验用</b>：同一局面"剪与不剪各要多少节点"。 */
    public static void setPruningEnabled(boolean on) {
        ENABLE_PRUNING = on;
    }

    private static boolean ENABLE_PRUNING = true;

    // ===================== 内部实现 =====================

    private void load(int[][] cells) {
        for (int y = 0; y < N; y++) {
            for (int x = 0; x < N; x++) {
                int v = cells[y][x];
                if (v != 0) {
                    b[y * N + x] = v;
                    bump(y * N + x, +1);
                    addLineStones(y * N + x, +1);
                }
            }
        }
        prune = ENABLE_PRUNING;
    }

    /** 把 idx 周围 2 格内的计数 +delta。 */
    private void bump(int idx, int delta) {
        int x = idx % N;
        int y = idx / N;
        for (int dy = -2; dy <= 2; dy++) {
            int ny = y + dy;
            if (ny < 0 || ny >= N) {
                continue;
            }
            for (int dx = -2; dx <= 2; dx++) {
                int nx = x + dx;
                if (nx >= 0 && nx < N) {
                    nbr[ny * N + nx] += delta;
                }
            }
        }
    }

    private void addLineStones(int idx, int delta) {
        int[] ls = CELL_LINES[idx];
        for (int s = 0; s < 4; s++) {
            int li = ls[s];
            if (li == 0) {
                break;
            }
            lineStones[li - 1] += delta;
        }
    }

    private Move search(int seat, long budgetMs) {
        long t0 = System.nanoTime();
        deadline = t0 + Math.max(1, budgetMs) * 1_000_000L;
        nodes = 0;

        if (isEmpty()) {
            return new Move(N / 2, N / 2, 0, 0, 0, 0, false);
        }

        int n = candidates(seat, 0, 12);
        if (n == 0) {
            // 棋盘满了
            return new Move(N / 2, N / 2, 0, 0, 0, 0, false);
        }

        // ---- 0) 开局规则：盘上只有自己这一颗子时，搜索没有棋型可算 ----
        // 两子以内，任何深度的评估都只是在放大噪声（实测深度 6 会挑出跳着的怪点），
        // 不如直接用启发式：落在"自己最容易成线、又最挡对手"的那个点上。
        if (stoneCount() <= 2) {
            int idx = moveBuf[0];   // candidates 已按 攻击+防守 降序排好
            long ms0 = (System.nanoTime() - t0) / 1_000_000L;
            return new Move(idx % N, idx / N, 0, 0, 0, ms0, false);
        }

        // ---- 1) 我能立刻成五：直接赢，不用搜 ----
        for (int i = 0; i < n; i++) {
            int idx = moveBuf[i];
            b[idx] = seat;
            boolean win = isFive(idx, seat);
            b[idx] = 0;
            if (win) {
                long ms = (System.nanoTime() - t0) / 1_000_000L;
                return new Move(idx % N, idx / N, WIN_SCORE, 1, 0, ms, false);
            }
        }

        // ---- 2) 对手下这里就成五：这些点必须封，其余分支没有意义 ----
        int nm = 0;
        int[] must = new int[CELLS];
        for (int i = 0; i < n; i++) {
            int idx = moveBuf[i];
            b[idx] = 3 - seat;
            boolean win = isFive(idx, 3 - seat);
            b[idx] = 0;
            if (win) {
                must[nm++] = idx;
            }
        }
        if (nm > 0) {
            // 多个封点说明已经防不住，仍然挑一个分最高的尽力而为
            System.arraycopy(must, 0, moveBuf, 0, nm);
            n = nm;
        }

        // ---- 3) 迭代加深 ----
        int bestIdx = moveBuf[0];
        int bestVal = 0;
        int bestDepth = 0;
        boolean aborted = false;

        for (int depth = 2; depth <= maxDepth; depth += 2) {
            int alpha = -INF;
            int curBest = -1;
            int curVal = -INF;
            for (int i = 0; i < n; i++) {
                int idx = moveBuf[i];
                b[idx] = seat;
                // ★ 根节点也必须同步维护 nbr / lineStones：否则子树里既看不到
                //   这一步附近的应对点，叶子评估还会把"因这一步才非空的线"整条跳过
                bump(idx, +1);
                addLineStones(idx, +1);
                int v;
                if (isFive(idx, seat)) {
                    v = WIN_SCORE - 1;
                } else {
                    v = -negamax(3 - seat, depth - 1, -INF, -alpha, 1);
                }
                b[idx] = 0;
                bump(idx, -1);
                addLineStones(idx, -1);
                if (timedOut) {
                    aborted = true;
                    break;
                }
                if (v > curVal) {
                    curVal = v;
                    curBest = idx;
                }
                if (v > alpha) {
                    alpha = v;
                }
            }
            if (aborted || curBest < 0) {
                break;   // 本层没算完：丢弃，沿用上一层结论
            }
            bestIdx = curBest;
            bestVal = curVal;
            bestDepth = depth;
            toFront(moveBuf, n, curBest);   // 下一层从最好的点开始试，剪枝更早
            if (bestVal >= WIN_SCORE / 2 || bestVal <= -WIN_SCORE / 2) {
                break;   // 已算出必胜/必败
            }
            if (System.nanoTime() > deadline) {
                aborted = true;
                break;
            }
        }

        long ms = (System.nanoTime() - t0) / 1_000_000L;
        return new Move(bestIdx % N, bestIdx / N, bestVal, bestDepth, nodes, ms, aborted);
    }

    private boolean isEmpty() {
        for (int i = 0; i < LINE_COUNT; i++) {
            if (lineStones[i] != 0) {
                return false;
            }
        }
        return true;
    }

    /** 盘上棋子总数（用于判断是否还在开局）。 */
    private int stoneCount() {
        int c = 0;
        for (int idx = 0; idx < CELLS; idx++) {
            if (b[idx] != 0) {
                c++;
            }
        }
        return c;
    }

    /**
     * Negamax + Alpha-Beta。
     *
     * @param seat  轮到谁走
     * @param depth 剩余层数
     * @param alpha 下界：我已经能保证拿到的分
     * @param beta  上界：对手不会让我超过的分
     * @param ply   层号（决定缓冲区偏移，避免每层 new 数组）
     * @return 站在 seat 视角的局面分
     */
    private int negamax(int seat, int depth, int alpha, int beta, int ply) {
        nodes++;
        if ((nodes & 511) == 0 && System.nanoTime() > deadline) {
            timedOut = true;
            return 0;
        }
        if (depth <= 0) {
            return evalSeat(seat);
        }

        int base = ply * CELLS;
        int n = candidates(seat, ply, ply <= 2 ? 10 : 8);
        if (n == 0) {
            return evalSeat(seat);
        }

        int best = -INF;
        // 关掉剪枝时给子节点传全区间，且本层不提前 break —— 退化成朴素 minimax
        int a = prune ? alpha : -INF;
        int be = prune ? beta : INF;

        for (int i = 0; i < n; i++) {
            int idx = moveBuf[base + i];
            b[idx] = seat;
            bump(idx, +1);
            addLineStones(idx, +1);

            int v;
            if (isFive(idx, seat)) {
                v = WIN_SCORE - (MAX_DEPTH - depth);
            } else {
                v = -negamax(3 - seat, depth - 1, -be, -a, ply + 1);
            }

            b[idx] = 0;
            bump(idx, -1);
            addLineStones(idx, -1);

            if (timedOut) {
                return 0;
            }
            if (v > best) {
                best = v;
            }
            if (v > a) {
                a = v;
            }
            if (prune && a >= be) {
                break;   // ★ 剪枝：对手不会让我走到这里
            }
        }
        return best;
    }

    /**
     * 生成候选点并按启发式降序取前 {@code limit} 个。
     *
     * <p>分支因子从 200 降到 8~12 就靠这里：只考虑已有棋子 2 格内的空位
     * （{@code nbr[idx] > 0}），再按棋型强弱排序。
     */
    private int candidates(int seat, int ply, int limit) {
        int base = ply * CELLS;
        int n = 0;
        int opp = 3 - seat;
        for (int idx = 0; idx < CELLS; idx++) {
            if (b[idx] != 0 || nbr[idx] == 0) {
                continue;
            }
            // 我下这里的价值 + 对手下这里的价值（后者即我的防守价值）
            long gain = (long) gainAt(idx, seat) + gainAt(idx, opp);
            keyBuf[base + n++] = (gain << 32) | idx;
        }
        if (n == 0) {
            return 0;
        }

        // 取前 limit 个（K 很小，插入排序比整表排序划算，且能提前跳过）
        int cnt = 0;
        int[] sel = new int[limit];
        long[] selKey = new long[limit];
        for (int i = 0; i < n; i++) {
            long key = keyBuf[base + i];
            if (cnt == limit && key <= selKey[cnt - 1]) {
                continue;
            }
            int pos = cnt < limit ? cnt : limit - 1;
            if (cnt < limit) {
                cnt++;
            }
            sel[pos] = (int) (key & 0xFFFFFFFFL);
            selKey[pos] = key;
            while (pos > 0 && selKey[pos] > selKey[pos - 1]) {
                long tk = selKey[pos];
                selKey[pos] = selKey[pos - 1];
                selKey[pos - 1] = tk;
                int ti = sel[pos];
                sel[pos] = sel[pos - 1];
                sel[pos - 1] = ti;
                pos--;
            }
        }
        for (int i = 0; i < cnt; i++) {
            moveBuf[base + i] = sel[i];
        }
        return cnt;
    }

    /**
     * 在 (idx) 落一颗 seat 的子能形成多强的棋型，四方向累加。
     *
     * <p>只数"连着的"同色子与两端开放情况；含空隙的跳三之类这里不识别，
     * 交给搜索去看——排序只需要大致正确，不需要精确。
     */
    private int gainAt(int idx, int seat) {
        int x = idx % N;
        int y = idx / N;
        int total = 0;
        for (int[] d : DIRS) {
            int cnt = 1;
            int open = 0;
            int k = 1;
            while (true) {
                int nx = x + d[0] * k;
                int ny = y + d[1] * k;
                if (nx < 0 || ny < 0 || nx >= N || ny >= N) {
                    break;
                }
                int v = b[ny * N + nx];
                if (v == seat) {
                    cnt++;
                    k++;
                } else {
                    if (v == 0) {
                        open++;
                    }
                    break;
                }
            }
            k = 1;
            while (true) {
                int nx = x - d[0] * k;
                int ny = y - d[1] * k;
                if (nx < 0 || ny < 0 || nx >= N || ny >= N) {
                    break;
                }
                int v = b[ny * N + nx];
                if (v == seat) {
                    cnt++;
                    k++;
                } else {
                    if (v == 0) {
                        open++;
                    }
                    break;
                }
            }
            total += patternValue(cnt, open);
        }
        return total;
    }

    /** 连子数 + 开放端数 → 分值。 */
    private static int patternValue(int cnt, int open) {
        if (cnt >= 5) {
            return WIN_SCORE;
        }
        switch (cnt) {
            case 4:
                return open == 2 ? 100_000 : (open == 1 ? 10_000 : 0);
            case 3:
                return open == 2 ? 8_000 : (open == 1 ? 800 : 0);
            case 2:
                return open == 2 ? 400 : (open == 1 ? 50 : 0);
            default:
                return open == 2 ? 20 : (open == 1 ? 2 : 0);
        }
    }

    /** 在 (idx) 已落 seat 的前提下判断是否五连。 */
    private boolean isFive(int idx, int seat) {
        int x = idx % N;
        int y = idx / N;
        for (int[] d : DIRS) {
            int cnt = 1;
            int k = 1;
            while (true) {
                int nx = x + d[0] * k;
                int ny = y + d[1] * k;
                if (nx < 0 || ny < 0 || nx >= N || ny >= N || b[ny * N + nx] != seat) {
                    break;
                }
                cnt++;
                k++;
            }
            k = 1;
            while (true) {
                int nx = x - d[0] * k;
                int ny = y - d[1] * k;
                if (nx < 0 || ny < 0 || nx >= N || ny >= N || b[ny * N + nx] != seat) {
                    break;
                }
                cnt++;
                k++;
            }
            if (cnt >= 5) {
                return true;
            }
        }
        return false;
    }

    /**
     * 全盘评估 = 「连段分」（主）+「窗口分」（辅），我方减去对方。
     *
     * <p>为什么主用连段：窗口法只数"窗口里我方有几颗"，<b>分不出活三和死三</b>——
     * 三颗两头被堵和三颗两头都空，在窗口里长得一样，但前者毫无威胁、后者两步成五。
     * 分不出活三，AI 就只会看到"对方有三颗"然后去堵，永远不会有自己的杀招，
     * 两个这样的 AI 能互相封满整盘还不分胜负。所以主分必须带上<b>开放端数</b>。
     *
     * <p>窗口分保留做辅助：它能识别<b>含空隙的棋型</b>（如 X_XX），连段法看不到。
     */
    private int evalSeat(int me) {
        int opp = 3 - me;
        int runMe = 0;
        int runOpp = 0;
        int winMe = 0;
        int winOpp = 0;
        for (int li = 0; li < LINE_COUNT; li++) {
            if (lineStones[li] == 0) {
                continue;
            }
            int[] line = LINES[li];
            runMe += runScore(line, me);
            runOpp += runScore(line, opp);
            int len = line.length;
            for (int i = 0; i + 5 <= len; i++) {
                int mine = 0;
                int theirs = 0;
                for (int j = 0; j < 5; j++) {
                    int v = b[line[i + j]];
                    if (v == me) {
                        mine++;
                    } else if (v == opp) {
                        theirs++;
                    }
                }
                if (theirs == 0) {
                    winMe += WINDOW[mine];
                } else if (mine == 0) {
                    winOpp += WINDOW[theirs];
                }
            }
        }
        // 连段分占主导；窗口分降权，只用来补"含空隙棋型"的漏
        return (runMe - runOpp) + (winMe - winOpp) / 8;
    }

    /** 一条线上 me 的所有连段之和：连子数 + 两端是否为空。 */
    private int runScore(int[] line, int me) {
        int n = line.length;
        int total = 0;
        int i = 0;
        while (i < n) {
            if (b[line[i]] != me) {
                i++;
                continue;
            }
            int j = i;
            while (j < n && b[line[j]] == me) {
                j++;
            }
            int cnt = j - i;
            int open = 0;
            if (i > 0 && b[line[i - 1]] == 0) {
                open++;
            }
            if (j < n && b[line[j]] == 0) {
                open++;
            }
            total += runValue(cnt, open);
            i = j;
        }
        return total;
    }

    /**
     * 连段价值：活四(两头空)几乎等于赢，冲四只逼一步，活三才是真正的进攻起点。
     * 这组数字是棋力调参的核心——活三必须显著高于"三颗死子 + 若干二"。
     */
    private static int runValue(int cnt, int open) {
        if (cnt >= 5) {
            return 10_000_000;
        }
        if (open == 0) {
            return 0;   // 两头都堵死：这串子已经废了
        }
        switch (cnt) {
            case 4:
                return open == 2 ? 300_000 : 20_000;
            case 3:
                return open == 2 ? 25_000 : 1_500;
            case 2:
                return open == 2 ? 600 : 150;
            default:
                return open == 2 ? 30 : 8;
        }
    }

    /** 把数组里值为 target 的元素挪到下标 0。 */
    private static void toFront(int[] arr, int n, int target) {
        for (int i = 1; i < n; i++) {
            if (arr[i] == target) {
                int t = arr[i];
                System.arraycopy(arr, 0, arr, 1, i);
                arr[0] = t;
                return;
            }
        }
    }
}
