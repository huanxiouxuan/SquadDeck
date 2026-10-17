# AGENTS.md

给在此仓库工作的 AI 编码助手的约定。

## 本目录是什么

`游戏制作相关/skills/` 是「给 **lkserver2-game**（开黑启动器）做游戏」的知识包。
本文件是入口约定；详细内容在同级 `游戏制作方法/`。

## 做游戏前必读（按顺序）

1. `游戏制作方法/SKILL.md` —— 流程与五条红线
2. `游戏制作方法/references/architecture.md` —— 三层结构、接口、世界加载机制

按需深入：

| 任务 | 读哪个 |
|---|---|
| 写服务端世界 | `游戏制作方法/references/world-api.md` |
| 写前端 | `游戏制作方法/references/client-api.md` |
| 出 bug（透明 / 卡顿 / 404 / 占位页 / 开关不动） | `游戏制作方法/references/pitfalls.md` |
| 写自测脚本 | `游戏制作方法/references/testing.md` |
| 交付前核对 | `游戏制作方法/references/checklist.md` |

## 快速开工

```bash
# 单机
cp -r "游戏制作相关/skills/游戏制作方法/assets/templates/solo" ../gamemode/mygame
# 联机
cp -r "游戏制作相关/skills/游戏制作方法/assets/templates/multiplayer" ../gamemode/mygame
```

然后改 `game.json` 的 `id` / `name` / `desc` / `icon`，再改玩法。

## 铁律（违反必炸）

1. 客户端接口前缀**必须**从 `location.pathname` 取（导入后 id 会变成 `g<base36>`）
2. `game.json` 的 `id` 只含 `[a-z0-9_-]`，与目录名一致
3. 联机世界类必须 `package lkserver;`，并 `implements GameWorldPlugin`
4. `join` 返回的 JSON **必须含 `id`**
5. **服务端权威**：判定在服务端，客户端只上报意图

## 自检（交付前跑）

```bash
python "游戏制作相关/skills/游戏制作方法/scripts/check_game.py" <游戏目录>
```

## 不要做

- 不要改内核 `src/lkserver/`（那是另一个层面，改完要重编 jar）
- 不要手改 `gamemode/<id>/.server-classes/`（内核的编译产物）
- 游戏里**不要**实现表情 / 聊天（那是启动器的功能，与游戏零协议）
- 单机游戏**不要**写 `world`（会多出没用的启停开关）
