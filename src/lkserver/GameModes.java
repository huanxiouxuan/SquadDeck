package lkserver;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 游戏注册表：扫描 {@code gamemode/} 目录、列出全部游戏、创建新游戏。
 *
 * <p>目录结构约定（「开黑启动器」多游戏方案）：
 * <pre>
 *   lkserver2-game/
 *     gamemode/
 *       tank/            ← 一个游戏一个目录
 *         game.json      ← 元数据（id/name/desc/icon/entry/api）
 *         index.html     ← 入口页（entry 指向它）
 *         game.js ...    ← 游戏自己的文件，随目录一起 served
 *       &lt;你的新游戏&gt;/ ...
 *     www/               ← 启动器本身（左侧列表 + iframe）
 * </pre>
 *
 * <p>游戏文件通过 {@code /games/<id>/<文件>} 路由发出，入口页是
 * {@code /games/<id>/}。服务端接口由各游戏在 game.json 的 {@code api}
 * 字段声明（坦克是 {@code /api/tank}），在 {@link GameApi} 里对应实现。
 */
public final class GameModes {

    private final Path dir;
    private final Map<String, GameMode> games = new LinkedHashMap<>();

    public GameModes(Path dir) {
        this.dir = dir.toAbsolutePath().normalize();
        rescan();
    }

    /** gamemode 目录（可能不存在——不存在就是「还没有任何游戏」）。 */
    public Path dir() {
        return dir;
    }

    /** 重新扫描目录。启动时调一次；创建新游戏后也会再调。 */
    public synchronized void rescan() {
        games.clear();
        if (!Files.isDirectory(dir)) {
            return;
        }
        List<Path> subs = new ArrayList<>();
        try (java.util.stream.Stream<Path> s = Files.list(dir)) {
            s.filter(Files::isDirectory).forEach(subs::add);
        } catch (IOException e) {
            System.err.println("[GameModes] 扫描 " + dir + " 失败: " + e);
            return;
        }
        subs.sort((a, b) -> a.getFileName().toString().compareToIgnoreCase(b.getFileName().toString()));
        for (Path sub : subs) {
            GameMode m = GameMode.load(sub);
            if (m != null) {
                games.put(m.id, m);
            }
        }
    }

    /**
     * 删除一个小游戏：把 {@code gamemode/<id>/} 整个目录删掉。
     *
     * <p>防穿越双保险：id 先过 {@link GameMode#isValidId}（挡掉 {@code ..}、
     * 路径分隔符之类），删之前再校验目标的父目录就是 gamemode 本身——
     * 「浏览器传个 id 上来就删目录」这种接口最容易出事，宁可多查一遍。
     *
     * <p>调用方（{@link GameApi}）负责先把这个游戏的服务端世界停掉；
     * 本方法只管磁盘。
     *
     * @return {@code true} 删掉了；{@code false} 本来就不存在
     * @throws IllegalArgumentException id 非法 / 目标不在 gamemode 下
     * @throws IllegalStateException    删除失败（文件被占用等）
     */
    public synchronized boolean delete(String id) {
        if (!GameMode.isValidId(id)) {
            throw new IllegalArgumentException("非法的游戏 id");
        }
        GameMode m = games.get(id);
        Path target = (m != null ? m.dir : dir.resolve(id)).toAbsolutePath().normalize();
        if (target.getParent() == null || !target.getParent().equals(dir)) {
            throw new IllegalArgumentException("只能删除 gamemode 下的游戏目录");
        }
        if (!Files.exists(target)) {
            games.remove(id);
            return false;
        }
        try {
            deleteTree(target);
        } catch (IOException e) {
            throw new IllegalStateException("删除失败（可能有文件被占用）: " + e.getMessage(), e);
        }
        games.remove(id);
        System.out.println("[GameModes] 已删除游戏: " + id + "（" + target + "）");
        return true;
    }

    /** 递归删除整棵目录树（从最深的文件往上删）。 */
    private static void deleteTree(Path root) throws IOException {
        if (!Files.exists(root)) {
            return;
        }
        List<Path> all = new ArrayList<>();
        try (java.util.stream.Stream<Path> s = Files.walk(root)) {
            s.forEach(all::add);
        }
        for (int i = all.size() - 1; i >= 0; i--) {
            Files.deleteIfExists(all.get(i));
        }
    }

    /** 全部游戏（按目录名排序）。 */
    public synchronized List<GameMode> list() {
        return new ArrayList<>(games.values());
    }

