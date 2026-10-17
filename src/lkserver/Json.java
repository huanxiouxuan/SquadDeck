package lkserver;

/**
 * 极简 JSON 工具：既做"写出"（拼接响应），也做"解析"（读 game.json）。
 *
 * <p>为了让这个游戏保持<b>零第三方依赖</b>（和原项目一样只用 JDK 标准库），
 * 这里没有引入 Jackson/Gson：序列化只提供最常用的两个动作（转义加引号、
 * 数字格式化），解析用一个紧凑的递归下降解析器，支持对象/数组/字符串/
 * 数字/布尔/null——读取游戏清单这种小 JSON 足够用。
 */
public final class Json {

    private Json() {
    }

    /** 把字符串转义并加上双引号；{@code null} 输出 JSON 的 {@code null}。 */
    public static String quote(String s) {
        if (s == null) {
            return "null";
        }
        StringBuilder b = new StringBuilder(s.length() + 2);
        b.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':
                    b.append("\\\"");
                    break;
                case '\\':
                    b.append("\\\\");
                    break;
                case '\n':
                    b.append("\\n");
                    break;
                case '\r':
                    b.append("\\r");
                    break;
                case '\t':
                    b.append("\\t");
                    break;
                default:
                    if (c < 0x20) {
                        b.append(String.format("\\u%04x", (int) c));
                    } else {
                        b.append(c);
                    }
            }
        }
        b.append('"');
        return b.toString();
    }

    /** 数字输出：整数不带小数点，小数保留原样。 */
    public static String num(double d) {
        if (!Double.isInfinite(d) && !Double.isNaN(d) && d == Math.rint(d)) {
            return String.valueOf((long) d);
        }
        return String.valueOf(d);
    }

    // ===================== 解析 =====================

    /** JSON 解析失败。 */
    public static final class JsonException extends RuntimeException {
        public JsonException(String msg) {
            super(msg);
        }
    }

    /**
     * 解析一整段 JSON，返回 {@link java.util.Map} / {@link java.util.List} /
     * String / Double / Boolean / null。
     *
     * @throws JsonException 语法错误时抛出（调用方按「这个游戏加载失败」处理）
     */
    public static Object parse(String s) {
        if (s == null || s.isEmpty()) {
            throw new JsonException("empty json");
        }
        P p = new P(s);
        p.ws();
        Object v = p.value();
        p.ws();
        if (p.i < p.s.length()) {
            throw new JsonException("trailing garbage at " + p.i);
        }
        return v;
    }

    /** 递归下降解析器的游标。 */
    private static final class P {
        final String s;
        int i;

        P(String s) {
            this.s = s;
        }

        void ws() {
            while (i < s.length() && Character.isWhitespace(s.charAt(i))) {
                i++;
            }
        }

        char peek() {
            if (i >= s.length()) {
                throw new JsonException("unexpected end");
            }
            return s.charAt(i);
        }

        Object value() {
            char c = peek();
            switch (c) {
                case '{':
                    return object();
                case '[':
                    return array();
                case '"':
                    return string();
                case 't':
                    expect("true");
                    return Boolean.TRUE;
                case 'f':
                    expect("false");
                    return Boolean.FALSE;
                case 'n':
                    expect("null");
                    return null;
                default:
                    return number();
            }
        }

        void expect(String word) {
            if (!s.startsWith(word, i)) {
                throw new JsonException("expect " + word + " at " + i);
            }
            i += word.length();
        }

        java.util.Map<String, Object> object() {
            java.util.Map<String, Object> m = new java.util.LinkedHashMap<>();
            i++; // '{'
            ws();
            if (peek() == '}') {
                i++;
                return m;
            }
            while (true) {
                ws();
                String k = string();
                ws();
                if (peek() != ':') {
                    throw new JsonException("expect ':' at " + i);
                }
                i++;
                ws();
                m.put(k, value());
                ws();
                char c = peek();
                if (c == ',') {
                    i++;
                    continue;
                }
                if (c == '}') {
                    i++;
                    return m;
                }
                throw new JsonException("expect ',' or '}' at " + i);
            }
        }

        java.util.List<Object> array() {
            java.util.List<Object> l = new java.util.ArrayList<>();
            i++; // '['
            ws();
            if (peek() == ']') {
                i++;
                return l;
            }
            while (true) {
                ws();
                l.add(value());
                ws();
                char c = peek();
                if (c == ',') {
                    i++;
                    continue;
                }
                if (c == ']') {
                    i++;
                    return l;
                }
                throw new JsonException("expect ',' or ']' at " + i);
            }
        }

        String string() {
            if (peek() != '"') {
                throw new JsonException("expect string at " + i);
            }
            i++;
            StringBuilder b = new StringBuilder();
            while (true) {
                if (i >= s.length()) {
                    throw new JsonException("unterminated string");
                }
                char c = s.charAt(i++);
                if (c == '"') {
                    return b.toString();
                }
                if (c == '\\') {
                    if (i >= s.length()) {
                        throw new JsonException("bad escape");
                    }
                    char e = s.charAt(i++);
                    switch (e) {
                        case '"': b.append('"'); break;
                        case '\\': b.append('\\'); break;
                        case '/': b.append('/'); break;
                        case 'b': b.append('\b'); break;
                        case 'f': b.append('\f'); break;
                        case 'n': b.append('\n'); break;
                        case 'r': b.append('\r'); break;
                        case 't': b.append('\t'); break;
                        case 'u':
                            if (i + 4 > s.length()) {
                                throw new JsonException("bad \\u escape");
                            }
                            b.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
                            i += 4;
                            break;
                        default:
                            throw new JsonException("bad escape \\" + e);
                    }
                } else {
                    b.append(c);
                }
            }
        }

        Object number() {
            int start = i;
            if (i < s.length() && (s.charAt(i) == '-' || s.charAt(i) == '+')) {
                i++;
            }
            while (i < s.length()) {
                char c = s.charAt(i);
                if ((c >= '0' && c <= '9') || c == '.' || c == 'e' || c == 'E'
                        || c == '-' || c == '+') {
                    i++;
                } else {
                    break;
                }
            }
            String t = s.substring(start, i);
            if (t.isEmpty()) {
                throw new JsonException("expect value at " + start);
            }
            try {
                return Double.valueOf(t);
            } catch (NumberFormatException e) {
                throw new JsonException("bad number '" + t + "'");
            }
        }
    }

    // ---- 读取 game.json 用的便捷取值 ----

    /** 取字符串字段；不存在或类型不对时用默认值。 */
    public static String str(java.util.Map<String, Object> m, String key, String def) {
        Object v = m.get(key);
        return v instanceof String ? (String) v : def;
    }
}
