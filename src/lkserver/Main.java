package lkserver;

import java.nio.file.Files;

/**
 * 程序入口，对应 C++ 版的 main.cpp。
 *
 * <p>用法：{@code java -jar lkserver2-game.jar <端口号> <启动器目录> [子反应堆线程数] [游戏目录]}
 *
 * <p>与 C++ 版 main.cpp 的对应关系：
 * <ul>
 *   <li>主反应堆在 main 线程里跑（同 C++）；子反应堆各占一个线程（one loop per thread）。</li>
 *   <li>C++ 用 signalfd 把 SIGINT/SIGTERM 变成事件循环里的一个可读 fd；
 *       Java 没有信号 fd，这里用 {@link Runtime#addShutdownHook} + {@link EventLoop#stop()}
 *       实现等价的「优雅关闭」：停 accept -> 停并 join 所有子反应堆 -> 主反应堆退出。</li>
 *   <li>C++ 用 chdir 切换工作目录；Java 改用 {@link ServerContext} 保存根目录并做安全校验。</li>
 * </ul>
 *
 * <p>「开黑启动器」版：{@code <启动器目录>} 放启动器页面（默认 {@code www/}），
 * {@code <游戏目录>} 放各个小游戏（默认 {@code <启动器目录>/../gamemode/}），
 * 每个游戏一个子目录、带自己的 game.json（见 {@link GameModes}）。
 */
public class Main {

    public static void main(String[] args) {
        if (args.length < 2) {
            System.out.println("用法: java -jar lkserver2-game.jar <端口号> <启动器目录> [子反应堆线程数] [游戏目录]");
            System.out.println("示例: java -jar lkserver2-game.jar 8080 www");
            return;
        }

        int port;
        try {
            port = Integer.parseInt(args[0]);
        } catch (NumberFormatException e) {
            System.err.println("端口号不是合法整数: " + args[0]);
            return;
        }

        // 小游戏目录：默认是「启动器目录的同级 gamemode/」，也可用第 4 个参数指定
        java.nio.file.Path modesDir = java.nio.file.Paths.get(args[1])
                .toAbsolutePath().normalize().resolve("..").resolve("gamemode").normalize();
        if (args.length >= 4 && !args[3].isEmpty()) {
            modesDir = java.nio.file.Paths.get(args[3]).toAbsolutePath().normalize();
        }
        GameModes modes = new GameModes(modesDir);

        // 联机游戏世界注册表：按 game.json 的 world 字段反射加载世界类。
        // 新增联机游戏只需写自己的世界类 + 在 game.json 里声明，不用改这里；
        // 只有声明了 autostart 的世界随服务器启动，其余等房主在启动器里拨开关。
        WorldRegistry worlds = new WorldRegistry(modes);

        ServerContext ctx = new ServerContext(args[1], modes, new GameApi(worlds, port, modes));
        if (!Files.isDirectory(ctx.root)) {
            System.err.println("目录不存在或不是目录: " + ctx.root);
            return;
        }

        int subReactorNum = 4;
        if (args.length >= 3) {
            try {
                subReactorNum = Math.max(1, Integer.parseInt(args[2]));
            } catch (NumberFormatException e) {
                System.err.println("子反应堆线程数不是合法整数，使用默认值 4");
            }
        }

        try {
            // 1) 主反应堆（在 main 线程中运行）
            EventLoop mainLoop = new EventLoop("MainReactor");

            // 2) 子反应堆线程池
            EventLoopThreadPool pool = new EventLoopThreadPool();
            pool.start(subReactorNum, "SubReactor-");

            // 3) 接收器：监听端口并把新连接分发给子反应堆
            Acceptor acceptor = new Acceptor(mainLoop, pool, ctx);
            acceptor.init(port);

            // 4) 启动游戏世界：只拉起 game.json 里 autostart 的
            //    （其余等房主在启动器里用开关启动，见 WorldRegistry）
            worlds.startAll();

            // 5) 优雅关闭钩子（等价于 C++ 的 signalfd 处理）
            Runtime.getRuntime().addShutdownHook(new Thread(() -> {
                System.out.println("\n收到关闭信号, 开始优雅关闭 ...");
                worlds.stopAll();                    // 停所有游戏世界
                mainLoop.execute(acceptor::close);   // 在反应堆线程内安全关闭监听套接字
                pool.stopAll();                      // 通知并 join 所有子反应堆
                mainLoop.stop();                     // 唤醒并退出主反应堆循环
            }, "ShutdownHook"));

            System.out.println("SquadDeck 启动: port=" + port
                    + ", 启动器目录=" + ctx.root
                    + ", 游戏目录=" + ctx.modesDir
                    + ", 子反应堆线程数=" + subReactorNum);
            System.out.println("已加载 " + modes.size() + " 个小游戏"
                    + (modes.size() > 0 ? ": " + gameNames(modes) : "（游戏目录里还没有游戏）"));
            System.out.println("联机世界已启动 " + worlds.runningCount() + " 个（同时上限 "
                    + WorldRegistry.MAX_RUNNING + "，其余等房主在启动器里拨开关）");
            System.out.println("按 Ctrl+C 优雅关闭");

            // 6) 启动主反应堆循环（阻塞在 main 线程）
            mainLoop.run();

            System.out.println("lkserver2-game 已优雅退出");
        } catch (Exception e) {
            System.err.println("启动失败: " + e);
            e.printStackTrace();
        }
    }

    /** 「坦克世界、贪吃蛇、…」——启动横幅里列出已加载的游戏。 */
    private static String gameNames(GameModes modes) {
        StringBuilder sb = new StringBuilder();
        for (GameMode m : modes.list()) {
            if (sb.length() > 0) {
                sb.append('、');
            }
            sb.append(m.name);
        }
        return sb.toString();
    }
}
