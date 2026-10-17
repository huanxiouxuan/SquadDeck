package lkserver;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.channels.SelectionKey;
import java.nio.channels.SocketChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Queue;
import java.util.stream.Stream;

/**
 * 一个客户端连接的完整处理，对应 C++ 版 server2.h / server2.cpp 中的 TcpConnection。
 *
 * <p>这里承载了四个核心机制：
 * <ol>
 *   <li><b>完整 HTTP 解析</b>：由 {@link HttpParser} 负责逐条取出请求
 *       （请求行 + 请求头 + 请求体），能正确处理<b>半包</b>（请求没收全）与
 *       <b>粘包 / 流水线</b>（一次收到多条请求）。原 C++ 版只解析了请求行，
 *       请求头被整个丢弃。</li>
 *   <li><b>输出缓冲 + 写续发</b>：C++ 用 {@code Buffer} + EPOLLOUT；这里用
 *       {@code outQueue}（ByteBuffer 队列）+ {@code OP_WRITE}。写半包时把剩余数据排队，
 *       等可写事件回来续发。</li>
 *   <li><b>零拷贝发文件</b>：C++ 用 {@code sendfile(2)}；这里用
 *       {@link FileChannel#transferTo(long, long, java.nio.channels.WritableByteChannel)}，
 *       在 Windows 上底层走 TransmitFile、在 Linux 上走 sendfile，文件数据不经过用户态内存。</li>
 *   <li><b>连接语义</b>：根据解析出的 {@code Connection} 头与协议版本决定长连接还是关闭
 *       （HTTP/1.1 默认长连接、HTTP/1.0 默认关闭），并支持 {@code Expect: 100-continue}。</li>
 * </ol>
 */
public class TcpConnection {

    private static final int INITIAL_READ_BUFFER = 4096;
    private static final int FALLBACK_CHUNK = 64 * 1024;

    private final SocketChannel channel;
    private final EventLoop loop;
    private final ServerContext ctx;
    private final SelectionKey key;

    /** 接收缓冲：一次可能收到多条请求，所以做成可增长，上限见 {@link HttpParser#MAX_BUFFER_SIZE}。 */
    private ByteBuffer inBuf = ByteBuffer.allocate(INITIAL_READ_BUFFER);

    /** 请求解析器（逐连接一个，内部保存"头部已读、正文待续"的进度）。 */
    private final HttpParser parser = new HttpParser();

    /** 应用层输出缓冲（对应 C++ 的 Buffer m_outputBuffer）。 */
    private final Queue<ByteBuffer> outQueue = new ArrayDeque<>();

    /** 待零拷贝发送的文件（对应 C++ 的 m_fileFd / m_fileOffset / m_fileSize）。 */
    private FileChannel pendingFile;
    private long fileOffset;
    private long fileSize;

    /** transferTo 连续零进展的次数 / 是否已退回普通读写兜底。 */
    private int stallCount;
    private boolean useFallback;

    /** 对端已发 FIN：等输出发完再关闭（对应 C++ 的 m_closeAfterWrite）。 */
    private boolean peerClosed;

    /** 本次响应发完后要主动关闭连接（由 Connection 头 / 协议版本决定）。 */
    private boolean closeAfterWrite;

    /** 需要显式回一个 {@code Connection: keep-alive}（HTTP/1.0 客户端要求长连接时）。 */
    private boolean sendKeepAliveHeader;

    public TcpConnection(SocketChannel channel, EventLoop loop, ServerContext ctx) throws IOException {
        this.channel = channel;
        this.loop = loop;
        this.ctx = ctx;
        this.key = loop.register(channel, SelectionKey.OP_READ, this::onEvent);
    }

    /** 事件入口：把读/写事件分派到对应处理。 */
    private void onEvent(SelectionKey key) throws IOException {
        if (!key.isValid()) {
            return;
        }
        if (key.isReadable()) {
            handleRead();
        }
        if (key.isValid() && key.isWritable()) {
            flush();
            // 上一个响应刚刚发完：缓冲区里可能还压着流水线里的下一条请求
            if (key.isValid() && !hasPendingOutput()) {
                processBuffer();
            }
        }
    }

