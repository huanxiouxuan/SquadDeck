package lkserver;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.StandardSocketOptions;
import java.nio.channels.SelectionKey;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;

/**
 * 接收器：运行在主反应堆上，负责监听套接字的读事件（即接受新连接），
 * 并把新连接轮询分发给子反应堆。对应 C++ 的 class Acceptor + acceptC。
 */
public class Acceptor {

    private final EventLoop mainLoop;
    private final EventLoopThreadPool pool;
    private final ServerContext ctx;
    private ServerSocketChannel serverChannel;

    public Acceptor(EventLoop mainLoop, EventLoopThreadPool pool, ServerContext ctx) {
        this.mainLoop = mainLoop;
        this.pool = pool;
        this.ctx = ctx;
    }

    /** 初始化监听套接字并把它注册到主反应堆。 */
    public void init(int port) throws IOException {
        serverChannel = ServerSocketChannel.open();
        // 端口复用，避免重启时报「Address already in use」
        serverChannel.setOption(StandardSocketOptions.SO_REUSEADDR, true);
        serverChannel.bind(new InetSocketAddress(port), 128);
        mainLoop.register(serverChannel, SelectionKey.OP_ACCEPT, this::handleAccept);
    }

    /** 接受新连接的读事件回调（对应 C++ acceptC）。 */
    private void handleAccept(SelectionKey key) throws IOException {
        ServerSocketChannel ssc = (ServerSocketChannel) key.channel();
        SocketChannel accepted;
        while ((accepted = ssc.accept()) != null) {
            // 复制到 final 局部变量，才能被下面的 lambda 捕获
            final SocketChannel client = accepted;
            client.configureBlocking(false);
            client.setOption(StandardSocketOptions.TCP_NODELAY, true);

            // 轮询选一个子反应堆，把新连接交给它处理。
            // 注意：必须在子反应堆线程内注册（投递任务 + wakeup），
            // 这与 C++ 里「跨线程注册 fd 后 write(eventfd) 唤醒」是同一个思路。
            final EventLoop subLoop = pool.getNextLoop(mainLoop);
            subLoop.execute(() -> {
                try {
                    new TcpConnection(client, subLoop, ctx);
                } catch (IOException e) {
                    try {
                        client.close();
                    } catch (IOException ignored) {
                    }
                }
            });

            try {
                System.out.println("accept -> 新连接 " + client.getRemoteAddress()
                        + " 交给 " + subLoop.getName() + " 处理");
            } catch (IOException ignored) {
                // 取远端地址失败不影响连接处理
            }
        }
    }

    /** 停止接受新连接（对应 C++ 优雅关闭里从主反应堆移除监听通道）。 */
    public void close() {
        try {
            if (serverChannel != null && serverChannel.isOpen()) {
                serverChannel.close();
            }
        } catch (IOException ignored) {
        }
    }
}