    public synchronized GameMode get(String id) {
        return id == null ? null : games.get(id);
    }

    public synchronized int size() {
        return games.size();
    }

    /**
     * 创建新游戏：建目录、写 game.json、放一个占位入口页。
     *
     * @param rawName 游戏名（必填，≤12 字符，过滤危险字符）
     * @param rawDesc 简介（可空，≤60 字符）
     * @return 新游戏的元数据
     * @throws IllegalArgumentException 名字为空/不合法，或生成 id 冲突时
     */
    public synchronized GameMode create(String rawName, String rawDesc) {
        String name = sanitize(rawName, 12);
        if (name.isEmpty()) {
            throw new IllegalArgumentException("游戏名不能为空");
        }
        String desc = sanitize(rawDesc, 60);

        // id 用「g + 时间戳 base36」自动生成，保证唯一且只含 URL 安全字符
        String id;
        int guard = 0;
        do {
            id = "g" + Long.toString(System.currentTimeMillis(), 36);
            guard++;
            if (guard > 100) {
                throw new IllegalStateException("生成游戏 id 失败");
            }
        } while (games.containsKey(id) || Files.exists(dir.resolve(id)));

        Path gameDir = dir.resolve(id);
        try {
            Files.createDirectories(gameDir);
            GameMode mode = new GameMode(id, name, desc, "\uD83C\uDFAE", "index.html",
                    "/api/" + id, null, false, gameDir);
            Files.write(gameDir.resolve("game.json"),
                    mode.gameJson().getBytes(StandardCharsets.UTF_8));
            Files.write(gameDir.resolve("index.html"),
                    scaffoldHtml(name, id).getBytes(StandardCharsets.UTF_8));
            games.put(id, mode);
            return mode;
        } catch (IOException e) {
            throw new IllegalStateException("创建游戏目录失败: " + e.getMessage(), e);
        }
    }

    // =========================================================
    // 导入游戏：把用户在任意磁盘选的文件夹复制进 gamemode/
    // =========================================================

    /** 单个文件大小上限（与 HttpParser.MAX_BODY_SIZE 一致，超过根本发不过来）。 */
    public static final int MAX_IMPORT_FILE = 32 * 1024 * 1024;

    /** 一次导入的文件总数上限（防失误/恶意的超大清单）。 */
    public static final int MAX_IMPORT_FILES = 2000;

    /** 一次导入的总体积上限。 */
    public static final long MAX_IMPORT_TOTAL = 512L * 1024 * 1024;

