package lkserver;

import java.io.IOException;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Stream;
import javax.tools.JavaCompiler;
import javax.tools.ToolProvider;

/**
 * 联机游戏世界注册表：管「哪些游戏正在服务器上跑」。
 *
 * <p>职责：
 * <ul>
 *   <li><b>声明式加载</b>：游戏在 game.json 里用 {@code world} 字段声明世界类
 *       （全限定名，如 {@code lkserver.SnakeWorld}），本表负责把它创建出来；
 *       {@code autostart: true} 的世界随服务器启动拉起，其余等房主拨开关；</li>
 *   <li><b>自带服务端代码</b>（关键）：世界类可以来自三处，按优先级：
 *       <ol>
 *         <li>游戏目录里的 {@code server.jar}（作者已经编译好的插件包）；</li>
 *         <li>游戏目录 {@code server/} 下的 {@code *.java} <b>源码</b>——服务器
 *             用自带 JDK 现场编译后加载（作者只给源码也能直接跑）；</li>
 *         <li>都没找到 → 回落到服务器内核 jar 里的内置类（坦克、贪吃蛇）。</li>
 *       </ol>
 *       所以<b>从网上拿一份游戏文件夹（含 server/ 源码或 server.jar）导进来
 *       就能直接启动，不用改内核、不用重编 jar</b>；</li>
 *   <li><b>房主启停</b>：{@link #start(String)} / {@link #stop(String)} 由
 *       GameApi 的 {@code POST /api/games/<id>/start|stop} 调用（房主校验在 API 层）；</li>
 *   <li><b>同时启动上限</b>：{@value #MAX_RUNNING} 个——每个运行中的世界常驻一个
 *       tick 线程，不玩也空转，所以要有上限；</li>
 *   <li><b>运行查询</b>：{@link #get(String)} 只返回<b>正在跑</b>的世界，
 *       没启动的游戏打接口会得到 409（见 GameApi 通用分发）。</li>
 * </ul>
 *
 * <h3>插件类加载器</h3>
 * 自带代码用 {@link URLClassLoader} 加载，父加载器是内核的类加载器——这样
 * 插件里的 {@code implements GameWorldPlugin} 解析到的是<b>内核那个接口</b>，
 * 插件与内核之间类型一致（不会出现「同名接口两个副本」导致的 ClassCastException）。
 * 停止世界时关掉该加载器，释放 jar 文件句柄。
 *
 * <p>⚠️ 加载并运行导入的代码 = 在本机执行任意 Java。这是本地「开黑启动器」的既有
 * 取舍（导入的游戏本来就是可执行内容），但别把来路不明的游戏往公网服务器上装。
 *
 * <p>线程安全：{@code running} 是 ConcurrentHashMap，启停改动都在 {@code this}
 * 锁内做；查询（get/isRunning）无锁走 map。
 */
public final class WorldRegistry {

    /** 同时运行的世界上限。每个运行中的世界 = 一个 tick 线程 + 一份世界状态。 */
    public static final int MAX_RUNNING = 4;

    /** 启停结果（GameApi 翻译成 HTTP 状态码）。 */
    public enum Result {
        /** 成功 */
        OK,
        /** game.json 里没有这个游戏 */
        NO_GAME,
        /** 游戏存在但没有声明 world（纯静态游戏，没有服务端世界可启停） */
        NO_WORLD,
        /** 已经在跑了 */
        ALREADY_RUNNING,
        /** 没在跑（stop 时） */
        NOT_RUNNING,
        /** 达到同时启动上限 */
        LIMIT,
        /** 游戏里还有玩家，不停（防房主把好友踢出局） */
        HAS_PLAYERS,
        /** 加载/停止失败（日志里有详情） */
        FAILED
    }

    /** 自带服务端代码的约定位置（相对游戏目录）。 */
    public static final String SERVER_JAR = "server.jar";
    public static final String SERVER_SRC_DIR = "server";
    /** 现场编译产物目录（相对游戏目录），别让源码编译污染游戏文件。 */
    public static final String COMPILED_DIR = ".server-classes";

    private final GameModes modes;
    private final Map<String, GameWorldPlugin> running = new ConcurrentHashMap<>();
    private final Map<String, URLClassLoader> pluginLoaders = new ConcurrentHashMap<>();
    private volatile boolean stopped = false;

    public WorldRegistry(GameModes modes) {
        this.modes = modes;
    }

    /** 服务器启动：把 game.json 里 {@code autostart} 的世界拉起来（失败只日志，不崩）。 */
    public synchronized void startAll() {
        for (GameMode m : modes.list()) {
            if (m.world != null && m.autostart) {
                load(m);
            }
        }
    }

