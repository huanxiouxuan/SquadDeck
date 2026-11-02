package lkserver;

import java.util.ArrayList;
import java.util.List;
import java.util.Random;

/**
 * 五子棋 AI 自动对战台（离线跑，不依赖服务器）。
 *
 * <p>用法（在项目根目录）：
 * <pre>
 *   javac -encoding UTF-8 -d 测试文件/.bench gamemode/gmv9ny2bh/server/GomokuAI.java 测试文件/AiBench.java
 *   java -cp 测试文件/.bench lkserver.AiBench
 * </pre>
 *
 * <p>输出三块：
 * <ol>
 *   <li><b>战术正确性</b>——会不会漏杀、会不会不补四；</li>
 *   <li><b>剪枝效率</b>——同一局面开/关 Alpha-Beta 的节点数之比；</li>
 *   <li><b>对战矩阵</b>——随机 / 贪心 / 深度2 / 深度4 两两对打的胜率。</li>
 * </ol>
 */
public final class AiBench {

    private static final int N = GomokuAI.N;

    // ===================== 玩家抽象 =====================

    interface Player {
        /** 返回 {x, y}。 */
        int[] move(int[][] cells, int seat);

        String name();
    }

    /** 随机落子（只在已有棋子附近挑，否则太容易自娱自乐）。 */
    static final class RandomPlayer implements Player {
        private final Random rnd;

        RandomPlayer(long seed) {
            this.rnd = new Random(seed);
        }

        @Override
        public int[] move(int[][] cells, int seat) {
            List<int[]> cand = new ArrayList<>();
            for (int y = 0; y < N; y++) {
                for (int x = 0; x < N; x++) {
                    if (cells[y][x] == 0 && near(cells, x, y)) {
                        cand.add(new int[]{x, y});
                    }
                }
            }
            if (cand.isEmpty()) {
                return new int[]{N / 2, N / 2};
            }
            return cand.get(rnd.nextInt(cand.size()));
        }

        @Override
        public String name() {
            return "随机";
        }
    }

    /** 贪心：只看一步，选评估分最高的落点。没有前瞻，是"会下棋"的最低门槛。 */
    static final class GreedyPlayer implements Player {
        @Override
        public int[] move(int[][] cells, int seat) {
            int bx = -1;
            int by = -1;
            int best = Integer.MIN_VALUE;
            for (int y = 0; y < N; y++) {
                for (int x = 0; x < N; x++) {
                    if (cells[y][x] != 0 || !near(cells, x, y)) {
                        continue;
                    }
                    cells[y][x] = seat;
                    int v;
                    if (GomokuAI.isFiveAt(cells, x, y, seat)) {
                        v = Integer.MAX_VALUE;
                    } else {
                        v = GomokuAI.evaluate(cells, seat);
                    }
                    cells[y][x] = 0;
                    if (v > best) {
                        best = v;
                        bx = x;
                        by = y;
                    }
                }
            }
            if (bx < 0) {
                return new int[]{N / 2, N / 2};
            }
            return new int[]{bx, by};
        }

        @Override
        public String name() {
            return "贪心";
        }
    }

    /** 搜索型玩家。 */
    static final class SearchPlayer implements Player {
        private final int depth;
        private final long budget;
        long nodes;
        long ms;

        SearchPlayer(int depth, long budget) {
            this.depth = depth;
            this.budget = budget;
        }

        @Override
        public int[] move(int[][] cells, int seat) {
            GomokuAI.Move m = GomokuAI.think(cells, seat, budget, depth);
            nodes += m.nodes;
            ms += m.ms;
            return new int[]{m.x, m.y};
        }

        @Override
        public String name() {
            return "AI-深度" + depth;
        }
    }

    static boolean near(int[][] cells, int x, int y) {
        for (int dy = -2; dy <= 2; dy++) {
            for (int dx = -2; dx <= 2; dx++) {
                int nx = x + dx;
                int ny = y + dy;
                if (nx >= 0 && ny >= 0 && nx < N && ny < N && cells[ny][nx] != 0) {
                    return true;
                }
            }
        }
        return false;
    }

    // ===================== 对局 =====================

