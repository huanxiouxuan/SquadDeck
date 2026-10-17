package lkserver;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

/**
 * 枚举本机对外可用的 IPv4 地址，供"把地址发给别人一起玩"使用。
 *
 * <p>只保留「正在启用、非回环、非链路本地(169.254.x)」的 IPv4 地址。
 * 这些地址才是别的电脑可能连得上的地址；而 {@code 127.0.0.1} 永远是"本机自己"，
 * 发给别人是无效的——这正是之前页面上误导人的地方。
 *
 * <p>虚拟网卡一般也连不上（VMware / VirtualBox / Hyper-V 那些），所以照旧排除；
 * <b>但「移动热点」类网卡必须例外</b>：Windows 开「移动热点」后，本机会多出一张
 * {@code Microsoft Wi-Fi Direct Virtual Adapter}（名字里带 Virtual，会被 Java 标成虚拟），
 * 它的地址通常是固定的 {@code 192.168.137.1}——别人的手机/电脑连上这个热点后，
 * 正是用这个地址来访问游戏的。一刀切按"虚拟"过滤会把这张关键网卡误杀掉。
 */
public final class NetInfo {

    /** 一个可分享的地址。 */
    public static final class Addr {
        /** 网卡显示名，例如 "以太网"、"Radmin VPN"。 */
        public final String label;
        public final String ip;

        Addr(String label, String ip) {
            this.label = label;
            this.ip = ip;
        }

        public String url(int port) {
            return "http://" + ip + ":" + port + "/";
        }
    }

    private NetInfo() {
    }

    /** 取出本机所有可分享的 IPv4 地址（已排除回环 / 无用虚拟网卡 / 链路本地）。 */
    public static List<Addr> shareAddresses() {
        List<Addr> list = new ArrayList<>();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) {
                    continue;
                }
                String label = displayName(ni);
                // 虚拟网卡排除，但热点网卡放行（见类注释）
                if (ni.isVirtual() && !looksLikeHotspot(ni, label)) {
                    continue;
                }
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (a instanceof Inet4Address
                            && !a.isLoopbackAddress()
                            && !a.isLinkLocalAddress()) {
                        list.add(new Addr(label, a.getHostAddress()));
                    }
                }
            }
        } catch (Exception e) {
            // 取网卡信息失败不影响功能，返回已收集到的部分
        }
        return list;
    }

    /**
     * 判断是不是「移动热点」网卡。
     *
     * <p>Windows 移动热点叫 {@code Microsoft Wi-Fi Direct Virtual Adapter}（中文系统里常显示为
     * 「本地连接* 数字」）；旧版的「承载网络 / Hosted Network」也是同类。这些名字里带
     * {@code Virtual}，会被 {@link NetworkInterface#isVirtual()} 标成虚拟，所以要按名字单独放行。
     */
    private static boolean looksLikeHotspot(NetworkInterface ni, String label) {
        String n = (label + " " + ni.getName()).toLowerCase(Locale.ROOT);
        return n.contains("wi-fi direct")
                || n.contains("wifi direct")
                || n.contains("hosted network")
                || n.contains("microsoft wi-fi")
                || n.contains("microsoft wifi")
                || n.contains("mobile hotspot")
                || n.contains("移动热点")
                || n.contains("无线热点")
                || n.contains("本地连接*")
                || n.contains("local area connection*");
    }

    private static String displayName(NetworkInterface ni) {
        try {
            String n = ni.getDisplayName();
            if (n != null && !n.isEmpty()) {
                return n;
            }
        } catch (Exception e) {
            // fall back below
        }
        return ni.getName();
    }
}