    /** 优雅关闭：停掉所有世界（服务器都要退了，之后不再接受启动）。 */
    public synchronized void stopAll() {
        stopped = true;
        for (GameWorldPlugin w : running.values()) {
            try {
                w.stop();
            } catch (RuntimeException e) {
                System.err.println("[WorldRegistry] 停止世界时异常: " + e);
            }
        }
        running.clear();
        for (URLClassLoader cl : pluginLoaders.values()) {
            closeQuietly(cl);
        }
        pluginLoaders.clear();
    }

    /** 正在跑的世界实例；没启动返回 {@code null}。 */
    public GameWorldPlugin get(String id) {
        return id == null ? null : running.get(id);
    }

    public boolean isRunning(String id) {
        return id != null && running.containsKey(id);
    }

    public int runningCount() {
        return running.size();
    }

    /** 房主启动一个游戏世界。 */
    public synchronized Result start(String id) {
        if (stopped) {
            return Result.FAILED;
        }
        GameMode m = modes.get(id);
        if (m == null) {
            return Result.NO_GAME;
        }
        if (m.world == null) {
            return Result.NO_WORLD;
        }
        if (running.containsKey(id)) {
            return Result.ALREADY_RUNNING;
        }
        if (running.size() >= MAX_RUNNING) {
            return Result.LIMIT;
        }
        return load(m) != null ? Result.OK : Result.FAILED;
    }

    /**
     * 房主停掉一个游戏世界。
     *
     * <p>里面还有在线玩家时拒绝（{@link Result#HAS_PLAYERS}）——好友玩得好好的
     * 被房主一巴掌抹掉太伤；等他们退干净（或空闲超时被标离线）再停。
     * 停掉后世界对象销毁，再启动是一块全新的地图（等同重开）。
     */
    public synchronized Result stop(String id) {
        GameMode m = modes.get(id);
        if (m == null) {
            return Result.NO_GAME;
        }
        if (m.world == null) {
            return Result.NO_WORLD;
        }
        GameWorldPlugin w = running.get(id);
        if (w == null) {
            return Result.NOT_RUNNING;
        }
        if (w.playerCount() > 0) {
            return Result.HAS_PLAYERS;
        }
        try {
            w.stop();
        } catch (RuntimeException e) {
            System.err.println("[WorldRegistry] 停止 " + id + " 时异常: " + e);
            return Result.FAILED;
        }
        running.remove(id);
        unloadPlugin(id);
        System.out.println("[WorldRegistry] 游戏世界已停止: " + id
                + "（当前运行 " + running.size() + "/" + MAX_RUNNING + "）");
        return Result.OK;
    }

    /**
     * 创建世界实例、入表并 start。
     *
     * <p>类的来源见类注释：先看游戏目录自带的 {@code server.jar} / {@code server/*.java}，
     * 都没有才用内核 jar 里的内置类。任何一步失败都只记日志返回 null——
     * 一个坏游戏不该搞崩服务器，也别让启动器列表少一块。
     */
    private GameWorldPlugin load(GameMode m) {
        URLClassLoader plugin = null;
        try {
            plugin = buildPluginLoader(m);
            Class<?> c = plugin == null
                    ? Class.forName(m.world)
                    : Class.forName(m.world, true, plugin);
            GameWorldPlugin w = (GameWorldPlugin) c.getDeclaredConstructor().newInstance();
            if (plugin != null) {
                pluginLoaders.put(m.id, plugin);
                plugin = null;   // 交给 map 管理，别在 finally 里关掉
            }
            running.put(m.id, w);
            w.start();
            System.out.println("[WorldRegistry] 游戏世界已启动: " + m.id + " (" + m.world + ")"
                    + (pluginLoaders.containsKey(m.id) ? " [自带服务端代码]" : " [内核内置]")
                    + "，当前运行 " + running.size() + "/" + MAX_RUNNING);
            return w;
        } catch (Throwable t) {
            System.err.println("[WorldRegistry] 加载 " + m.id + " 的世界类失败: "
                    + m.world + " -> " + t);
            return null;
        } finally {
            if (plugin != null) {
                closeQuietly(plugin);
            }
        }
    }

    // =========================================================
    // 自带服务端代码的加载
    // =========================================================