    // =========================================================
    // 读：收字节 -> 交给解析器
    // =========================================================

    private void handleRead() throws IOException {
        int n;
        while (true) {
            n = channel.read(inBuf);
            if (n <= 0) {
                break;
            }
            if (!inBuf.hasRemaining() && inBuf.capacity() < HttpParser.MAX_BUFFER_SIZE) {
                int newCap = Math.min(inBuf.capacity() * 2, HttpParser.MAX_BUFFER_SIZE);
                ByteBuffer bigger = ByteBuffer.allocate(newCap);
                inBuf.flip();
                bigger.put(inBuf);
                inBuf = bigger;
            }
        }

        if (n == -1) {
            // 对端关闭。注意：可能"请求已发完但缓冲区还没解析"，
            // 所以先处理掉缓冲区里已完整的请求，再决定关闭。
            if (inBuf.position() > 0) {
                processBuffer();
            }
            handlePeerClose();
            return;
        }

        if (inBuf.position() == 0) {
            return;
        }
        processBuffer();
    }

    /**
     * 反复从缓冲区取完整请求并处理，直到：数据不够 / 上一个响应还没发完 / 连接已关闭。
     * <p>这就是"粘包拆分 + 流水线"的地方。
     */
    private void processBuffer() {
        if (!key.isValid()) {
            return;
        }
        try {
            while (true) {
                if (hasPendingOutput()) {
                    return;   // 上一个响应尚未发完，先把剩下的字节留在缓冲区
                }
                HttpRequest req = parser.poll(inBuf);
                if (req == null) {
                    if (parser.needContinue()) {
                        parser.markContinueSent();
                        send(HttpUtils.utf8("HTTP/1.1 100 Continue\r\n\r\n"));
                        flush();
                    }
                    return;   // 请求没收全，等下一次读事件
                }
                handleRequest(req);
                if (!key.isValid()) {
                    return;   // 响应里要求关闭连接
                }
            }
        } catch (HttpParser.ParseException e) {
            System.err.println("[" + Thread.currentThread().getName() + "] 请求非法 -> "
                    + e.status + " " + e.descr + " (" + e.getMessage() + ")");
            parser.reset();
            inBuf.clear();
            closeAfterWrite = true;
            sendKeepAliveHeader = false;
            sendSimple(e.status, e.descr, "text/plain; charset=utf-8", e.status + " " + e.descr);
        } catch (IOException e) {
            close();
        }
    }

    /** 对端关闭（读到 EOF）。仍有数据待发时标记「发完再关」，避免丢掉响应尾部。 */
    private void handlePeerClose() {
        if (hasPendingOutput()) {
            peerClosed = true;
            // 关掉读关注，否则对端已 FIN 时 OP_READ 会一直就绪，导致空转烧 CPU
            loop.setInterest(key, key.interestOps() & ~SelectionKey.OP_READ);
            return;
        }
        close();
    }

    // =========================================================
    // 请求处理（对应 C++ parseRL，但现在拿到了完整的请求对象）
    // =========================================================

