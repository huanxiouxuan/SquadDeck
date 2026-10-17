package lkserver;

import java.util.ArrayList;
import java.util.List;

/**
 * 子反应堆线程池（主从 Reactor 模型的「子端」），对应 C++ 的 EventLoopThreadPool。
 *
 * <p>每个线程跑一个子反应堆；主反应堆 accept 到新连接后，用
 * {@link #getNextLoop(EventLoop)} 轮询分配，做负载均衡。
 */
public class EventLoopThreadPool {

    private final List<EventLoopThread> threads = new ArrayList<>();
    private final List<EventLoop> loops = new ArrayList<>();
    private int index = 0;

    public void start(int threadNum, String namePrefix) {
        for (int i = 0; i < threadNum; i++) {
            EventLoopThread t = new EventLoopThread(namePrefix + i);
            EventLoop loop = t.start();
            threads.add(t);
            loops.add(loop);
        }
    }

    /** 轮询取一个子反应堆（对应 C++ 的 getNextLoop）。 */
    public EventLoop getNextLoop(EventLoop fallback) {
        if (loops.isEmpty()) {
            return fallback;
        }
        int i = Math.floorMod(index++, loops.size());
        return loops.get(i);
    }

    public List<EventLoop> getLoops() {
        return loops;
    }

    /** 优雅关闭：通知所有子反应堆退出并回收线程（对应 C++ 的 stopAll）。 */
    public void stopAll() {
        for (EventLoop loop : loops) {
            loop.stop();
        }
        for (EventLoopThread t : threads) {
            t.join();
        }
    }
}
