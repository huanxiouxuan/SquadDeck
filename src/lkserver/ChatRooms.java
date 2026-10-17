package lkserver;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;

/**
 * 「开黑启动器」的公共聊天频道：底栏的表情按钮和聊天框都发到这里，所有人轮询拉取。
 *
 * <p>这是<b>启动器自己的功能，与游戏完全无关</b>：不经过任何游戏的协议——
 * 游戏接不接、运不运行都不影响；切游戏、甚至不选游戏，聊天记录都接着算。
 * 服务器上只有一个大房间（开黑 = 一伙人在同一台服务器上玩），消息里的名字
 * 由启动器右上角「名字登记」栏提供——<b>没登记名字不发</b>（与启动器前端
 * 的「名字门禁」同一套规则：没有身份就不能聊天/发表情/进游戏）。
 *
 * <p>消息只在内存里：保留最近 {@value #MAX_MSGS} 条、
 * {@value #TTL_MINUTES} 分钟内的。派对游戏服务器不追求历史存档，
 * 重启即清空也符合预期。
 */
public final class ChatRooms {

    /** 一条聊天/表情消息。id 单调递增，客户端靠它做增量拉取（{@code after}）。 */
    public static final class Msg {
        public final long id;
        public final String name;
        public final String text;
        public final long t;

        Msg(long id, String name, String text, long t) {
            this.id = id;
            this.name = name;
            this.text = text;
            this.t = t;
        }
    }

    private static final int MAX_MSGS = 60;               // 最多保留多少条
    private static final long TTL_MS = 10 * 60 * 1000L;   // 保留时长
    static final int MAX_NAME = 10;                       // 与启动器「名字登记」一致
    static final int MAX_TEXT = 120;                      // 单条长度上限（与输入框 maxlength 一致）
    private static final int RECENT_DEFAULT = 20;         // 首次拉取时回看最近多少条

    private final Deque<Msg> msgs = new ArrayDeque<>();
    private long nextId = 1;

    /**
     * 发一条消息。名字/文本会做去空白和截断（内部连续空白压成一个空格，
     * 聊天栏按一行显示）；名字或内容为空返回 {@code null}（调用方按 400 处理）。
     *
     * <p>名字同样受门禁：没在启动器登记名字就不给发——与聊天/表情的
     * 前端禁用是同一套规则的服务端兜底。
     */
    public synchronized Msg post(String name, String text) {
        String n = clip(name, MAX_NAME);
        if (n.isEmpty()) {
            return null;
        }
        String x = clip(text, MAX_TEXT);
        if (x.isEmpty()) {
            return null;
        }
        prune();
        Msg m = new Msg(nextId++, n, x, System.currentTimeMillis());
        msgs.addLast(m);
        while (msgs.size() > MAX_MSGS) {
            msgs.pollFirst();
        }
        return m;
    }

    /**
     * 拉消息。{@code after = 0} 时回看最近 {@value #RECENT_DEFAULT} 条
     * （刚打开页面的历史）；否则只给 id 更大的（增量轮询）。
     */
    public synchronized List<Msg> recent(long after) {
        prune();
        List<Msg> out = new ArrayList<>();
        if (after <= 0) {
            int skip = Math.max(0, msgs.size() - RECENT_DEFAULT);
            int i = 0;
            for (Msg m : msgs) {
                if (i++ >= skip) {
                    out.add(m);
                }
            }
        } else {
            for (Msg m : msgs) {
                if (m.id > after) {
                    out.add(m);
                }
            }
        }
        return out;
    }

    /** 过期清理：从头弹掉超过 TTL 的（队列按时间有序，遇到没过期的即可停）。 */
    private void prune() {
        long deadline = System.currentTimeMillis() - TTL_MS;
        while (!msgs.isEmpty() && msgs.peekFirst().t < deadline) {
            msgs.pollFirst();
        }
    }

    /** 去首尾空白 + 压掉内部换行/连续空白 + 截断。 */
    private static String clip(String s, int max) {
        if (s == null) {
            return "";
        }
        String t = s.replaceAll("\\s+", " ").trim();
        return t.length() > max ? t.substring(0, max) : t;
    }
}
