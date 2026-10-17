# 游戏制作技能包

给「开黑启动器」（lkserver2-game）做游戏的**完整知识 + 工具 + 模板**，
写成通用格式，**任何 AI 都能用**（不只 WorkBuddy）。

---

## 三种用法，按你的 AI 选一种

### ① 贴给聊天 AI（最简单，推荐）

把 **`AI-游戏制作指南.md`** 整个文件内容贴进对话，然后说：

> 按这份规范，给我做一个「打砖块」小游戏，纯单机，方向键控制挡板。

单文件自包含，不需要其它资料，也不需要联网。

### ② 给 AI 编码助手（Cursor / Claude Code / Codex / Aider …）

让它在**本目录**工作即可 —— 多数工具会自动读 `AGENTS.md`。
不能自动读的，把 `AGENTS.md` 或 `游戏制作方法/SKILL.md` 作为上下文给它。

### ③ 在 WorkBuddy 里（自动加载）

本目录是内容源；WorkBuddy 的入口是：
`D:\项目\.workbuddy\skills\lkserver2-game-maker\SKILL.md`（薄入口，指向这里）。

直接说"照制作规范做个 XX 游戏"就会自动加载。

---

## 目录结构

```
skills/
├── README.md                    ← 本文件（人类指引）
├── AGENTS.md                    ← AI 编码工具入口（通用约定）
├── AI-游戏制作指南.md            ← ★ 单文件自包含版（贴给任何 AI）
└── 游戏制作方法/                 ← 完整包
    ├── SKILL.md                 流程 + 五条红线 + 资料索引
    ├── references/
    │   ├── architecture.md      分层、目录、接口、世界加载
    │   ├── world-api.md         服务端世界（含可复制实现）
    │   ├── client-api.md        客户端（取 id / 三个接口 / 渲染）
    │   ├── pitfalls.md          ★ 症状→根因→解法（遇到 bug 先读）
    │   ├── testing.md           自测脚本范式
    │   └── checklist.md         交付前清单
    ├── scripts/
    │   └── check_game.py        一键体检
    └── assets/templates/
        ├── solo/                单机模板（点方块得分，可运行）
        └── multiplayer/         联机模板（全服计数，可运行，含 server/）
```

---

## 体检脚本

```bash
python "游戏制作方法/scripts/check_game.py" <游戏目录>
```

只读、不改文件。检查：`game.json` 合法性、id 规则、入口页存在、
有没有硬编码 `/api/`、服务端是否 `package lkserver;` / 实现接口 / `join` 含 id。
输出 `PASS / WARN / FAIL`，有 FAIL 就必须修完再导入。

---

## 两个可运行模板

| 模板 | 类型 | 说明 |
|---|---|---|
| `assets/templates/solo/` | 纯单机 | 30 秒点方块得分：rAF + dt、点击命中、最高分存本地 |
| `assets/templates/multiplayer/` | 联机 | 全服共享计数：join/sync/leave、cid 复用、离线清理、服务端权威 |

复制到 `gamemode/` 下改 `game.json` 的 id/name 就能用。

---

## 前置条件

- **JDK 17+** —— 联机游戏的服务端源码要现场编译（只有 JRE 时改用 `server.jar`）
- **Node.js** —— 跑自测脚本（可选）
- 服务器默认在 `http://127.0.0.1:8080`

---

## 相关文档

- 给人读的完整规范：`..\制作提醒\游戏制作规范.md`
- 启动器使用说明：`..\..\README.md`、`..\..\游戏启动相关\游戏启动指导.txt`