    /**
     * 开始一次导入：建目录、写 game.json，返回新游戏元数据。
     * 文件本身由随后的 {@code POST /api/games/upload} 逐个写入。
     *
     * @param rawName   游戏名（必填，≤12 字符）
     * @param rawDesc   简介（可空，≤60 字符）
     * @param rawIcon   图标 emoji（可空，默认 🎮）
     * @param rawEntry  入口文件名（可空，默认 index.html；通常来自被导入文件夹的 game.json）
     * @param rawApi    接口前缀（可空，默认 {@code /api/<id>}；同样来自 game.json）
     * @param rawWorld  服务端世界类全限定名（可空；联机游戏才有，见 {@link WorldRegistry}）
     * @param rawAutostart 是否随服务器自动启动该世界（默认 false，房主可在启动器里拨开关）
     * @param manifest  文件清单 {@code [{p: 相对路径, s: 字节数}]}，用于事前校验、
     *                  并决定要不要补一个占位入口页
     * @throws IllegalArgumentException 名字为空 / 清单里有非法路径 / 超限
     * @throws IllegalStateException    建目录或写盘失败
     */
    public synchronized GameMode createImport(String rawName, String rawDesc, String rawIcon,
                                              String rawEntry, String rawApi,
                                              String rawWorld, boolean rawAutostart,
                                              List<Map<String, Object>> manifest) {
        String name = sanitize(rawName, 12);
        if (name.isEmpty()) {
            throw new IllegalArgumentException("游戏名不能为空");
        }
        String desc = sanitize(rawDesc, 60);
        String icon = sanitizeIcon(rawIcon);
        String entry = safeEntry(rawEntry);
        String api = safeApi(rawApi);   // 为 null 时下面用默认值补

        // ---- 清单校验：动磁盘之前把问题全查出来 ----
        if (manifest == null) {
            manifest = new ArrayList<>();
        }
        if (manifest.size() > MAX_IMPORT_FILES) {
            throw new IllegalArgumentException("文件太多（" + manifest.size()
                    + " > " + MAX_IMPORT_FILES + "），请分几次导入或改用资源管理器复制");
        }
        long total = 0;
        Set<String> seen = new HashSet<>();
        boolean hasEntry = false;
        for (Object o : manifest) {
            if (!(o instanceof Map)) {
                throw new IllegalArgumentException("文件清单格式不对");
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> f = (Map<String, Object>) o;
            Object pObj = f.get("p");
            String p = pObj instanceof String ? (String) pObj : null;
            if (!validRelPath(p)) {
                throw new IllegalArgumentException("非法文件路径: " + p);
            }
            if (!seen.add(p)) {
                throw new IllegalArgumentException("重复的文件路径: " + p);
            }
            Object sObj = f.get("s");
            if (!(sObj instanceof Number)) {
                throw new IllegalArgumentException("文件没有大小: " + p);
            }
            double s = ((Number) sObj).doubleValue();
            if (s < 0 || s > MAX_IMPORT_FILE) {
                throw new IllegalArgumentException("文件大小超过 " + (MAX_IMPORT_FILE / 1024 / 1024)
                        + "MB 上限: " + p);
            }
            total += (long) s;
            if (p.equals(entry)) {
                hasEntry = true;
            }
        }
        if (total > MAX_IMPORT_TOTAL) {
            throw new IllegalArgumentException("总体积超过 " + (MAX_IMPORT_TOTAL / 1024 / 1024) + "MB 上限");
        }

        // ---- 生成 id（每次导入都发新号：重复导入同一文件夹会得到不同副本）----
        String id;
        int guard = 0;
        do {
            id = "g" + Long.toString(System.currentTimeMillis(), 36);
            guard++;
            if (guard > 100) {
                throw new IllegalStateException("生成游戏 id 失败");
            }
        } while (games.containsKey(id) || Files.exists(dir.resolve(id)));

        if (api == null) {
            api = "/api/" + id;
        }

        Path gameDir = dir.resolve(id);
        try {
            Files.createDirectories(gameDir);
            GameMode mode = new GameMode(id, name, desc, icon, entry, api,
                    GameMode.safeWorld(rawWorld), rawAutostart, gameDir);
            Files.write(gameDir.resolve("game.json"),
                    mode.gameJson().getBytes(StandardCharsets.UTF_8));
            // 清单里没有入口页 -> 补个占位页，否则点进去只会 404
            if (!hasEntry) {
                Files.write(gameDir.resolve("index.html"),
                        scaffoldHtml(name, id).getBytes(StandardCharsets.UTF_8));
            }
            games.put(id, mode);
            return mode;
        } catch (IOException e) {
            throw new IllegalStateException("创建游戏目录失败: " + e.getMessage(), e);
        }
    }

    /**
     * 写入导入文件中的一个文件（HTTP 请求体就是文件字节）。
     *
     * @throws IllegalArgumentException 路径非法（穿越/绝对/空/超限）或内容为空
     * @throws IllegalStateException    写盘失败
     */
    public void upload(GameMode mode, String relPath, byte[] data) {
        if (mode == null) {
            throw new IllegalArgumentException("游戏不存在");
        }
        if (!validRelPath(relPath)) {
            throw new IllegalArgumentException("非法文件路径: " + relPath);
        }
        if (data == null || data.length == 0) {
            throw new IllegalArgumentException("文件内容为空");
        }
        if (data.length > MAX_IMPORT_FILE) {
            throw new IllegalArgumentException("文件超过 " + (MAX_IMPORT_FILE / 1024 / 1024) + "MB 上限");
        }
        Path target = mode.dir.resolve(relPath).normalize();
        if (!target.startsWith(mode.dir)) {
            throw new IllegalArgumentException("非法文件路径: " + relPath);
        }
        try {
            if (target.getParent() != null) {
                Files.createDirectories(target.getParent());
            }
            Files.write(target, data);
        } catch (IOException e) {
            throw new IllegalStateException("写入文件失败: " + e.getMessage(), e);
        }
    }

    /**
     * 校验导入用的相对路径：非空、≤240 字符、只用 '/' 分层、每一段都不是
     * "." / ".." / 空、不含 '\\' ':' 和控制字符。
     *
     * <p>通过的路径在 {@link #upload} 里还会再做一次
     * {@code normalize + startsWith(游戏目录)} 双保险——目录穿越是这类
     * "浏览器传路径上来"的接口最危险的漏洞，宁可多查一遍。
     */
    static boolean validRelPath(String p) {
        if (p == null || p.isEmpty() || p.length() > 240) {
            return false;
        }
        if (p.charAt(0) == '/' || p.contains("\\") || p.contains(":")) {
            return false;
        }
        for (int i = 0; i < p.length(); i++) {
            char c = p.charAt(i);
            if (c < 0x20 || c == 0x7f) {
                return false;
            }
        }
        for (String seg : p.split("/")) {
            if (seg.isEmpty() || seg.equals(".") || seg.equals("..")) {
                return false;
            }
        }
        return true;
    }

    /** 入口页清洗：防穿越，默认 index.html（与 {@link GameMode#load} 同一套规则）。 */
    private static String safeEntry(String raw) {
        if (raw == null) {
            return "index.html";
        }
        String e = raw.trim();
        if (e.isEmpty() || e.contains("..") || e.startsWith("/") || e.contains("\\")
                || e.length() > 120) {
            return "index.html";
        }
        return e;
    }

    /** 接口前缀清洗：必须 '/' 开头、不穿越、≤64 字符；不合法返回 null（调用方补默认值）。 */
    private static String safeApi(String raw) {
        if (raw == null) {
            return null;
        }
        String a = raw.trim();
        if (a.isEmpty() || !a.startsWith("/") || a.contains("..") || a.contains("\\")
                || a.length() > 64) {
            return null;
        }
        for (int i = 0; i < a.length(); i++) {
            if (a.charAt(i) < 0x20) {
                return null;
            }
        }
        return a;
    }

    /** 图标清洗：emoji 一般一两个字符，限 8 字符并去掉危险字符，默认 🎮。 */
    private static String sanitizeIcon(String raw) {
        String s = sanitize(raw, 8);
        return s.isEmpty() ? "\uD83C\uDFAE" : s;
    }

    /** 新游戏的占位入口页：告诉用户把文件放哪、怎么声明接口。 */
    private static String scaffoldHtml(String name, String id) {
        return """
                <!DOCTYPE html>
                <html lang="zh-CN">
                <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <title>__NAME__ · 施工中</title>
                <style>
                  body { margin: 0; min-height: 100vh; display: flex; align-items: center;
                         justify-content: center; background: #0b0f18; color: #e8eefc;
                         font-family: "Segoe UI", "Microsoft YaHei", sans-serif; }
                  .card { max-width: 560px; margin: 20px; padding: 30px 34px; text-align: center;
                          background: rgba(255,255,255,.045); border: 1px solid rgba(255,255,255,.1);
                          border-radius: 16px; }
                  h1 { font-size: 22px; margin: 0 0 14px; font-weight: 600; }
                  p { font-size: 13px; color: #93a4c4; line-height: 2; margin: 4px 0; }
                  code { background: rgba(255,255,255,.09); padding: 2px 8px; border-radius: 6px;
                          font-family: Consolas, monospace; color: #ffd166; font-size: 12px; }
                </style>
                </head>
                <body>
                  <div class="card">
                    <h1>🎮 __NAME__</h1>
                    <p>这个游戏还没开工，本页是自动生成的占位页。</p>
                    <p>把你的网页文件（index.html / .js / 图片音效）放进<br>
                       <code>gamemode/__ID__/</code> 目录，覆盖这个 index.html；</p>
                    <p>想改名字/简介/图标就编辑同目录下的 <code>game.json</code>；</p>
                    <p>要有自己的服务端接口（联机游戏）：在 <code>src/lkserver/</code> 写一个实现<br>
                       <code>GameWorldPlugin</code> 的世界类，在 <code>game.json</code> 里加<br>
                       <code>"world": "类全名"</code>（想开机自启再加 <code>"autostart": true</code>）；<br>
                       不用改服务器内核，房主在启动器里用开关控制启停。</p>
                  </div>
                </body>
                </html>
                """.replace("__NAME__", name).replace("__ID__", id);
    }

    /** 昵称式清洗：限长 + 去掉危险字符（与 GameWorld.sanitizeName 同一套思路）。 */
    private static String sanitize(String raw, int maxLen) {
        if (raw == null) {
            return "";
        }
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < raw.length() && b.length() < maxLen; i++) {
            char c = raw.charAt(i);
            if (c >= 0x20 && c != '<' && c != '>' && c != '&' && c != '"' && c != '\\') {
                b.append(c);
            }
        }
        return b.toString().trim();
    }
}
