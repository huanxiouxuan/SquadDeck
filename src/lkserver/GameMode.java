package lkserver;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * 一个小游戏（游戏模式）的元数据，来自 {@code gamemode/<id>/game.json}。
 *
 * <p>「开黑启动器」是一个多游戏启动器：每个子游戏一个目录，目录里的
 * {@code game.json} 描述它（名字、简介、图标、入口页、接口前缀），
 * 启动器左侧列表读的就是这些；点某个游戏就把 {@code /games/<id>/}
 * 装进右侧窗口（iframe）。
 *
 * <p>游戏自己的网页文件（index.html / js / 素材）也放在同一个目录里，
 * 由 {@code /games/<id>/...} 路由从 {@link #dir} 直接发出。
 */
public final class GameMode {

    /** 目录名 / URL 片段，只能是小写字母、数字、'-'、'_'（保证能当 URL 用）。 */
    public final String id;
    /** 显示名（左侧列表、标题栏用）。 */
    public final String name;
    /** 一句话简介。 */
    public final String desc;
    /** 图标：emoji，或游戏目录下的图片文件名（如 {@code tank.ico}，启动器渲染成 &lt;img&gt;）。 */
    public final String icon;
    /** 入口文件名（相对游戏目录），一般是 index.html。 */
    public final String entry;
    /** 这个游戏用的服务端接口前缀，例如 {@code /api/tank}。 */
    public final String api;
    /**
     * 服务端「游戏世界」类的全限定名（如 {@code lkserver.SnakeWorld}）。
     * {@code null} = 纯静态游戏：没有服务端逻辑，启动器里也没有启停开关。
     */
    public final String world;
    /** 服务器启动时是否自动拉起这个世界（默认关；房主也可在启动器里随时拨开关）。 */
    public final boolean autostart;
    /** 游戏目录（绝对路径）。 */
    public final Path dir;

    GameMode(String id, String name, String desc, String icon, String entry, String api,
             String world, boolean autostart, Path dir) {
        this.id = id;
        this.name = name;
        this.desc = desc;
        this.icon = icon;
        this.entry = entry;
        this.api = api;
        this.world = world;
        this.autostart = autostart;
        this.dir = dir;
    }

    /** 启动器 iframe 加载这个游戏用的地址。 */
    public String entryUrl() {
        return "/games/" + id + "/";
    }

    /**
     * 供 {@code GET /api/games} 下发的 JSON。
     *
     * @param running 这个游戏的服务端世界此刻是否在跑（启动器画开关用）
     */
    public String toJson(boolean running) {
        return "{\"id\":" + Json.quote(id)
                + ",\"name\":" + Json.quote(name)
                + ",\"desc\":" + Json.quote(desc)
                + ",\"icon\":" + Json.quote(icon)
                + ",\"entry\":" + Json.quote(entry)
                + ",\"api\":" + Json.quote(api)
                + ",\"url\":" + Json.quote(entryUrl())
                + ",\"srv\":" + (world != null)
                + ",\"run\":" + running
                + '}';
    }

    /** game.json 的内容（创建新游戏时写出；world/autostart 有才写）。 */
    public String gameJson() {
        StringBuilder b = new StringBuilder();
        b.append("{\n")
                .append("  \"id\": ").append(Json.quote(id)).append(",\n")
                .append("  \"name\": ").append(Json.quote(name)).append(",\n")
                .append("  \"desc\": ").append(Json.quote(desc)).append(",\n")
                .append("  \"icon\": ").append(Json.quote(icon)).append(",\n")
                .append("  \"entry\": ").append(Json.quote(entry)).append(",\n")
                .append("  \"api\": ").append(Json.quote(api));
        if (world != null) {
            b.append(",\n  \"world\": ").append(Json.quote(world));
        }
        if (autostart) {
            b.append(",\n  \"autostart\": true");
        }
        b.append(",\n  \"version\": 1\n}\n");
        return b.toString();
    }

    /**
     * 从游戏目录里读出 {@code game.json}。
     *
     * @return 加载成功返回实例；目录不存在、json 缺失/语法错/没有 id 或 name
     *         时返回 {@code null}（调用方跳过这个目录，不让一个坏游戏搞崩启动器）
     */
    static GameMode load(Path dir) {
        Path json = dir.resolve("game.json");
        if (!Files.isRegularFile(json)) {
            return null;
        }
        try {
            Object root = Json.parse(new String(Files.readAllBytes(json), StandardCharsets.UTF_8));
            if (!(root instanceof java.util.Map)) {
                return null;
            }
            @SuppressWarnings("unchecked")
            java.util.Map<String, Object> m = (java.util.Map<String, Object>) root;
            String id = Json.str(m, "id", null);
            String name = Json.str(m, "name", null);
            if (id == null || id.isEmpty() || name == null || name.isEmpty()) {
                return null;
            }
            if (!isValidId(id)) {
                return null;
            }
            // 入口页不允许穿越目录（会被 /games/<id>/ 路由解析）
            String entry = Json.str(m, "entry", "index.html");
            if (entry.contains("..") || entry.startsWith("/")) {
                entry = "index.html";
            }
            String rawWorld = Json.str(m, "world", null);
            String world = safeWorld(rawWorld);
            if (rawWorld != null && world == null) {
                System.err.println("[GameModes] " + dir.getFileName()
                        + " 的 world 字段不合法，已忽略: " + rawWorld);
            }
            return new GameMode(id, name, Json.str(m, "desc", ""),
                    Json.str(m, "icon", "\uD83C\uDFAE"), entry,
                    Json.str(m, "api", "/api/" + id), world, parseAutostart(m), dir);
        } catch (RuntimeException | java.io.IOException e) {
            System.err.println("[GameModes] 加载 " + dir + " 失败: " + e);
            return null;
        }
    }

    /**
     * 清洗 game.json 的 world 字段：只接受合法的 Java 二进制类名
     * （{@code pkg.Class}，段内字母数字 _ $），≤128 字符；不合法返回 {@code null}。
     *
     * <p>这是反射加载前的第一道闸——类名来自用户手写的 json，
     * 宁可忽略也不让奇怪字符串进 {@code Class.forName}。
     */
    static String safeWorld(String raw) {
        if (raw == null) {
            return null;
        }
        String w = raw.trim();
        if (w.isEmpty() || w.length() > 128 || w.startsWith(".") || w.endsWith(".")
                || w.contains("..")) {
            return null;
        }
        for (int i = 0; i < w.length(); i++) {
            char c = w.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
                    || (c >= '0' && c <= '9') || c == '_' || c == '$' || c == '.';
            if (!ok) {
                return null;
            }
        }
        return w;
    }

    /** game.json 的 autostart：布尔 {@code true}，或字符串 {@code "true"/"1"}（大小写不敏感）。 */
    private static boolean parseAutostart(java.util.Map<String, Object> m) {
        Object v = m.get("autostart");
        if (v instanceof Boolean) {
            return (Boolean) v;
        }
        if (v instanceof String) {
            String s = ((String) v).trim();
            return s.equalsIgnoreCase("true") || s.equals("1");
        }
        return false;
    }

    /** id 只允许 {@code [a-z0-9_-]}（最长 32 字符）——要能当 URL 片段和目录名用。 */
    public static boolean isValidId(String id) {
        if (id == null || id.isEmpty() || id.length() > 32) {
            return false;
        }
        for (int i = 0; i < id.length(); i++) {
            char c = id.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_';
            if (!ok) {
                return false;
            }
        }
        return true;
    }
}
