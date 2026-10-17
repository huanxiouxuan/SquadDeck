#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""游戏目录体检：把「制作规范」里的硬性红线变成可自动检查的项。

用法：
    python check_game.py <游戏目录>

例：
    python check_game.py D:/项目/lkserver2-game/gamemode/my_game

只读，不会修改任何文件。输出 PASS / WARN / FAIL 三类：
  PASS 一定满足；
  WARN 看起来可疑，需要人工确认；
  FAIL 确定违反规范，必须改。
"""
import json
import re
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

PASS, WARN, FAIL = "PASS", "WARN", "FAIL"
results = []


def add(level, name, detail=""):
    results.append((level, name, detail))


def strip_js_comments(src):
    """去掉 JS 注释。

    否则注释里举的例子（例如「绝不能写死 /api/gomoku」）会被当成真代码误报。
    """
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    out = []
    for line in src.splitlines():
        s = line.lstrip()
        if s.startswith("//") or s.startswith("*"):
            continue
        out.append(line)
    return "\n".join(out)


def main():
    if len(sys.argv) < 2:
        print("用法: python check_game.py <游戏目录>")
        return 2

    root = Path(sys.argv[1]).expanduser().resolve()
    if not root.is_dir():
        print(f"[FAIL] 目录不存在: {root}")
        return 2

    print(f"== 体检: {root} ==\n")

    # ---------- 1. game.json ----------
    gj = root / "game.json"
    if not gj.is_file():
        add(FAIL, "game.json 存在", "没有 game.json，启动器不会认这个目录")
        meta = {}
    else:
        try:
            meta = json.loads(gj.read_text(encoding="utf-8"))
            add(PASS, "game.json 可解析")
        except Exception as e:  # noqa: BLE001
            add(FAIL, "game.json 可解析", str(e))
            meta = {}

    gid = str(meta.get("id", ""))
    if gid:
        if re.fullmatch(r"[a-z0-9_-]{1,32}", gid):
            add(PASS, "id 合法（[a-z0-9_-]，≤32）", gid)
        else:
            add(FAIL, "id 合法（[a-z0-9_-]，≤32）", f"实际: {gid!r}")
        if gid == root.name:
            add(PASS, "id 与目录名一致")
        else:
            add(WARN, "id 与目录名一致", f"id={gid!r} 目录名={root.name!r}（导入时会被改写，通常无妨）")
    else:
        add(FAIL, "id 字段存在", "game.json 缺 id")

    name = str(meta.get("name", ""))
    if name:
        add(PASS if len(name) <= 12 else WARN, "name 长度 ≤12", f"{len(name)} 字")
    else:
        add(FAIL, "name 字段存在")

    entry = str(meta.get("entry", "index.html"))
    if (root / entry).is_file():
        add(PASS, "入口页存在", entry)
    else:
        add(FAIL, "入口页存在", f"找不到 {entry}（点进去会是占位页）")

    world = meta.get("world")
    if world:
        if re.fullmatch(r"[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*", str(world)):
            add(PASS, "world 字段格式合法", world)
        else:
            add(FAIL, "world 字段格式合法", f"实际: {world!r}")
    else:
        add(PASS, "未声明 world（按纯单机处理）")

    # ---------- 2. 前端 ----------
    js_files = sorted(root.glob("*.js"))
    if not js_files:
        add(WARN, "存在 game.js", "目录下没有 .js")
    js_raw = "\n".join(p.read_text(encoding="utf-8", errors="replace") for p in js_files)
    js_text = strip_js_comments(js_raw)

    if "location.pathname" in js_text:
        add(PASS, "从 location.pathname 取游戏 id")
    else:
        add(WARN, "从 location.pathname 取游戏 id",
            "没找到 location.pathname —— 若用了别的动态取法可忽略；若写死了 id 则导入后必 404")

    # 硬编码 /api/xxx（排除拼接写法 /api/' + ...）
    hard = re.findall(r"/api/([A-Za-z0-9_-]+)", js_text)
    hard = [h for h in hard if h not in ("games", "net", "chat")]
    if hard:
        add(FAIL, "没有硬编码 /api/<名字>", "发现: " + ", ".join(sorted(set(hard))))
    else:
        add(PASS, "没有硬编码 /api/<名字>")

    if re.search(r"shadowBlur", js_text):
        add(WARN, "避免每帧 shadowBlur", "文件里用了 shadowBlur —— 确认它不在每帧渲染路径上")
    else:
        add(PASS, "没有 shadowBlur")

    # ---------- 3. 服务端 ----------
    server_dir = root / "server"
    jar = root / "server.jar"
    java_files = sorted(server_dir.rglob("*.java")) if server_dir.is_dir() else []

    if not java_files and not jar.is_file():
        if world:
            add(FAIL, "联机游戏的 world 来源",
                "声明了 world，但既没有 server/*.java 也没有 server.jar")
        else:
            add(PASS, "纯单机（无服务端代码）")
    else:
        if jar.is_file():
            add(PASS, "存在 server.jar")
        if java_files:
            joined = "\n".join(p.read_text(encoding="utf-8", errors="replace") for p in java_files)
            if re.search(r"^\s*package\s+lkserver\s*;", joined, re.M):
                add(PASS, "源码 package lkserver;")
            else:
                add(FAIL, "源码 package lkserver;", "不在 lkserver 包里，用不了内核工具")
            if "implements GameWorldPlugin" in joined:
                add(PASS, "实现了 GameWorldPlugin")
            else:
                add(FAIL, "实现了 GameWorldPlugin")
            if re.search(r'join\s*\(', joined) and re.search(r'\\?"id\\?"', joined):
                add(PASS, "join 返回里看起来有 id 字段")
            else:
                add(WARN, "join 返回里看起来有 id 字段", "没匹配到，人工确认一下")

    # ---------- 输出 ----------
    order = {FAIL: 0, WARN: 1, PASS: 2}
    results.sort(key=lambda r: order[r[0]])

    n_fail = sum(1 for r in results if r[0] == FAIL)
    n_warn = sum(1 for r in results if r[0] == WARN)

    for level, name, detail in results:
        mark = {"PASS": "  PASS ", "WARN": "  WARN ", "FAIL": "  FAIL "}[level]
        line = mark + name
        if detail:
            line += "  -- " + detail
        print(line)

    print()
    print(f"== {sum(1 for r in results if r[0] == PASS)} 通过 / {n_warn} 警告 / {n_fail} 失败 ==")
    if n_fail:
        print("必须修完 FAIL 项，再导入启动器实测。")
        return 1
    if n_warn:
        print("没有硬伤；WARN 项建议人工确认。")
        return 0
    print("全部通过。记得再导入启动器实测一次。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
