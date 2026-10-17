package lkserver;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * HTTP 工具函数，与 C++ 版 server2.cpp 中的同名函数一一对应：
 * getFT -> {@link #getMimeType}、seadHeadM -> {@link #buildHeader}、
 * decodeMsg -> {@link #urlDecode}、hexToDec -> {@link #hexToDec}。
 */
public final class HttpUtils {

    private static final String CRLF = "\r\n";
    private static final char[] HEX = "0123456789ABCDEF".toCharArray();

    private HttpUtils() {
    }

    /** 对应 C++ getFT：按扩展名返回 MIME 类型。 */
    public static String getMimeType(String name) {
        int dot = name.lastIndexOf('.');
        if (dot < 0) {
            return "text/plain; charset=utf-8";
        }
        switch (name.substring(dot).toLowerCase(Locale.ROOT)) {
            case ".html":
            case ".htm":
                return "text/html; charset=utf-8";
            case ".jpg":
            case ".jpeg":
                return "image/jpeg";
            case ".gif":
                return "image/gif";
            case ".png":
                return "image/png";
            case ".css":
                return "text/css; charset=utf-8";
            case ".js":
                return "application/javascript; charset=utf-8";
            case ".json":
                return "application/json; charset=utf-8";
            case ".txt":
                return "text/plain; charset=utf-8";
            case ".svg":
                return "image/svg+xml";
            case ".ico":
                return "image/x-icon";
            case ".au":
                return "audio/basic";
            case ".wav":
                return "audio/wav";
            case ".avi":
                return "video/x-msvideo";
            case ".mov":
            case ".qt":
                return "video/quicktime";
            case ".mpeg":
            case ".mpe":
                return "video/mpeg";
            case ".mp4":
                return "video/mp4";
            case ".vrml":
            case ".wrl":
                return "model/vrml";
            case ".midi":
            case ".mid":
                return "audio/midi";
            case ".mp3":
                return "audio/mpeg";
            case ".ogg":
                return "application/ogg";
            case ".pac":
                return "application/x-ns-proxy-autoconfig";
            default:
                return "text/plain; charset=utf-8";
        }
    }

    /**
     * 构造响应头，对应 C++ seadHeadM。
     *
     * <p>与 C++ 版的差异：原版在长度未知时（404 / 目录列表）发的是
     * {@code Connection: close}，靠服务端主动断开来界定正文边界。
     * 这里因为目录列表和 404 页面的长度都能预先算出，统一发送准确的
     * {@code Content-Length}，因此不需要为每个响应断开连接（HTTP/1.1 长连接）。
     */
    public static String buildHeader(int status, String descr, String type, long length) {
        return buildHeader(status, descr, type, length, null);
    }

    /**
     * 构造响应头，可额外指定 {@code Connection} 头与若干附加头。
     *
     * @param connection   {@code "close"} / {@code "keep-alive"}；为 {@code null} 时不发该头
     *                     （HTTP/1.1 下即默认长连接）
     * @param extraHeaders 逐行附加的原始头（如 {@code "Cache-Control: no-store"}），可为空
     */
    public static String buildHeader(int status, String descr, String type, long length,
                                     String connection, String... extraHeaders) {
        StringBuilder sb = new StringBuilder(128);
        sb.append("HTTP/1.1 ").append(status).append(' ').append(descr).append(CRLF);
        sb.append("Content-Type: ").append(type).append(CRLF);
        sb.append("Server: lkserver2-java").append(CRLF);
        sb.append("Content-Length: ").append(Math.max(length, 0)).append(CRLF);
        for (String h : extraHeaders) {
            if (h != null && !h.isEmpty()) {
                sb.append(h).append(CRLF);
            }
        }
        if (connection != null) {
            sb.append("Connection: ").append(connection).append(CRLF);
        }
        sb.append(CRLF);
        return sb.toString();
    }

    /**
     * URL 百分号解码，对应 C++ decodeMsg：把 %XX 还原成字节，再按 UTF-8
     * 解出中文等非 ASCII 字符。
     *
     * <p>与 C++ 版一致，只处理 %XX，不把 '+' 当作空格（路径里 '+' 是合法字符）。
     */
    public static String urlDecode(String s) {
        if (s.indexOf('%') < 0) {
            return s;
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '%' && i + 2 < s.length() && isHex(s.charAt(i + 1)) && isHex(s.charAt(i + 2))) {
                out.write(hexToDec(s.charAt(i + 1)) * 16 + hexToDec(s.charAt(i + 2)));
                i += 2;
            } else {
                byte[] bs = String.valueOf(c).getBytes(StandardCharsets.UTF_8);
                out.write(bs, 0, bs.length);
            }
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    /** 对应 C++ hexToDec。 */
    public static int hexToDec(char c) {
        if (c >= '0' && c <= '9') {
            return c - '0';
        }
        if (c >= 'a' && c <= 'f') {
            return c - 'a' + 10;
        }
        if (c >= 'A' && c <= 'F') {
            return c - 'A' + 10;
        }
        return 0;
    }

    private static boolean isHex(char c) {
        return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
    }

    /** 路径片段百分号编码（供目录列表生成 href 用）。'/' 保留，空格编成 %20 而非 '+'。 */
    public static String urlEncodePath(String s) {
        StringBuilder sb = new StringBuilder(s.length() + 16);
        for (byte b : s.getBytes(StandardCharsets.UTF_8)) {
            int c = b & 0xFF;
            boolean unreserved = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
                    || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~' || c == '/';
            if (unreserved) {
                sb.append((char) c);
            } else {
                sb.append('%').append(HEX[(c >> 4) & 0xF]).append(HEX[c & 0xF]);
            }
        }
        return sb.toString();
    }

    /** HTML 转义，避免文件名里的 &、< 等破坏页面结构。 */
    public static String escapeHtml(String s) {
        StringBuilder sb = new StringBuilder(s.length() + 16);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '&':
                    sb.append("&amp;");
                    break;
                case '<':
                    sb.append("&lt;");
                    break;
                case '>':
                    sb.append("&gt;");
                    break;
                case '"':
                    sb.append("&quot;");
                    break;
                case '\'':
                    sb.append("&#39;");
                    break;
                default:
                    sb.append(c);
            }
        }
        return sb.toString();
    }

    public static byte[] utf8(String s) {
        return s.getBytes(StandardCharsets.UTF_8);
    }
}
