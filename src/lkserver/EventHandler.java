package lkserver;

import java.io.IOException;
import java.nio.channels.SelectionKey;

/**
 * 统一的事件处理接口，对应 C++ 版 server2.h 中 Channel 的
 * read/write/error 三类回调。
 *
 * <p>做法与 C++ 版一致：把一个「fd + 关注的事件 + 回调」封装起来，
 * 由反应堆在事件就绪时回调。Java 里用 {@link SelectionKey} 作为句柄，
 * 回调实现挂在 key 的 attachment 上。
 */
@FunctionalInterface
public interface EventHandler {
    void handle(SelectionKey key) throws IOException;
}
