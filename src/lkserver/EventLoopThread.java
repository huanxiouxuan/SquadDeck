package lkserver;

import java.io.IOException;
import java.util.concurrent.CountDownLatch;

/**
 * 一个线程跑一个反应堆（one loop per thread），对应 C++ 的 EventLoopThread。
 *
 * <p>C++ 用 pthread + 条件变量等待「子反应堆创建完成」；这里用
 * {@link CountDownLatch} 达到同样效果。
 */
public class EventLoopThread {

    private final String name;
    private EventLoop loop;
    private Thread thread;

    public EventLoopThread(String name) {
        this.name = name;
    }

    /** 启动线程并等待其反应堆创建完成，返回该反应堆。 */
    public EventLoop start() {
        final CountDownLatch ready = new CountDownLatch(1);
        thread = new Thread(() -> {
            try {
                loop = new EventLoop(name);
                ready.countDown();
                loop.run();
            } catch (IOException e) {
                ready.countDown();
                System.err.println("[" + name + "] 启动失败: " + e.getMessage());
            }
        }, name);
        thread.setDaemon(false);
        thread.start();
        try {
            ready.await();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        return loop;
    }

    public EventLoop getLoop() {
        return loop;
    }

    public Thread getThread() {
        return thread;
    }

    public void join() {
        if (thread == null) {
            return;
        }
        try {
            thread.join();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
