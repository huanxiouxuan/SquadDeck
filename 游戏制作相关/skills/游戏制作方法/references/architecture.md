# 架构与契约

## 三层结构

| 层 | 位置 | 谁改它 |
|---|---|---|
| **内核** | `lkserver2-game.jar`（源码 `src/lkserver/`） | 几乎不改。只有做新机制时才动，动完要重编 jar + 重启 |
| **启动器** | `www/`（`index.html` + `launcher.js`） | 很少改。改完刷新页面即生效 |
| **游戏** | `gamemode/<id>/` | **日常都在这一层**。放文件 / 导入即可，不用重编、不用重启 |

内核 `<->` 游戏之间只有三个约定：静态文件路由、四个通用接口、`game.json` 的 `world` 字段。

## 游戏的目录约定

```
gamemode/<id>/
├── game.json          元数据（必备）
├── index.html         入口页（entry，默认 index.html）
├── game.js            玩法
├── sfx/ assets/ ...   其它静态文件，随便放（会被原样提供）
└── server/            ★ 可选：自带服务端代码
    ├── XxxWorld.java  源码（内核用 JDK 现场编译）
    └── 或 ../server.jar  预编译插件包
```

导入后还会多两个内核生成的东西：`game.json`（服务端按新 id 重写）和
`.server-classes/`（源码编译产物）。**不要手写 `.server-classes/`**。

## game.json 字段

```json
{
  "id": "mygame",
  "name": "我的游戏",
  "desc": "一句话简介",
  "icon": "🎮",
  "entry": "index.html",
  "world": "lkserver.MyWorld",
  "autostart": false,
  "version": 1
}
```

| 字段 | 说明 |
|---|---|
| `id` | `[a-z0-9_-]`，≤32。目录名 / URL 片段 |
| `name` | ≤12 字符 |
| `desc` | ≤60 字符 |
| `icon` | emoji，或游戏目录里的图片文件名（如 `tank.ico`） |
| `entry` | 入口页，防目录穿越 |
| `api` | 接口前缀，**仅展示用**；真实路由按 id |
| `world` | 联机才写。类全限定名，必须能 `Class.forName` 到 |
| `autostart` | `true` = 服务器启动时自动拉起；只在**启动时**读一次 |
| `version` | 随便 |

## HTTP 接口

### 启动器用的

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/games` | 游戏列表。每个带 `srv`（有无服务端）、`run`（是否在跑）；顶层 `host`（你是不是房主） |
| POST | `/api/games/import` | 导入第一步：建目录 + 写 game.json（校验路径/大小/重复） |
| POST | `/api/games/upload?game=&path=` | 导入第二步：写单个文件（body = 字节） |
| POST | `/api/games/<id>/start\|stop` | 房主专属：启停世界 |
| POST | `/api/games/<id>/delete` | 房主专属：删游戏（先停世界，有玩家则拒绝） |
| GET | `/api/chat?after=` / POST | 启动器的全服聊天。**与游戏无关** |
| GET | `/api/net` | 本机可分享的 IPv4 地址 |

### 游戏用的（通用路由，所有联机游戏共用）

| 方法 | 路径 | 参数 | 说明 |
|---|---|---|---|
| POST | `/api/<id>/join` | `name`, `cid` | 返回世界自定义 JSON，**必须含 `id`** |
| POST | `/api/<id>/sync` | `id` + 自定义 | 上报输入 + 拿回快照 |
| POST | `/api/<id>/leave` | `id` | 主动退出 |
| GET | `/api/<id>/info` | — | 概览 |

状态码语义：
- **409** = 游戏存在但世界没启动（房主没拨开关）
- **404** = 游戏不存在 / 没有服务端世界
- **403** = 非房主在做房主专属操作

## 世界加载（游戏自带服务端）

`WorldRegistry` 启动一个世界时按优先级找类：

1. `gamemode/<id>/server.jar`
2. `gamemode/<id>/server/**/*.java` → **用 JDK 现场编译**到 `.server-classes/` → 加载
3. 都找不到 → 回落内核内置类

编译时 classpath 带内核 jar，所以**插件源码可以直接用 `Json`、`GameWorldPlugin`**
这些内核类，前提是 `package lkserver;`。

类加载器是 `URLClassLoader`，父加载器 = 内核类加载器 —— 这让插件里的
`implements GameWorldPlugin` 解析到内核那个接口（不会出现"同名接口两个副本"）。

**增量编译**：`.java` 比 `.class` 新时才重编。所以在启动器上 stop→start 就能
应用服务端改动。

⚠️ 现场编译需要 JDK（有 `javac`）。只有 JRE 时改用 `server.jar`。

## 启停 / 上限 / 删除

- **房主**判定：请求来源 IP 是回环或本机网卡地址。好友拨不动开关（403）。
- **同时运行上限 4** 个（`WorldRegistry.MAX_RUNNING`）。每个运行中的世界
  常驻一个 tick 线程。
- **有玩家时停不掉、也删不掉**（用 `playerCount()` 判断）。
- **删除**会连同 `gamemode/<id>/` 整个目录删掉，不可恢复。

## 导入流程（启动器侧）

1. 选文件夹 → 读 `game.json`（元数据）+ 列出全部文件
2. `POST /api/games/import`：建目录、按**新 id** 写 `game.json`
3. 逐个 `POST /api/games/upload`：写文件（**`game.json` 本体不上传**）
4. 刷新列表，自动选中新游戏

上限：单文件 32MB、总量 512MB、文件数 2000。

选错文件夹（既没有 `game.json` 也没有 `.html`）会被前端直接拦下。
