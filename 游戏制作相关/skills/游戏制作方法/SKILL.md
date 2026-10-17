---
name: lkserver2-game-maker
description: Build, modify, and debug mini-games for the lkserver2-game 开黑启动器 (a multi-game launcher whose kernel deliberately contains no game logic; each game is a self-contained folder with a game.json plus an optional server-side world class). Use when asked to 做一个XX小游戏 / 给启动器加个游戏 / 做个联机游戏 / 加房间 / 改游戏玩法, or when debugging 导入后是占位页、游戏 404、开关拨不动、409 未启动、渲染透明或卡顿、多人不同步.
license: 随本项目使用
agent_created: true
---

# 给「开黑启动器」做游戏

> **给任何 AI 的读法**：本文件是入口。先读完它，需要细节时再按末尾「资料索引」
> 读同目录的 `references/*.md`。如果运行环境只能读一个文件，改用上一级的
> `AI-游戏制作指南.md`（单文件自包含版）。**全程不需要联网**。
>
> 本文件用相对路径引用资源，整个 `游戏制作方法/` 目录请保持完整。

## 这个技能解决什么

在 `lkserver2-game`（"开黑启动器"）里**新增 / 修改 / 调试**小游戏。

核心前提：**内核里没有任何具体游戏**。每个游戏是一个独立文件夹，自带前端和
（可选的）服务端代码；启动器把它整份导入 `gamemode/`，内核在启动世界时
现场编译 / 加载它的 `server/` 代码。

所以做游戏的本质是：**产出一个自包含的文件夹**，而不是改内核。

## 第一步：判断类型（决定写几个文件）

| 类型 | 需要的文件 | 参考实现 |
|---|---|---|
| 纯单机 | `game.json` + `index.html` + `game.js` | `gamemode/snake/` |
| 联机（服务端权威） | 上面三个 + `server/XxxWorld.java` | `gamemode/tank/`、`gamemode/snake2/`、五子棋 |

判断标准：**是否需要多人同局、是否需要防作弊**。
需要 → 联机；不需要 → 单机（单机没有启停开关、随点随玩，体验反而更顺）。

## 第二步：搭骨架

复制 `assets/templates/solo/` 或 `assets/templates/multiplayer/` 到目标位置，
改 `game.json` 的 `id` / `name` / `desc` / `icon`，再改玩法。
两个模板都是**可运行的最小实现**（不是伪代码）。

## 第三步：照契约写（五条红线）

1. **客户端从 `location.pathname` 取游戏 id**
   —— 导入后 id 会变成 `g<base36时间戳>`，写死 `/api/xxx` 必然 404：
   ```js
   var GID = (location.pathname.match(/\/games\/([^\/]+)/) || [])[1] || 'mygame';
   var API = '/api/' + GID;
   ```
2. **`game.json` 的 `id` 只含 `[a-z0-9_-]`**，且与目录名一致。
3. **联机游戏的 world 类必须 `package lkserver;`**，并实现 `GameWorldPlugin`
   的七个方法（`start/stop/join/sync/leave/info/playerCount`）。
4. **`join` 必须返回带 `id` 的 JSON**，否则客户端进不去。
5. **服务端权威**：所有规则判定放服务端，客户端只上报意图；
   客户端算出来的只用于表现，不能作为事实。

## 第四步：跑起来验证

```bash
node --check <游戏目录>/game.js                          # 前端语法
curl -s -X POST http://127.0.0.1:8080/api/<id>/join \
     -d "name=测试&cid=c1"                               # 服务端接口
```

联机世界默认**不启动**：先 `POST /api/games/<id>/start`（房主身份 = 本机），
或让房主在启动器上拨开关。没启动时接口返回 **409**，这是正常的。

## 第五步：写自测脚本

照 `references/testing.md` 写 `test-<id>.js`，用 `fetch` 直接打接口
（不依赖浏览器）。至少覆盖：加入 / 同步 / 非法参数不崩 / 退出 / 核心规则。

## 第六步：导入实测（不能省）

启动器「＋ 添加游戏」→ 选**游戏文件夹本身**（含 `game.json` 的那一层，
**不要**双击进 `server/`）→ 确认：

- 点进去**不是占位页**
- 联机游戏右侧**有开关**且能拨
- 真正能玩

## 资料索引（同目录相对路径）

| 文件 | 什么时候读 |
|---|---|
| `references/architecture.md` | 分层、目录约定、接口契约、世界加载优先级、启停/删除/导入 |
| `references/world-api.md` | 写服务端世界：七方法语义、线程安全、离线清理、**可复制的最小实现** |
| `references/client-api.md` | 写前端：取 id、join/sync/leave、cid、409、渲染与插值 |
| `references/pitfalls.md` | **遇到"透明/卡顿/404/占位页/开关不动"先读这个** |
| `references/testing.md` | 自测脚本范式、必须覆盖什么 |
| `references/checklist.md` | 交付前逐条核对 |
| `scripts/check_game.py` | 一键体检：`python check_game.py <游戏目录>`（只读，不修改文件） |
| `assets/templates/` | 单机 / 联机 可运行骨架 |

## 环境要求

- **JDK 17+**（联机游戏：内核运行时要能用 `javac` 现场编译 `server/*.java`；
  只有 JRE 时改用 `server.jar`）
- **Node.js**（跑自测脚本；非必需）
- 服务器默认 `http://127.0.0.1:8080`

## 特别提醒

- **表情栏和聊天框属于启动器，不属于任何游戏**（全服共享、走内核 `/api/chat`、
  与游戏零协议）。游戏只需接 `postMessage` 的 `kaihei === 'name'`（名字登记），
  **不要**自己实现表情/聊天。
- 改游戏**前端**：存盘即生效，浏览器 Ctrl+F5。
- 改游戏**服务端**：在启动器上把开关关了再开（会重新编译加载），
  **不用重编 jar、不用重启服务器**。
- 改**内核**要重编 jar —— 那不属于本技能范围。
