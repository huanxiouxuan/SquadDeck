package lkserver;

import java.io.IOException;
import java.nio.channels.SelectableChannel;
import java.nio.channels.SelectionKey;
import java.nio.channels.Selector;
import java.util.Iterator;
import java.util.Set;
import java.util.concurrent.ConcurrentLinkedQueue;

/**
 * 反应堆（Reactor）：持有一个 {@link Selector}，循环等待 I/O 事件并分发回调。
 *
 * <p>对应 C++ 版 server2.h 中的 {@code class EventLoop}。与 C++ 版的对应关系：
 * <ul>
 *   <li>C++ 里 select / poll / epoll 三套 fd 集合 + eventfd 唤醒；
 *       Java 统一为 {@link Selector}（JDK 会在各平台选用合适的底层实现），
 *       跨线程唤醒由 {@link Selector#wakeup()} 提供，语义等同 C++ 的 eventfd 唤醒，
 *       同样消除了「固定超时轮询」带来的延迟。</li>
 *   <li>C++ 允许一个线程直接往另一个线程的 epoll 里注册 fd；Java 的 Selector
 *       不允许在 {@code select()} 阻塞期间被注册/注销。因此这里改为
 *       「投递任务 + wakeup」模型（与 Netty 的做法相同）：所有注册、注销、
 *       关闭操作都在本反应堆线程内完成，天然避免了跨线程数据竞争
 *       （C++ 版需要用一把 mutex 保护 channelMap，这里不再需要）。</li>
 * </ul>
 */
public class EventLoop {

    private final Selector selector;
    private final String name;
    private volatile boolean quit = false;
    private final ConcurrentLinkedQueue<Runnable> tasks = new ConcurrentLinkedQueue<>();
    private Thread ownerThread;

    public EventLoop(String name) throws IOException {
        this.name = name;
        this.selector = Selector.open();
    }

    public String getName() {
        return name;
    }

    public Thread getOwnerThread() {
        return ownerThread;
    }

    public void setOwnerThread(Thread t) {
        this.ownerThread = t;
    }

    public boolean isInLoopThread() {
        return Thread.currentThread() == ownerThread;
    }

    /** 注册通道与回调，返回 SelectionKey。必须在反应堆线程内调用。 */
    public SelectionKey register(SelectableChannel ch, int ops, EventHandler handler) throws IOException {
        ch.configureBlocking(false);
        SelectionKey key = ch.register(selector, ops);
        key.attach(handler);
        return key;
    }

    /** 修改感兴趣的事件（对应 C++ 的 modifyChannel / Channel::setEvent）。 */
    public void setInterest(SelectionKey key, int ops) {
        try {
            if (key != null && key.isValid()) {
                key.interestOps(ops);
            }
        } catch (java.nio.channels.CancelledKeyException ignored) {
            // 连接已被关闭，忽略
        }
    }

    /** 投递任务到本反应堆线程执行，并立即唤醒阻塞中的 select()。 */
    public void execute(Runnable task) {
        tasks.add(task);
        selector.wakeup();
    }

    /** 请求退出循环（对应 C++ 的 EventLoop::stop：置退出标志 + 唤醒）。 */
    public void stop() {
        quit = true;
        selector.wakeup();
    }

    public boolean isQuit() {
        return quit;
    }

    /** 关闭某个 key 对应的通道（对应 C++ 的 destroyConnection 收尾）。 */
    public static void closeKey(SelectionKey key) {
        if (key == null) {
            return;
        }
        try {
            SelectableChannel ch = key.channel();
            key.cancel();
            if (ch != null) {
                ch.close();
            }
        } catch (IOException ignored) {
        }
    }

    /** 反应堆主循环：跑任务 -> select -> 分发就绪事件。 */
    public void run() {
        ownerThread = Thread.currentThread();
        try {
            while (!quit) {
                runPendingTasks();
                if (quit) {
                    break;
                }
                selector.select();
                runPendingTasks();
                dispatch();
            }
        } catch (IOException e) {
            if (!quit) {
                System.err.println("[" + name + "] 反应堆异常: " + e.getMessage());
            }
        } finally {
            closeAll();
        }
    }

    private void runPendingTasks() {
        Runnable t;
        while ((t = tasks.poll()) != null) {
            try {
                t.run();
            } catch (RuntimeException e) {
                System.err.println("[" + name + "] 任务执行异常: " + e);
            }
        }
    }

    private void dispatch() {
        Set<SelectionKey> keys = selector.selectedKeys();
        Iterator<SelectionKey> it = keys.iterator();
        while (it.hasNext()) {
            SelectionKey key = it.next();
            it.remove();
            if (!key.isValid()) {
                continue;
            }
            EventHandler handler = (EventHandler) key.attachment();
            if (handler == null) {
                continue;
            }
            try {
                handler.handle(key);
            } catch (IOException e) {
                closeKey(key);
            } catch (RuntimeException e) {
                System.err.println("[" + name + "] 处理事件异常: " + e);
                closeKey(key);
            }
        }
    }

    private void closeAll() {
        for (SelectionKey key : selector.keys()) {
            closeKey(key);
        }
        try {
            selector.close();
        } catch (IOException ignored) {
        }
    }
}