    /**
     * 给游戏目录里的自带代码建一个类加载器；没有自带代码返回 {@code null}。
     *
     * <p>来源（可同时存在，合并进同一个加载器）：
     * <ul>
     *   <li>{@code <游戏目录>/server.jar}；</li>
     *   <li>{@code <游戏目录>/server/**}/{@code .java} —— 用自带 JDK 现场编译到
     *       {@code .server-classes/} 再加载。源码比 class 新时才重编。</li>
     * </ul>
     */
    private URLClassLoader buildPluginLoader(GameMode m) {
        try {
            Path dir = m.dir;
            List<URL> urls = new ArrayList<>();

            Path jar = dir.resolve(SERVER_JAR);
            if (Files.isRegularFile(jar)) {
                urls.add(jar.toUri().toURL());
            }

            Path srcDir = dir.resolve(SERVER_SRC_DIR);
            if (Files.isDirectory(srcDir)) {
                List<Path> sources = new ArrayList<>();
                try (Stream<Path> st = Files.walk(srcDir)) {
                    st.filter(p -> p.toString().endsWith(".java")).forEach(sources::add);
                }
                if (!sources.isEmpty()) {
                    Path out = dir.resolve(COMPILED_DIR);
                    Files.createDirectories(out);
                    if (needsCompile(sources, out)) {
                        if (compileSources(m, sources, out)) {
                            System.out.println("[WorldRegistry] 已编译 " + m.id
                                    + " 的自带源码: " + sources.size() + " 个 .java");
                        } else {
                            // 编译失败也把产物目录挂上——可能有上一次编好的 class
                            System.err.println("[WorldRegistry] " + m.id
                                    + " 的源码编译失败，尝试用已有产物/内置类");
                        }
                    }
                    urls.add(out.toUri().toURL());
                }
            }

            if (urls.isEmpty()) {
                return null;
            }
            return new URLClassLoader(urls.toArray(new URL[0]), getClass().getClassLoader());
        } catch (Exception e) {
            System.err.println("[WorldRegistry] 准备 " + m.id + " 的自带代码失败: " + e);
            return null;
        }
    }

    /** 源码比现有 class 新（或还没有 class）时才需要重编。 */
    private static boolean needsCompile(List<Path> sources, Path out) {
        try {
            long newestSrc = 0;
            for (Path s : sources) {
                newestSrc = Math.max(newestSrc, Files.getLastModifiedTime(s).toMillis());
            }
            long newestCls = 0;
            if (Files.isDirectory(out)) {
                try (Stream<Path> st = Files.walk(out)) {
                    newestCls = st.filter(p -> p.toString().endsWith(".class"))
                            .mapToLong(p -> {
                                try {
                                    return Files.getLastModifiedTime(p).toMillis();
                                } catch (IOException e) {
                                    return 0;
                                }
                            })
                            .max().orElse(0);
                }
            }
            return newestCls == 0 || newestSrc > newestCls;
        } catch (IOException e) {
            return true;
        }
    }

    /** 用 JDK 自带的编译器把源码编到 out；classpath 带上内核 jar（否则找不到接口）。 */
    private boolean compileSources(GameMode m, List<Path> sources, Path out) {
        JavaCompiler jc = ToolProvider.getSystemJavaCompiler();
        if (jc == null) {
            System.err.println("[WorldRegistry] 当前不是 JDK（没有 javac），"
                    + m.id + " 的自带源码无法编译；请改用 server.jar 或换 JDK 运行");
            return false;
        }
        List<String> args = new ArrayList<>();
        args.add("-d");
        args.add(out.toString());
        args.add("-encoding");
        args.add("UTF-8");
        String cp = mainClasspath();
        if (cp != null && !cp.isEmpty()) {
            args.add("-cp");
            args.add(cp);
        }
        for (Path s : sources) {
            args.add(s.toString());
        }
        int rc = jc.run(null, null, null, args.toArray(new String[0]));
        return rc == 0;
    }

    /** 内核自己所在的 jar / 类目录（编译插件源码时当 classpath）。 */
    private String mainClasspath() {
        try {
            var cs = WorldRegistry.class.getProtectionDomain().getCodeSource();
            if (cs != null && cs.getLocation() != null) {
                return Paths.get(cs.getLocation().toURI()).toString();
            }
        } catch (Exception ignored) {
            // 落到下面的系统属性
        }
        return System.getProperty("java.class.path");
    }

    private void unloadPlugin(String id) {
        URLClassLoader cl = pluginLoaders.remove(id);
        if (cl != null) {
            closeQuietly(cl);
        }
    }

    private static void closeQuietly(URLClassLoader cl) {
        try {
            cl.close();
        } catch (IOException ignored) {
            // 关不掉就算了
        }
    }
}
