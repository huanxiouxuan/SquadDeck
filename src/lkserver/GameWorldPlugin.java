package lkserver;

import java.util.Map;

/**
 * 「联机游戏世界」的统一契约——服务端权威游戏逻辑的插件接口。
 *
 * <p>每一个要联机的游戏写一个实现类（如坦克的 {@code GameWorld}、
 * 贪吃蛇的 {@code SnakeWorld}），在 game.json 里用 {@code world} 字段声明全限定类名，
 * {@link WorldRegistry} 启动时反射加载。<b>新增联机游戏不用改服务器内核</b>：
 * GameApi 的 {@code /api/<游戏id>/join|sync|leave|info} 是通用路由，
 * 按 id 找到世界实例就行。
 *
 * <h3>四个约定</h3>
 * <ul>
 *   <li>{@link #join}/{@link #info} 返回<b>完整 JSON 字符串</b>（世界自己拼，
 *       因为各世界的参数不一样——坦克有血量、贪吃蛇有果实数）；</li>
 *   <li>{@link #sync(String, Map)} 收「本次请求的全部参数」，各世界只取自己认识的键
 *       （缺省值必须与从前 GameApi 里的解析一致，保证老客户端行为不变）；</li>
 *   <li>所有方法都可能被 tick 线程和 HTTP 线程同时调用，实现类自己保证线程安全
 *       （现有两个世界都是用 {@code synchronized}）；</li>
 *   <li>{@link #stop()} 只停 tick，不清数据——再 {@link #start()} 相当于重开一局。</li>
 * </ul>
 */
public interface GameWorldPlugin {

    /** 开始推进世界（起 tick 线程）。 */
    void start();

    /** 停止推进世界（停 tick 线程；数据保留，再 start 就是重开）。 */
    void stop();

    /**
     * 新玩家加入，返回<b>完整 JSON</b>，例如
     * {@code {"id":"p1","w":80,"h":60,"cell":32,"hp":5}}。
     *
     * @param rawCid 客户端身份（浏览器标签级，存 sessionStorage）；
     *               同一个 cid 在角色还在时直接复用，刷新/重连不多出号
     */
    String join(String rawName, String rawCid);

    /**
     * 一次同步：上交输入<b>并</b>取回世界快照（一次往返，射击游戏约 25~30Hz）。
     *
     * @param params 本次请求的全部参数（查询串 + 表单体合并），各世界自取
     * @return 世界快照 JSON
     */
    String sync(String id, Map<String, String> params);

    /** 主动退出。 */
    void leave(String id);

    /** 在线人数 / 地图尺寸等，返回<b>完整 JSON</b>。 */
    String info();

    /** 在线人数（离线未超时的 ghost 不算）。 */
    int playerCount();

    // =========================================================
    // 参数解析小工具：各世界从 params 取自己参数用。
    // 容错优先——客户端传什么垃圾都不该把服务器搞崩。
    // =========================================================

    static int intOf(Map<String, String> p, String key, int def) {
        if (p == null) {
            return def;
        }
        String v = p.get(key);
        if (v == null) {
            return def;
        }
        try {
            return Integer.parseInt(v.trim());
        } catch (NumberFormatException e) {
            return def;
        }
    }

    static long longOf(Map<String, String> p, String key, long def) {
        if (p == null) {
            return def;
        }
        String v = p.get(key);
        if (v == null) {
            return def;
        }
        try {
            return Long.parseLong(v.trim());
        } catch (NumberFormatException e) {
            return def;
        }
    }

    static double doubleOf(Map<String, String> p, String key, double def) {
        if (p == null) {
            return def;
        }
        String v = p.get(key);
        if (v == null) {
            return def;
        }
        try {
            double d = Double.parseDouble(v.trim());
            return Double.isFinite(d) ? d : def;
        } catch (NumberFormatException e) {
            return def;
        }
    }

    static boolean boolOf(Map<String, String> p, String key, boolean def) {
        if (p == null) {
            return def;
        }
        String v = p.get(key);
        if (v == null) {
            return def;
        }
        return "1".equals(v) || "true".equalsIgnoreCase(v);
    }
}
