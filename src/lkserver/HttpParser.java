package lkserver;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * HTTP/1.x 请求解析器（逐连接一个实例）。
 *
 * <p>它解决的是 TCP 的"字节流"与 HTTP 的"消息"之间的鸿沟：
 * <ul>
 *   <li><b>半包</b>：一次读事件只收到了半个请求（头部没收全、正文没收全），
 *       解析器要能记住进度，等下次读事件继续。</li>
 *   <li><b>粘包 / 流水线</b>：一次读事件里躺着两个完整请求，
 *       解析器要能把第一个交出去、把剩下的留在缓冲区里。</li>
 * </ul>
 * 因此 {@link #poll(ByteBuffer)} 被设计成"能解析就返回一条请求，不够就返回 null"，
 * 由调用方（{@code TcpConnection}）在一个循环里反复调用——这与 Netty 的
 * {@code ByteToMessageDecoder} 反复 decode 是同一套模型。
 *
 * <p>关于 {@link ByteBuffer}：约定传入的缓冲区 position 即"已收字节数"，
 * 且是 {@code allocate()} 出来的堆缓冲区（这样能安全访问 {@code array()}）。
 * 解析器消费字节时会调用 {@link #consume} 把剩余的字节前移，position 随之收缩。
 *
 * <h3>安全/健壮性设计</h3>
 * <ul>
 *   <li>头部与正文都有体积上限，超限直接回 431 / 413，避免内存被撑爆。</li>
 *   <li>不实现 {@code Transfer-Encoding: chunked}，遇到就回 501，
 *       而不是"猜"正文长度——猜错就是请求走私（request smuggling）漏洞的来源。</li>
 *   <li>Content-Length 必须是合法非负整数，重名头会被合并而解析失败，
 *       同样是为了避免长度歧义。</li>
 * </ul>
 */
public final class HttpParser {

    /** 请求行 + 请求头的体积上限（超过回 431）。 */
    public static final int MAX_HEADER_SIZE = 32 * 1024;

    /**
     * 请求体的体积上限（超过回 413）。注意：正文是整体缓冲在内存里的。
     *
     * <p>1MB 对接口参数足够，但「从文件夹导入游戏」要把整个文件放进请求体
     * （index.html / js / 图片音效），素材动辄几 MB，所以放宽到 32MB。
     * 启动器前端也有同样的上限提示，两边保持一致。
     */
    public static final int MAX_BODY_SIZE = 32 * 1024 * 1024;

    /** 单连接接收缓冲区的上限：头部上限 + 正文上限，正好放得下最坏情况。 */
    public static final int MAX_BUFFER_SIZE = MAX_HEADER_SIZE + MAX_BODY_SIZE;

    /** 同一头部允许出现的次数上限，防止用海量头做 DoS。 */
    private static final int MAX_HEADERS = 128;

    /** 解析失败时抛出，携带要回给客户端的 HTTP 状态码。 */
    public static final class ParseException extends Exception {
        public final int status;
        public final String descr;

        ParseException(int status, String descr, String detail) {
            super(detail);
            this.status = status;
            this.descr = descr;
        }
    }

    /** 已解析出的头部；非 null 表示"头部已读完、正在等正文"。 */
    private HttpRequest pendingHead;

    /** 头部占用的字节数，也就是正文的起始偏移。 */
    private int headLen;

    /** 期待的正文长度。 */
    private int bodyNeeded;

    /** 是否已经回过 100 Continue。 */
    private boolean continueSent;

    /** 丢弃当前请求的解析进度（出错后、或连接复用时调用）。 */
    public void reset() {
        pendingHead = null;
        headLen = 0;
        bodyNeeded = 0;
        continueSent = false;
    }

    /** 头部已解析、正文还没收全。 */
    public boolean awaitingBody() {
        return pendingHead != null;
    }

    /** 现在应该先给客户端回一个 100 Continue（声明了 Expect 且还没回过、正文未到齐）。 */
    public boolean needContinue() {
        return pendingHead != null && !continueSent && pendingHead.expectsContinue();
    }

    public void markContinueSent() {
        continueSent = true;
    }

    /**
     * 尝试从缓冲区里取出下一条完整请求。
     *
     * @return 解析完成的一条请求；数据还不够时返回 {@code null}
     * @throws ParseException 请求非法，调用方应按 {@link ParseException#status} 回错误
     */
    public HttpRequest poll(ByteBuffer in) throws ParseException {
        // 阶段一：把请求头读全
        if (pendingHead == null) {
            int len = in.position();
            if (len == 0) {
                return null;
            }
            int hdrEnd = findHeaderEnd(in.array(), len);
            if (hdrEnd < 0) {
                if (len > MAX_HEADER_SIZE) {
                    throw new ParseException(431, "Request Header Fields Too Large",
                            "header block exceeds " + MAX_HEADER_SIZE + " bytes");
                }
                return null;   // 头部还没收全，等下一次读事件
            }
            if (hdrEnd > MAX_HEADER_SIZE) {
                // 头部虽然收全了，但整体超限，同样按 431 拒绝（与"没收全"保持一致）
                throw new ParseException(431, "Request Header Fields Too Large",
                        "header block " + hdrEnd + " > " + MAX_HEADER_SIZE + " bytes");
            }
            String block = new String(in.array(), 0, hdrEnd, StandardCharsets.ISO_8859_1);
            pendingHead = parseHead(block);
            headLen = hdrEnd;
            bodyNeeded = pendingHead.contentLength;
        }

        // 阶段二：正文。无正文则直接交付
        if (bodyNeeded == 0) {
            HttpRequest r = pendingHead;
            consume(in, headLen);
            reset();
            return r;
        }

        // 正文没收全，继续等
        if (in.position() < headLen + bodyNeeded) {
            return null;
        }

        byte[] body = Arrays.copyOfRange(in.array(), headLen, headLen + bodyNeeded);
        HttpRequest r = pendingHead;
        r.body = body;
        consume(in, headLen + bodyNeeded);
        reset();
        return r;
    }

    // =========================================================
    // 头部解析
    // =========================================================

    private HttpRequest parseHead(String block) throws ParseException {
        String[] lines = block.split("\r\n|\n|\r", -1);

        // 请求行（容忍前面多出来的空行，RFC 允许）
        int i = 0;
        while (i < lines.length && lines[i].isEmpty()) {
            i++;
        }
        if (i >= lines.length) {
            throw new ParseException(400, "Bad Request", "empty request");
        }
        String requestLine = lines[i++];

        String[] parts = requestLine.trim().split("[ \\t]+");
        if (parts.length != 3) {
            throw new ParseException(400, "Bad Request", "malformed request line: " + requestLine);
        }
        String method = parts[0];
        String target = parts[1];
        String version = parts[2];

        if (!isToken(method) || method.length() > 32) {
            throw new ParseException(400, "Bad Request", "invalid method: " + method);
        }
        if (!"HTTP/1.1".equals(version) && !"HTTP/1.0".equals(version)) {
            throw new ParseException(505, "HTTP Version Not Supported", "version=" + version);
        }
        if (target.isEmpty()) {
            throw new ParseException(400, "Bad Request", "empty request target");
        }

        // 请求头
        Map<String, String> headers = new LinkedHashMap<>();
        String lastName = null;
        for (; i < lines.length; i++) {
            String line = lines[i];
            if (line.isEmpty()) {
                break;   // 头与正文之间的空行
            }
            char first = line.charAt(0);
            if (first == ' ' || first == '\t') {
                // obs-fold 续行：拼到上一个头后面
                if (lastName == null) {
                    throw new ParseException(400, "Bad Request", "header continuation without a header");
                }
                headers.put(lastName, headers.get(lastName) + " " + line.trim());
                continue;
            }
            int colon = line.indexOf(':');
            if (colon <= 0) {
                throw new ParseException(400, "Bad Request", "malformed header line: " + line);
            }
            String name = line.substring(0, colon).trim();
            String value = line.substring(colon + 1).trim();
            if (!isToken(name)) {
                throw new ParseException(400, "Bad Request", "invalid header name: " + name);
            }
            name = name.toLowerCase(Locale.ROOT);
            if (headers.size() >= MAX_HEADERS && !headers.containsKey(name)) {
                throw new ParseException(431, "Request Header Fields Too Large", "too many headers");
            }
            // 重名头合并（Content-Length 重名会在下面解析时失败 -> 400，符合安全预期）
            headers.merge(name, value, (a, b) -> a + ", " + b);
            lastName = name;
        }

        if (headers.containsKey("transfer-encoding")) {
            throw new ParseException(501, "Not Implemented",
                    "Transfer-Encoding (chunked) is not supported");
        }

        int contentLength = 0;
        String cl = headers.get("content-length");
        if (cl != null) {
            try {
                contentLength = Integer.parseInt(cl.trim());
            } catch (NumberFormatException e) {
                throw new ParseException(400, "Bad Request", "invalid Content-Length: " + cl);
            }
            if (contentLength < 0) {
                throw new ParseException(400, "Bad Request", "negative Content-Length: " + cl);
            }
            if (contentLength > MAX_BODY_SIZE) {
                throw new ParseException(413, "Payload Too Large",
                        "body " + contentLength + " > " + MAX_BODY_SIZE);
            }
        }

        // 拆解请求目标：路径 / 查询串；并支持代理常用的绝对形式
        String path = target;
        String query = null;
        int q = path.indexOf('?');
        if (q >= 0) {
            query = path.substring(q + 1);
            path = path.substring(0, q);
        }
        String lower = path.toLowerCase(Locale.ROOT);
        if (lower.startsWith("http://") || lower.startsWith("https://")) {
            int schemeEnd = path.indexOf("://") + 3;
            int slash = path.indexOf('/', schemeEnd);
            path = slash >= 0 ? path.substring(slash) : "/";
        }
        path = HttpUtils.urlDecode(path);

        return new HttpRequest(method, target, path, query, version, headers, contentLength);
    }

    // =========================================================
    // 工具
    // =========================================================

    /**
     * 找头部结束位置，即 "\r\n\r\n"（或宽松接受 "\n\n"）之后的下标，也就是正文起点。
     * 没找到返回 -1。
     */
    static int findHeaderEnd(byte[] a, int len) {
        for (int i = 0; i < len; i++) {
            if (a[i] != '\n') {
                continue;
            }
            if (i + 1 < len && a[i + 1] == '\n') {
                return i + 2;                       // "\n\n"
            }
            if (i + 2 < len && a[i + 1] == '\r' && a[i + 2] == '\n') {
                return i + 3;                       // "\n\r\n"，即 "\r\n\r\n" 的尾部
            }
        }
        return -1;
    }

    /** 从缓冲区头部丢弃 k 个字节，把剩下的前移。 */
    private static void consume(ByteBuffer in, int k) {
        if (k <= 0) {
            return;
        }
        int remaining = in.position() - k;
        if (remaining <= 0) {
            in.position(0);
            return;
        }
        byte[] a = in.array();
        System.arraycopy(a, k, a, 0, remaining);
        in.position(remaining);
    }

    /** 是否是合法的 HTTP token 字符（方法名、头名用同一套字符集，但这里放宽到可见 ASCII）。 */
    private static boolean isToken(String s) {
        if (s.isEmpty()) {
            return false;
        }
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c <= ' ' || c > '~' || c == ':' || c == '(' || c == ')' || c == ',' || c == '/'
                    || c == '"' || c == '?' || c == '@' || c == '[' || c == ']' || c == '{'
                    || c == '}' || c == ';' || c == '=' || c == '\\') {
                return false;
            }
        }
        return true;
    }
}