    private void handleRequest(HttpRequest req) throws IOException {
        // 记下对端 IP：GameApi 靠它识别房主（启停游戏世界的开关只有房主能拨）
        try {
            req.remoteIp = ((java.net.InetSocketAddress) channel.getRemoteAddress()).getHostString();
        } catch (Exception ignore) {
            req.remoteIp = null;
        }

        String method = req.method.toUpperCase(Locale.ROOT);
        boolean headOnly = method.equals("HEAD");

        // 连接语义：HTTP/1.1 默认长连接；HTTP/1.0 默认关闭
        closeAfterWrite = !req.keepAlive();
        sendKeepAliveHeader = !closeAfterWrite && "HTTP/1.0".equals(req.version);

        // 游戏接口：/api/* 交给 GameApi；其余路径仍按静态资源处理
        if (req.path.startsWith("/api/")) {
            handleApi(req, headOnly);
            return;
        }

        // 小游戏静态资源：/games/<id>/<文件> → gamemode/<id>/<文件>
        if (req.path.equals("/games") || req.path.startsWith("/games/")) {
            handleGameStatic(req, headOnly);
            return;
        }

        if (!method.equals("GET") && !headOnly) {
            // 现在我们能读到请求体了，但仍不提供非 GET/HEAD 的处理能力
            sendSimple(501, "Not Implemented", "text/plain; charset=utf-8",
                    "501 Not Implemented: " + method);
            return;
        }

        String path = req.path;
        String rel = path.startsWith("/") ? path.substring(1) : path;
        if (rel.isEmpty()) {
            rel = ".";
        }
        Path target;
        try {
            target = ctx.root.resolve(rel).normalize();
        } catch (java.nio.file.InvalidPathException e) {
            sendNotFound(headOnly);
            return;
        }
        // 防目录穿越：解析后必须仍在根目录之内（原 C++ 版没有这道防线）
        if (!target.startsWith(ctx.root)) {
            sendNotFound(headOnly);
            return;
        }

        try {
            if (!Files.exists(target)) {
                sendNotFound(headOnly);
            } else if (Files.isDirectory(target)) {
                // 目录优先返回默认首页（这一条对"把地址发给朋友打开"很关键：
                // 否则访问 http://ip:port/ 会看到目录列表而不是游戏页面）
                Path index = findIndex(target);
                if (index != null) {
                    sendFile(index, headOnly);
                } else {
                    sendDirectory(target, headOnly);
                }
            } else if (Files.isRegularFile(target)) {
                sendFile(target, headOnly);
            } else {
                sendNotFound(headOnly);
            }
        } catch (IOException e) {
            close();
        }
    }

    /** 处理 /api/*：交给游戏逻辑，把返回的 JSON 发回去。 */
    private void handleApi(HttpRequest req, boolean headOnly) {
        GameApi.Response r = ctx.game.handle(req);
        String conn = closeAfterWrite ? "close" : (sendKeepAliveHeader ? "keep-alive" : null);
        send(HttpUtils.utf8(HttpUtils.buildHeader(r.status, r.descr, r.type, r.body.length, conn,
                "Cache-Control: no-store")));
        if (!headOnly && r.body.length > 0) {
            send(r.body);
        }
        flush();
    }

    /**
     * 处理 /games/&lt;id&gt;[/&lt;文件&gt;]：从该游戏的目录（gamemode/&lt;id&gt;/）发文件。
     *
     * <p>启动器（www/）把选中的游戏装进 iframe，src 就是 {@code /games/<id>/}；
     * 省略文件名时发 game.json 里声明的入口页。与静态资源一样做目录穿越校验。
     */
    private void handleGameStatic(HttpRequest req, boolean headOnly) throws IOException {
        String rest = req.path.substring("/games".length());   // "/tank/a.png" / "/tank" / ""
        if (rest.startsWith("/")) {
            rest = rest.substring(1);
        }
        String id;
        String file;
        int slash = rest.indexOf('/');
        if (slash < 0) {
            id = rest;
            file = "";
        } else {
            id = rest.substring(0, slash);
            file = rest.substring(slash + 1);
        }

        GameMode mode = ctx.modes.get(id);
        if (mode == null) {
            sendNotFound(headOnly);
            return;
        }
        Path gameDir = mode.dir;
        Path target;
        try {
            target = (file.isEmpty() ? gameDir.resolve(mode.entry) : gameDir.resolve(file)).normalize();
        } catch (java.nio.file.InvalidPathException e) {
            sendNotFound(headOnly);
            return;
        }
        // 防目录穿越：解析后必须还在该游戏目录内
        if (!target.startsWith(gameDir)) {
            sendNotFound(headOnly);
            return;
        }

        try {
            if (Files.isDirectory(target)) {
                // 目录优先给默认首页（和根目录的行为保持一致）
                Path index = findIndex(target);
                if (index == null) {
                    sendNotFound(headOnly);
                    return;
                }
                target = index;
            }
            if (!Files.isRegularFile(target)) {
                sendNotFound(headOnly);
            } else {
                sendFile(target, headOnly);
            }
        } catch (IOException e) {
            close();
        }
    }