    /**
     * 对一局。
     *
     * @param init 开局摆设（可为 null）。用随机开局是为了消掉"先手必胜"这个偏差——
     *             同一个引擎先手总赢的话，只靠交换先后手是分不出强弱的
     * @return 1 = 黑(p1) 胜，2 = 白(p2) 胜，0 = 和
     */
    static int play(Player black, Player white, List<int[]> record, int[][] init) {
        int[][] cells = new int[N][N];
        int start = 0;
        if (init != null) {
            for (int y = 0; y < N; y++) {
                for (int x = 0; x < N; x++) {
                    cells[y][x] = init[y][x];
                    if (init[y][x] != 0) {
                        start++;
                    }
                }
            }
        }
        Player[] side = {null, black, white};
        for (int ply = start; ply < N * N; ply++) {
            int seat = ply % 2 + 1;
            int[] mv = side[seat].move(cells, seat);
            int x = Math.max(0, Math.min(N - 1, mv[0]));
            int y = Math.max(0, Math.min(N - 1, mv[1]));
            if (cells[y][x] != 0) {
                // 兜底：AI 给了非法点（不该发生），找个空位
                boolean placed = false;
                for (int yy = 0; yy < N && !placed; yy++) {
                    for (int xx = 0; xx < N && !placed; xx++) {
                        if (cells[yy][xx] == 0) {
                            cells[yy][xx] = seat;
                            x = xx;
                            y = yy;
                            placed = true;
                        }
                    }
                }
                if (!placed) {
                    return 0;
                }
            } else {
                cells[y][x] = seat;
            }
            if (record != null) {
                record.add(new int[]{x, y, seat});
            }
            if (GomokuAI.isFiveAt(cells, x, y, seat)) {
                return seat;
            }
        }
        return 0;
    }

    /**
     * 造一个随机开局：在中心 7×7 里放 {@code k} 颗子，黑白交替（黑先），位置由种子决定。
     * 同一组种子对所有对局复用，保证"强弱对比"比的是引擎而不是运气。
     */
    static int[][] makeOpening(int k, long seed) {
        Random rnd = new Random(seed);
        int[][] c = new int[N][N];
        int placed = 0;
        while (placed < k) {
            int x = N / 2 - 3 + rnd.nextInt(7);
            int y = N / 2 - 3 + rnd.nextInt(7);
            if (c[y][x] != 0) {
                continue;
            }
            c[y][x] = placed % 2 + 1;
            placed++;
        }
        return c;
    }

    // ===================== 主流程 =====================

    public static void main(String[] args) {
        int games = args.length > 0 ? Integer.parseInt(args[0]) : 20;
        long budget = 200;

        System.out.println("================ 1. 战术正确性 ================");
        checkTactics();

        System.out.println();
        System.out.println("================ 2. Alpha-Beta 剪枝效率 ================");
        checkPruning(budget);

        System.out.println();
        System.out.println("================ 3. 对战矩阵（每对 " + games + " 局，交换先后手）================");
        matchMatrix(games, budget);
    }

    /** 战术：必杀（有四必须冲）与必防（对方有四必须堵）。 */
    private static void checkTactics() {
        // 局面 A：黑在 (3,7)(4,7)(5,7)(6,7)，轮到黑——必须走 (2,7) 或 (7,7) 成五
        int[][] a = new int[N][N];
        for (int x = 3; x <= 6; x++) {
            a[7][x] = 1;
        }
        a[6][8] = 2;
        GomokuAI.Move m = GomokuAI.think(a, 1, 300, 8);
        boolean okWin = (m.y == 7) && (m.x == 2 || m.x == 7);
        System.out.printf("必杀测试：落 (%d,%d)，判定 %s%n", m.x, m.y, okWin ? "通过" : "失败");

        // 局面 B：白已成四，轮到黑——必须堵
        int[][] c = new int[N][N];
        for (int x = 4; x <= 7; x++) {
            c[7][x] = 2;
        }
        c[6][6] = 1;
        GomokuAI.Move m2 = GomokuAI.think(c, 1, 300, 8);
        boolean okBlock = (m2.y == 7) && (m2.x == 3 || m2.x == 8);
        System.out.printf("必防测试：落 (%d,%d)，判定 %s%n", m2.x, m2.y, okBlock ? "通过" : "失败");

        // 局面 C：空盘第一手应落在中心区域（不该贴边）
        int[][] e = new int[N][N];
        GomokuAI.Move m3 = GomokuAI.think(e, 1, 300, 8);
        boolean okOpen = Math.abs(m3.x - 7) <= 1 && Math.abs(m3.y - 7) <= 1;
        System.out.printf("开局测试：落 (%d,%d)，判定 %s%n", m3.x, m3.y, okOpen ? "通过" : "失败");
    }

