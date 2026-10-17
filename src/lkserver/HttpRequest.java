package lkserver;

import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Locale;
import java.util.Map;

/**
 * 一条解析完成的 HTTP 请求。
 *
 * <p>对应 C++ 版里被丢弃的那部分信息：原版只从请求行里取走了 method 和 url，
 * 请求头直接被忽略。这个类把请求行、请求头、请求体完整保存下来，
 * 后续所有需要"看请求头"的功能（Range 断点续传、虚拟主机、
 * Connection 语义、gzip、认证……）都从这里取数据。
 *
 * <p>成员分两类：
 * <ul>
 *   <li><b>请求行解析结果</b>：{@link #method} / {@link #target} / {@link #version}</li>
 *   <li><b>请求目标拆解</b>：{@link #path}（已 URL 解码）/ {@link #query}（原始查询串）</li>
 * </ul>
 * 头部键统一小写存放，取值请用 {@link #header(String)}。
 */
public final class HttpRequest {

    /** 请求方法（保持原始大小写，通常是大写）。 */
    public final String method;

    /** 原始请求目标，例如 {@code /a/b.html?x=1} 或绝对形式 {@code http://host/a}。 */
    public final String target;

    /** URL 解码后的路径部分（不含查询串）。 */
    public final String path;

    /** 原始查询串（不含 {@code ?}）；没有查询串时为 {@code null}。 */
    public final String query;

    /** 协议版本，只可能是 {@code HTTP/1.0} 或 {@code HTTP/1.1}。 */
    public final String version;

    /** 请求头，键统一小写，值为原始值（重名头已用 ", " 合并）。只读。 */
    public final Map<String, String> headers;

    /** 已校验过的 Content-Length（缺省为 0）。 */
    public final int contentLength;

    /**
     * 请求体。解析完成时填充；无请求体（如 GET/HEAD）时为 {@code null}。
     * 之所以不是 final：头部先解析出来、正文要等收全后才回填同一个对象。
     */
    public byte[] body;

    /**
     * 客户端 IP（对端地址），由 {@link TcpConnection} 收到请求时回填（解析器拿不到）。
     * 用途：识别「房主」——启停游戏世界的开关只有房主能拨（见 {@link GameApi#isHost}）。
     */
    public String remoteIp;

    HttpRequest(String method, String target, String path, String query, String version,
                Map<String, String> headers, int contentLength) {
        this.method = method;
        this.target = target;
        this.path = path;
        this.query = query;
        this.version = version;
        this.headers = Collections.unmodifiableMap(headers);
        this.contentLength = contentLength;
    }

    /** 按名字取请求头（大小写不敏感）；不存在返回 {@code null}。 */
    public String header(String name) {
        return headers.get(name.toLowerCase(Locale.ROOT));
    }

    public boolean hasHeader(String name) {
        return headers.containsKey(name.toLowerCase(Locale.ROOT));
    }

    /**
     * 是否要求保持长连接。
     * <p>HTTP/1.1 默认保持，除非显式 {@code Connection: close}；
     * HTTP/1.0 默认关闭，除非显式 {@code Connection: keep-alive}。
     */
    public boolean keepAlive() {
        String conn = header("connection");
        if (conn != null) {
            String v = conn.toLowerCase(Locale.ROOT);
            if (v.contains("close")) {
                return false;
            }
            if (v.contains("keep-alive")) {
                return true;
            }
        }
        return "HTTP/1.1".equals(version);
    }

    /** 客户端是否声明 {@code Expect: 100-continue}（要求服务端先回 100 再发正文）。 */
    public boolean expectsContinue() {
        String e = header("expect");
        return e != null && e.toLowerCase(Locale.ROOT).contains("100-continue");
    }

    /** 请求体按 UTF-8 解码为文本（无正文时返回空串）。仅用于展示/调试。 */
    public String bodyText() {
        return body == null ? "" : new String(body, StandardCharsets.UTF_8);
    }

    @Override
    public String toString() {
        return method + ' ' + target + ' ' + version
                + " headers=" + headers.size()
                + " body=" + (body == null ? 0 : body.length);
    }
}
