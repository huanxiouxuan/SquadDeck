package lkserver;

import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * 服务器全局上下文：Web 根目录、404 页面位置、游戏注册表与游戏接口。
 *
 * <p>对应 C++ 版里 {@code main()} 中的 {@code chdir(argv[2])}——但换了一种更安全的方式：
 * Java 不能切换进程工作目录，所以这里保存一个「根目录」的绝对路径，
 * 所有请求路径都相对它解析，并强制校验解析结果仍在根目录内（防目录穿越）。
 *
 * <p>「开黑启动器」版新增了 {@link #modesDir} / {@link #modes}：
 * {@code root} 放启动器页面（www/），{@code modesDir} 放各个小游戏
 * （gamemode/&lt;游戏&gt;/），后者通过 {@code /games/<id>/} 路由发出。
 */
public class ServerContext {

    /** Web 根目录（绝对、已规范化）——启动器页面所在目录。 */
    public final Path root;

    /** 根目录下的 404.html，与原版一致：展示目录里必须放这个文件。 */
    public final Path notFoundPage;

    /** 小游戏目录（绝对、已规范化）：每个子目录一个游戏。 */
    public final Path modesDir;

    /** 游戏注册表（启动时扫描 {@link #modesDir}）。 */
    public final GameModes modes;

    /** 游戏 HTTP 接口。 */
    public final GameApi game;

    public ServerContext(String rootDir, GameModes modes, GameApi game) {
        this.root = Paths.get(rootDir).toAbsolutePath().normalize();
        this.notFoundPage = this.root.resolve("404.html");
        this.modes = modes;
        this.modesDir = modes.dir();
        this.game = game;
    }

    /** 把绝对路径转换成相对根目录的展示路径（正斜杠，根目录本身为 ""）。 */
    public String displayPath(Path p) {
        return root.relativize(p).toString().replace('\\', '/');
    }
}