    /** 从真实对局里取若干局面，分别开/关剪枝搜索，比节点数。 */
    private static void checkPruning(long budget) {
        List<int[]> rec = new ArrayList<>();
        // 用一局较长的对局取材（贪心对贪心往往十手内就结束，中局样本太少）
        play(new SearchPlayer(2, 200), new SearchPlayer(2, 200), rec, null);

        int[][] cells = new int[N][N];
        long nodesOn = 0;
        long nodesOff = 0;
        long msOn = 0;
        long msOff = 0;
        int samples = 0;
        // 不剪枝那一路要慢得多，预算给足（这里比的是节点数，不是时间）
        long big = 10000;

        for (int i = 0; i < rec.size() && samples < 12; i++) {
            int[] mv = rec.get(i);
            cells[mv[1]][mv[0]] = mv[2];
            if (i < 6 || i % 2 != 0) {
                continue;
            }
            int seat = 3 - mv[2];
            GomokuAI.setPruningEnabled(true);
            GomokuAI.Move on = GomokuAI.think(cells, seat, big, 4);
            GomokuAI.setPruningEnabled(false);
            GomokuAI.Move off = GomokuAI.think(cells, seat, big, 4);
            GomokuAI.setPruningEnabled(true);
            nodesOn += on.nodes;
            nodesOff += off.nodes;
            msOn += on.ms;
            msOff += off.ms;
            samples++;
        }

        if (samples == 0) {
            System.out.println("（样本不足，未取得对比）");
            return;
        }
        double ratio = nodesOn == 0 ? 0 : 100.0 * (1.0 - (double) nodesOn / nodesOff);
        System.out.printf("样本局面 %d 个，深度固定 4 层%n", samples);
        System.out.printf("  开剪枝：合计 %d 节点 / %d ms%n", nodesOn, msOn);
        System.out.printf("  关剪枝：合计 %d 节点 / %d ms%n", nodesOff, msOff);
        System.out.printf("  节点削减 %.1f%%（相当于 %.1f 倍）%n",
                ratio, nodesOn == 0 ? 0 : (double) nodesOff / nodesOn);
    }

    private static void matchMatrix(int games, long budget) {
        Player[] ps = {
                new RandomPlayer(42),
                new GreedyPlayer(),
                new SearchPlayer(2, budget),
                new SearchPlayer(4, budget),
        };
        int w = ps.length;
        double[][] rate = new double[w][w];

        for (int i = 0; i < w; i++) {
            for (int j = i + 1; j < w; j++) {
                int winI = 0;
                int winJ = 0;
                int draw = 0;
                for (int g = 0; g < games; g++) {
                    boolean iBlack = (g % 2 == 0);
                    Player black = iBlack ? ps[i] : ps[j];
                    Player white = iBlack ? ps[j] : ps[i];
                    // 每局换一个开局（0~2 子随机），避免"先手必胜"把强弱盖掉
                    int[][] opening = makeOpening(g % 3, 1000 + g);
                    int r = play(black, white, null, opening);
                    if (r == 0) {
                        draw++;
                    } else if ((r == 1) == iBlack) {
                        winI++;
                    } else {
                        winJ++;
                    }
                }
                // 胜率按"有胜负的局"算，和棋单独列出
                int decided = winI + winJ;
                rate[i][j] = decided == 0 ? 0 : (double) winI / decided;
                rate[j][i] = decided == 0 ? 0 : (double) winJ / decided;
                System.out.printf("%-12s vs %-12s  %2d 胜 %2d 负 %2d 和   胜率 %s%n",
                        ps[i].name(), ps[j].name(), winI, winJ, draw,
                        decided == 0 ? "-" : String.format("%.0f%%", rate[i][j] * 100));
            }
        }

        System.out.println();
        System.out.println("胜率矩阵（行对列，已剔除和棋）");
        System.out.print("            ");
        for (Player p : ps) {
            System.out.printf("%-12s", p.name());
        }
        System.out.println();
        for (int i = 0; i < w; i++) {
            System.out.printf("%-12s", ps[i].name());
            for (int j = 0; j < w; j++) {
                System.out.printf("%-12s", i == j ? "-" : String.format("%.0f%%", rate[i][j] * 100));
            }
            System.out.println();
        }
    }
}
