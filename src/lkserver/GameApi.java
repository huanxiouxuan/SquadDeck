package lkserver;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * HTTP 接口层：把 {@link HttpRequest} 翻译成对 {@link WorldRegistry}（联机游戏世界）、
 * {@link GameModes}（启动器游戏清单）的调用，再把结果包成 JSON 响应。
 *
 * <p>接口一览（由 {@code TcpConnection} 路由过来）：
 * <table border="1">
 *   <tr><th>方法</th><th>路径</th><th>参数</th><th>作用</th></tr>
 *   <tr><td>GET</td><td>/api/games</td><td>-</td>
 *       <td>启动器：全部小游戏列表。每个游戏带 {@code srv}（有没有服务端世界）、
 *           {@code run}（世界是否在跑）；顶层 {@code host} = 你是不是房主</td></tr>
 *   <tr><td>POST</td><td>/api/games</td><td>name, desc</td>
 *       <td>启动器：创建空壳游戏（生成目录 + game.json + 占位页；界面导入流程已不再走这里）</td></tr>
 *   <tr><td>POST</td><td>/api/games/import</td><td>JSON: name, desc, icon, entry, api, world, autostart, files[]</td>
 *       <td>启动器：从文件夹导入游戏第一步——建目录、写 game.json（文件清单在这里事前校验）</td></tr>
 *   <tr><td>POST</td><td>/api/games/upload</td><td>查询串: game, path；请求体 = 文件字节</td>
 *       <td>启动器：导入第二步——把每个文件写进游戏目录（application/octet-stream）</td></tr>
 *   <tr><td>POST</td><td>/api/games/&lt;id&gt;/start</td><td>-</td>
 *       <td><b>房主专属</b>：启动一个游戏世界（受 {@link WorldRegistry#MAX_RUNNING} 上限约束）</td></tr>
 *   <tr><td>POST</td><td>/api/games/&lt;id&gt;/stop</td><td>-</td>
 *       <td><b>房主专属</b>：停掉一个游戏世界（里面还有玩家时拒绝）</td></tr>
 *   <tr><td>POST</td><td>/api/games/&lt;id&gt;/delete</td><td>-</td>
 *       <td><b>房主专属</b>：删除一个游戏——先停掉它的世界（里面还有玩家时拒绝），
 *           再连同 {@code gamemode/&lt;id&gt;/} 整个目录一起删掉（不可恢复）</td></tr>
 *   <tr><td>POST</td><td>/api/&lt;游戏id&gt;/join</td><td>name, cid</td>
 *       <td>联机游戏：加入游戏，返回玩家 id 与世界参数；带 cid 时同身份重连复用旧号。
 *           世界没启动返回 409</td></tr>
 *   <tr><td>POST</td><td>/api/&lt;游戏id&gt;/sync</td><td>id + 各游戏自定义输入</td>
 *       <td>联机游戏：上报输入<b>并</b>取回世界快照——一次往返搞定（输入参数由各游戏自己定义）</td></tr>
 *   <tr><td>POST</td><td>/api/&lt;游戏id&gt;/leave</td><td>id</td><td>联机游戏：主动退出</td></tr>
 *   <tr><td>GET</td><td>/api/&lt;游戏id&gt;/info</td><td>-</td><td>联机游戏：在线人数、地图尺寸等</td></tr>
 *   <tr><td>GET</td><td>/api/chat</td><td>after</td>
 *       <td><b>启动器公共频道</b>（与游戏无关）：拉取聊天/表情消息——{@code after} 之后的
 *           增量，缺省回看最近若干条。底栏的表情按钮和聊天框都走这里，全服一个房间，
 *           不经过任何游戏的协议</td></tr>
 *   <tr><td>POST</td><td>/api/chat</td><td>JSON: name, text</td>
 *       <td><b>启动器公共频道</b>：发一条消息（名字/文本按长度截断），返回分配的 id</td></tr>
 *   <tr><td>GET</td><td>/api/net</td><td>-</td><td>本机可分享给别人的地址</td></tr>
 * </table>
 *
 * <h3>联机游戏的路由是「通用」的</h3>
 * {@code /api/<id>/join|sync|leave|info} 四个动作为所有联机游戏共用，本类不区分
 * 坦克还是贪吃蛇——按 id 去 {@link WorldRegistry} 找世界实例。取不到时分两种情况：
 * 游戏存在但没启动 → 409；游戏不存在或没有服务端 → 404。
 * 世界类在 game.json 的 {@code world} 字段声明（如 {@code "lkserver.SnakeWorld"}），
 * 由注册表反射加载：<b>新增联机游戏不用改本文件</b>。
 *
 * <p>为什么把「输入」和「状态」合并成一个 sync：射击游戏需要高频往返（约 25~30Hz）。
 * 拆成两个请求等于请求数翻倍，而且输入与状态不同步；合并后每帧只有一次往返，延迟也更小。
 *
 * <h3>「房主」是谁</h3>
 * 请求来源 IP 是回环地址（127.0.0.1 / ::1）或本机某张网卡的地址——即开服务器那台电脑
 * 自己（房主用 127.0.0.1 或自己的局域网/热点地址打开都算）。好友从别的电脑连进来
 * 只能看列表、进游戏，启停开关拨不动（403）。这不是鉴权系统，只是「谁开的服务器谁管」
 * 的轻量约定——真要多房东主可以以后再加强。
 *
 * <p>参数既可以从查询串取，也可以从 {@code application/x-www-form-urlencoded}
 * 的请求体取。
 */
public final class GameApi {

    /** 一个可以直接交给连接层发送的响应。 */
    public static final class Response {
        public final int status;
        public final String descr;
        public final String type;
        public final byte[] body;

        Response(int status, String descr, String type, byte[] body) {
            this.status = status;
            this.descr = descr;
            this.type = type;
            this.body = body;
        }
    }

    private static final String JSON = "application/json; charset=utf-8";
    private static final String API_PREFIX = "/api/";
    private static final String GAMES_PREFIX = "/api/games/";

    private final WorldRegistry worlds;
    private final GameModes modes;
    private final ChatRooms chat;
    private final int port;

    public GameApi(WorldRegistry worlds, int port, GameModes modes) {
        this.worlds = worlds;
        this.port = port;
        this.modes = modes;
        this.chat = new ChatRooms();
    }

    /** 处理一个 /api/* 请求。 */
    public Response handle(HttpRequest req) {
        Map<String, String> q = params(req);
        String path = req.path;

        // ---- 启动器：游戏清单 ----
        // 每次先重扫目录：用户在资源管理器里手动增删游戏文件夹后，
        // 刷新一下启动器页面就能看到变化，不必重启服务器。
        if (path.equals("/api/games") && req.method.equalsIgnoreCase("GET")) {
            modes.rescan();
            StringBuilder sb = new StringBuilder("{\"host\":").append(isHost(req)).append(",\"games\":[");
            boolean first = true;
            for (GameMode m : modes.list()) {
                if (!first) {
                    sb.append(',');
                }
                first = false;
                sb.append(m.toJson(worlds.isRunning(m.id)));
            }
            sb.append("]}");
            return json(200, sb.toString());
        }

        if (path.equals("/api/games") && req.method.equalsIgnoreCase("POST")) {
            try {
                GameMode m = modes.create(q.get("name"), q.get("desc"));
                return json(200, "{\"ok\":true,\"game\":" + m.toJson(worlds.isRunning(m.id)) + "}");
            } catch (IllegalArgumentException e) {
                return json(400, "{\"error\":" + Json.quote(e.getMessage()) + "}");
            } catch (IllegalStateException e) {
                return json(500, "{\"error\":" + Json.quote(e.getMessage()) + "}");
            }
        }

        // ---- 启动器：从文件夹导入游戏（两步走）----
        // 第一步：import 只传元数据和文件清单，建好目录、写好 game.json；
        // 第二步：upload 把每个文件的字节写进去（请求体是二进制，
        //          所以参数只从查询串取，绝不能当表单解析）。
        if (path.equals("/api/games/import") && req.method.equalsIgnoreCase("POST")) {
            if (req.body == null || req.body.length == 0) {
                return json(400, "{\"error\":\"请求体为空\"}");
            }
            try {
                Object root = Json.parse(new String(req.body, StandardCharsets.UTF_8));
                if (!(root instanceof Map)) {
                    return json(400, "{\"error\":\"请求体必须是一个 JSON 对象\"}");
                }
                @SuppressWarnings("unchecked")
                Map<String, Object> m = (Map<String, Object>) root;
                List<Map<String, Object>> files = new ArrayList<>();
                Object filesObj = m.get("files");
                if (filesObj instanceof List) {
                    for (Object o : (List<?>) filesObj) {
                        if (o instanceof Map) {
                            @SuppressWarnings("unchecked")
                            Map<String, Object> f = (Map<String, Object>) o;
                            files.add(f);
                        }
                    }
                }
                GameMode mode = modes.createImport(
                        Json.str(m, "name", null), Json.str(m, "desc", null),
                        Json.str(m, "icon", null), Json.str(m, "entry", null),
                        Json.str(m, "api", null), Json.str(m, "world", null),
                        importAutostart(m), files);
                return json(200, "{\"ok\":true,\"game\":" + mode.toJson(false) + "}");
            } catch (IllegalArgumentException e) {
                return json(400, "{\"error\":" + Json.quote(e.getMessage()) + "}");
            } catch (IllegalStateException e) {
                return json(500, "{\"error\":" + Json.quote(e.getMessage()) + "}");
            } catch (RuntimeException e) {
                return json(400, "{\"error\":" + Json.quote("JSON 解析失败: " + e.getMessage()) + "}");
            }
        }

        if (path.equals("/api/games/upload") && req.method.equalsIgnoreCase("POST")) {
            Map<String, String> qq = queryParams(req);
            GameMode mode = modes.get(qq.get("game"));
            if (mode == null) {
                return json(404, "{\"error\":\"没有这个游戏\"}");
            }
            try {
                modes.upload(mode, qq.get("path"), req.body);
                return json(200, "{\"ok\":true,\"path\":" + Json.quote(qq.get("path")) + "}");
            } catch (IllegalArgumentException e) {
                return json(400, "{\"error\":" + Json.quote(e.getMessage()) + "}");
            } catch (IllegalStateException e) {
                return json(500, "{\"error\":" + Json.quote(e.getMessage()) + "}");
            }
        }

        // ---- 房主启停游戏世界：/api/games/<id>/start|stop ----
        // 启动器每个游戏按钮右侧的上下滑动开关就打这两个接口。
        if (path.startsWith(GAMES_PREFIX)) {
            String rest = path.substring(GAMES_PREFIX.length());
            int slash = rest.indexOf('/');
            if (slash > 0 && slash < rest.length() - 1) {
                String gid = rest.substring(0, slash);
                String action = rest.substring(slash + 1);
                if (action.equals("start") || action.equals("stop") || action.equals("delete")) {
                    if (!req.method.equalsIgnoreCase("POST")) {
                        return json(405, "{\"error\":\"请用 POST 方法\"}");
                    }
                    if (!isHost(req)) {
                        return json(403, "{\"error\":\""
                                + (action.equals("delete") ? "只有房主可以删除游戏" : "只有房主可以启停游戏")
                                + "\"}");
                    }
                    if (action.equals("delete")) {
                        return deleteGame(gid);
                    }
                    boolean starting = action.equals("start");
                    WorldRegistry.Result r = starting ? worlds.start(gid) : worlds.stop(gid);
                    return switchResult(r, gid, starting);
                }
            }
        }

        // ---- 启动器公共聊天频道：/api/chat（与游戏无关，全服一个房间）----
        // 底栏的表情按钮和聊天框都打这里。刻意不走任何游戏的协议：游戏没启动、
        // 没选游戏都能聊；切游戏不清记录。路径 /api/chat 不带斜杠，不会和
        // 下面的 /api/<游戏id>/<动作> 通用分发撞车。
        if (path.equals("/api/chat") && req.method.equalsIgnoreCase("GET")) {
            long after = 0;
            String afterStr = q.get("after");
            if (afterStr != null) {
                try {
                    after = Long.parseLong(afterStr);
                } catch (NumberFormatException e) {
                    after = 0;   // 非法值按缺省处理：回看最近若干条
                }
            }
            StringBuilder sb = new StringBuilder("{\"msgs\":[");
            boolean first = true;
            for (ChatRooms.Msg m : chat.recent(after)) {
                if (!first) {
                    sb.append(',');
                }
                first = false;
                sb.append("{\"id\":").append(m.id)
                        .append(",\"name\":").append(Json.quote(m.name))
                        .append(",\"text\":").append(Json.quote(m.text))
                        .append(",\"t\":").append(m.t).append('}');
            }
            sb.append("]}");
            return json(200, sb.toString());
        }

        if (path.equals("/api/chat") && req.method.equalsIgnoreCase("POST")) {
            if (req.body == null || req.body.length == 0) {
                return json(400, "{\"error\":\"请求体为空\"}");
            }
            try {
                Object root = Json.parse(new String(req.body, StandardCharsets.UTF_8));
                if (!(root instanceof Map)) {
                    return json(400, "{\"error\":\"请求体必须是一个 JSON 对象\"}");
                }
                @SuppressWarnings("unchecked")
                Map<String, Object> m = (Map<String, Object>) root;
                ChatRooms.Msg msg = chat.post(Json.str(m, "name", null), Json.str(m, "text", null));
                if (msg == null) {
                    return json(400, "{\"error\":\"消息内容为空\"}");
                }
                return json(200, "{\"ok\":true,\"id\":" + msg.id + "}");
            } catch (RuntimeException e) {
                return json(400, "{\"error\":" + Json.quote("JSON 解析失败: " + e.getMessage()) + "}");
            }
        }

        // ---- 联机游戏通用分发：/api/<游戏id>/<动作> ----
        // 四个动作为所有联机游戏共用；世界实例按 id 从注册表取。
        // 取不到时分两种情况：游戏存在但没启动 -> 409；
        // 游戏不存在 / 没有服务端世界 -> 落到最后的 404。
        if (path.startsWith(API_PREFIX) && path.length() > API_PREFIX.length()) {
            String rest = path.substring(API_PREFIX.length());
            int slash = rest.indexOf('/');
            if (slash > 0 && slash < rest.length() - 1) {
                String gid = rest.substring(0, slash);
                String action = rest.substring(slash + 1);
                GameWorldPlugin w = worlds.get(gid);
                if (w == null) {
                    GameMode m = modes.get(gid);
                    if (m != null && m.world != null) {
                        return json(409, "{\"error\":\"游戏未启动，房主可在启动器里拨开关开启\"}");
                    }
                } else {
                    switch (action) {
                        case "join": {
                            String body = w.join(q.get("name"), q.get("cid"));
                            return body == null
                                    ? json(500, "{\"error\":\"加入游戏失败\"}")
                                    : json(200, body);
                        }
                        case "sync": {
                            String id = q.get("id");
                            if (id == null) {
                                return json(400, "{\"error\":\"缺少 id 参数\"}");
                            }
                            String body = w.sync(id, q);
                            return body == null
                                    ? json(500, "{\"error\":\"同步失败\"}")
                                    : json(200, body);
                        }
                        case "leave":
                            w.leave(q.get("id"));
                            return json(200, "{\"ok\":true}");
                        case "info":
                            return json(200, w.info());
                        default:
                            break;   // 不认识的子路径，落到 404
                    }
                }
            }
        }

        if (path.equals("/api/net")) {
            StringBuilder sb = new StringBuilder("{\"port\":").append(port).append(",\"addrs\":[");
            boolean first = true;
            for (NetInfo.Addr a : NetInfo.shareAddresses()) {
                if (!first) {
                    sb.append(',');
                }
                first = false;
                sb.append("{\"label\":").append(Json.quote(a.label))
                        .append(",\"ip\":").append(Json.quote(a.ip))
                        .append(",\"url\":").append(Json.quote(a.url(port)))
                        .append('}');
            }
            sb.append("]}");
            return json(200, sb.toString());
        }

        return json(404, "{\"error\":\"没有这个接口\"}");
    }

    /** 房主启停的结果 -> HTTP 响应（409 带上原因，前端直接 toast 给用户看）。 */
    private static Response switchResult(WorldRegistry.Result r, String id, boolean starting) {
        switch (r) {
            case OK:
                return json(200, "{\"ok\":true,\"id\":" + Json.quote(id)
                        + ",\"run\":" + starting + "}");
            case NO_GAME:
            case NO_WORLD:
                return json(404, "{\"error\":" + Json.quote("没有这个游戏: " + id) + "}");
            case ALREADY_RUNNING:
                return json(409, "{\"error\":\"已经在运行了\"}");
            case NOT_RUNNING:
                return json(409, "{\"error\":\"还没有在运行\"}");
            case LIMIT:
                return json(409, "{\"error\":\"同时启动的游戏太多了（上限 "
                        + WorldRegistry.MAX_RUNNING + " 个）\"}");
            case HAS_PLAYERS:
                return json(409, "{\"error\":\"游戏里还有玩家，请先让他们退出\"}");
            default:
                return json(500, "{\"error\":" + Json.quote(
                        (starting ? "启动 " : "停止 ") + id + " 失败") + "}");
        }
    }

    /**
     * 删除一个游戏：先把在跑的世界停掉（里面还有玩家则拒绝），再删掉整个目录。
     *
     * <p>「有玩家就拒绝删除」是刻意的——好友玩到一半，房主一个删除把人机一起
     * 抹掉太伤；先让他们退，或者等离线超时（世界没人了再删）。
     */
    private Response deleteGame(String id) {
        GameMode m = modes.get(id);
        if (m == null) {
            return json(404, "{\"error\":\"没有这个游戏\"}");
        }
        if (worlds.isRunning(id)) {
            WorldRegistry.Result r = worlds.stop(id);
            if (r != WorldRegistry.Result.OK) {
                return switchResult(r, id, false);   // HAS_PLAYERS -> 409 等
            }
        }
        try {
            boolean existed = modes.delete(id);
            return existed
                    ? json(200, "{\"ok\":true,\"id\":" + Json.quote(id) + "}")
                    : json(404, "{\"error\":\"没有这个游戏\"}");
        } catch (IllegalArgumentException e) {
            return json(400, "{\"error\":" + Json.quote(e.getMessage()) + "}");
        } catch (IllegalStateException e) {
            return json(500, "{\"error\":" + Json.quote(e.getMessage()) + "}");
        }
    }

    /**
     * 是不是房主（开服务器那台电脑）发来的请求：来源 IP 是回环地址，
     * 或本机某张网卡的地址。房主用 127.0.0.1 或自己的局域网/热点地址打开都算；
     * 好友从别的电脑连进来不算。
     */
    private static boolean isHost(HttpRequest req) {
        String ip = req.remoteIp;
        if (ip == null || ip.isEmpty()) {
            return false;
        }
        if (ip.equals("127.0.0.1") || ip.equals("::1") || ip.equals("0:0:0:0:0:0:0:1")
                || ip.equalsIgnoreCase("localhost")) {
            return true;
        }
        for (NetInfo.Addr a : NetInfo.shareAddresses()) {
            if (a.ip.equals(ip)) {
                return true;
            }
        }
        return false;
    }

    /** 导入的 game.json 里 autostart 字段（布尔 true，或字符串 "true"/"1"）。 */
    private static boolean importAutostart(Map<String, Object> m) {
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

    private static Response json(int status, String body) {
        String descr;
        switch (status) {
            case 200:
                descr = "OK";
                break;
            case 400:
                descr = "Bad Request";
                break;
            case 403:
                descr = "Forbidden";
                break;
            case 404:
                descr = "Not Found";
                break;
            case 405:
                descr = "Method Not Allowed";
                break;
            case 409:
                descr = "Conflict";
                break;
            default:
                descr = "Error";
                break;
        }
        return new Response(status, descr, JSON, body.getBytes(StandardCharsets.UTF_8));
    }

    /** 只解析查询串（上传接口用：请求体是文件二进制，不能碰）。 */
    private static Map<String, String> queryParams(HttpRequest req) {
        Map<String, String> m = new HashMap<>();
        parsePairs(req.query, m);
        return m;
    }

    /** 合并「查询串」与「form-urlencoded 请求体」里的参数。 */
    private static Map<String, String> params(HttpRequest req) {
        Map<String, String> m = new HashMap<>();
        parsePairs(req.query, m);
        String ct = req.header("content-type");
        if (req.body != null && req.body.length > 0
                && (ct == null || ct.toLowerCase(Locale.ROOT).contains("application/x-www-form-urlencoded"))) {
            parsePairs(new String(req.body, StandardCharsets.UTF_8), m);
        }
        return m;
    }

    /** 解析 {@code a=1&b=2}；表单编码里 {@code +} 代表空格。 */
    private static void parsePairs(String s, Map<String, String> out) {
        if (s == null || s.isEmpty()) {
            return;
        }
        for (String pair : s.split("&")) {
            if (pair.isEmpty()) {
                continue;
            }
            int eq = pair.indexOf('=');
            String k;
            String v;
            if (eq < 0) {
                k = pair;
                v = "";
            } else {
                k = pair.substring(0, eq);
                v = pair.substring(eq + 1);
            }
            out.put(HttpUtils.urlDecode(k.replace('+', ' ')), HttpUtils.urlDecode(v.replace('+', ' ')));
        }
    }
}