    /** 目录下是否有默认首页（index.html / index.htm）。 */
    private static Path findIndex(Path dir) {
        for (String name : new String[]{"index.html", "index.htm"}) {
            Path p = dir.resolve(name);
            if (Files.isRegularFile(p)) {
                return p;
            }
        }
        return null;
    }

    /** 发送一个普通文件（对应 C++ sendFile + seadHeadM）。 */
    private void sendFile(Path file, boolean headOnly) throws IOException {
        long size = Files.size(file);
        String mime = HttpUtils.getMimeType(file.getFileName().toString());
        send(HttpUtils.utf8(respHeader(200, "OK", mime, size)));
        if (!headOnly) {
            pendingFile = FileChannel.open(file, StandardOpenOption.READ);
            fileOffset = 0;
            fileSize = pendingFile.size();
            useFallback = false;
            stallCount = 0;
        }
        flush();
    }

    /** 发送目录列表（对应 C++ sendDir，但内容一次性拼好后带正确的 Content-Length 发出）。 */
    private void sendDirectory(Path dir, boolean headOnly) throws IOException {
        StringBuilder sb = new StringBuilder(1024);
        sb.append("<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>Index of /")
                .append(HttpUtils.escapeHtml(ctx.displayPath(dir)))
                .append("</title><style>body{font-family:Consolas,monospace;padding:16px}")
                .append("table{border-collapse:collapse}td{padding:2px 18px 2px 0}")
                .append("a{text-decoration:none}</style></head><body><h1>Index of /")
                .append(HttpUtils.escapeHtml(ctx.displayPath(dir)))
                .append("</h1><hr><table>");

        if (!dir.equals(ctx.root)) {
            sb.append("<tr><td><a href=\"../\">../</a></td><td>-</td></tr>");
        }

        List<Path> entries = new ArrayList<>();
        try (Stream<Path> s = Files.list(dir)) {
            s.forEach(entries::add);
        }
        entries.sort(Comparator.comparing(p -> p.getFileName().toString(), String.CASE_INSENSITIVE_ORDER));

        for (Path p : entries) {
            String name = p.getFileName().toString();
            boolean isDir = Files.isDirectory(p);
            String href = HttpUtils.urlEncodePath(name) + (isDir ? "/" : "");
            String sizeText = isDir ? "-" : String.valueOf(Files.size(p));
            sb.append("<tr><td><a href=\"").append(href).append("\">")
                    .append(HttpUtils.escapeHtml(name)).append(isDir ? "/" : "")
                    .append("</a></td><td>").append(sizeText).append("</td></tr>");
        }
        sb.append("</table><hr></body></html>");

        byte[] body = HttpUtils.utf8(sb.toString());
        send(HttpUtils.utf8(respHeader(200, "OK", "text/html; charset=utf-8", body.length)));
        if (!headOnly) {
            send(body);
        }
        flush();
    }

    /** 404：优先返回根目录下的 404.html（与原版一致），没有则用内置页面兜底。 */
    private void sendNotFound(boolean headOnly) throws IOException {
        Path notFound = ctx.notFoundPage;
        if (Files.isRegularFile(notFound)) {
            long size = Files.size(notFound);
            send(HttpUtils.utf8(respHeader(404, "Not Found", "text/html; charset=utf-8", size)));
            if (!headOnly) {
                pendingFile = FileChannel.open(notFound, StandardOpenOption.READ);
                fileOffset = 0;
                fileSize = pendingFile.size();
                useFallback = false;
                stallCount = 0;
            }
        } else {
            byte[] body = HttpUtils.utf8("<!DOCTYPE html><html><head><meta charset=\"utf-8\">"
                    + "<title>404 Not Found</title></head><body><h1>404 Not Found</h1></body></html>");
            send(HttpUtils.utf8(respHeader(404, "Not Found", "text/html; charset=utf-8", body.length)));
            if (!headOnly) {
                send(body);
            }
        }
        flush();
    }

    private void sendSimple(int status, String descr, String type, String text) {
        byte[] body = HttpUtils.utf8(text);
        send(HttpUtils.utf8(respHeader(status, descr, type, body.length)));
        send(body);
        flush();
    }

    /** 构造响应头，按当前连接语义决定要不要带 {@code Connection}。 */
    private String respHeader(int status, String descr, String type, long length) {
        String conn = closeAfterWrite ? "close" : (sendKeepAliveHeader ? "keep-alive" : null);
        return HttpUtils.buildHeader(status, descr, type, length, conn);
    }

    // =========================================================
    // 写：输出缓冲 + 零拷贝续发（对应 C++ handleWrite / doSendFile）
    // =========================================================

    private void send(byte[] data) {
        if (data == null || data.length == 0) {
            return;
        }
        outQueue.add(ByteBuffer.wrap(data));
    }

    private boolean hasPendingOutput() {
        return !outQueue.isEmpty() || pendingFile != null;
    }

    /** 尝试把「输出缓冲 + 待发文件」全部推出去；发不完就武装 OP_WRITE 等下次。 */
    private void flush() {
        if (!key.isValid()) {
            return;
        }
        try {
            // 1. 先发完应用层缓冲（响应头 / 目录列表 / 错误页）
            while (!outQueue.isEmpty()) {
                ByteBuffer buf = outQueue.peek();
                int n = channel.write(buf);
                if (n <= 0) {
                    break;   // 内核发送缓冲满，交给 OP_WRITE 续发
                }
                if (!buf.hasRemaining()) {
                    outQueue.poll();
                }
            }
            // 2. 缓冲清空后，零拷贝续发文件（保证「响应头在前、文件体在后」）
            if (outQueue.isEmpty() && pendingFile != null) {
                transferPendingFile();
            }
            // 3. 收尾：还有待发数据则武装写事件，否则解除并视情况关闭
            if (hasPendingOutput()) {
                loop.setInterest(key, SelectionKey.OP_READ | SelectionKey.OP_WRITE);
            } else {
                loop.setInterest(key, SelectionKey.OP_READ);
                if (peerClosed || closeAfterWrite) {
                    close();
                }
            }
        } catch (IOException e) {
            close();
        }
    }

    /**
     * 零拷贝发文件（对应 C++ doSendFile 的 sendfile 循环）。
     *
     * <p>优先用 {@link FileChannel#transferTo}；个别平台/场景下 transferTo 对
     * 非阻塞 socket 可能不前进，此时退回「读一块、写一块」的兜底路径，
     * 因为随时可以按偏移重新读文件，兜底不会造成重复发送或数据丢失。
     */
    private void transferPendingFile() throws IOException {
        if (!useFallback) {
            try {
                while (fileOffset < fileSize) {
                    long n = pendingFile.transferTo(fileOffset, fileSize - fileOffset, channel);
                    if (n > 0) {
                        fileOffset += n;
                        stallCount = 0;
                        continue;
                    }
                    if (++stallCount < 2) {
                        return;             // 正常的「发送缓冲满」，等 OP_WRITE
                    }
                    useFallback = true;     // 连续零进展，切兜底
                    break;
                }
            } catch (IOException | UnsupportedOperationException e) {
                useFallback = true;         // 平台不支持零拷贝，切兜底
            }
            if (!useFallback) {
                closePendingFile();
                return;
            }
        }

        while (fileOffset < fileSize) {
            long before = fileOffset;
            fallbackCopy();
            if (fileOffset == before) {
                return;                     // 写不进去，等 OP_WRITE
            }
        }
        closePendingFile();
    }

    private void fallbackCopy() throws IOException {
        int want = (int) Math.min(FALLBACK_CHUNK, fileSize - fileOffset);
        if (want <= 0) {
            return;
        }
        ByteBuffer chunk = ByteBuffer.allocate(want);
        int r = pendingFile.read(chunk, fileOffset);
        if (r <= 0) {
            return;
        }
        chunk.flip();
        int w = channel.write(chunk);
        if (w > 0) {
            fileOffset += w;
        }
    }

    private void closePendingFile() {
        if (pendingFile != null) {
            try {
                pendingFile.close();
            } catch (IOException ignored) {
            }
            pendingFile = null;
        }
        fileOffset = 0;
        fileSize = 0;
        stallCount = 0;
    }

    private void close() {
        closePendingFile();
        EventLoop.closeKey(key);
    }
}
