# 自测脚本范式

## 为什么写

核心规则在服务端，用浏览器点很难覆盖边界情况（非法输入、房间满、断线、胜负）。
写一个 `node test-<id>.js`，直接打 HTTP 接口，几秒跑完。

可参考现成的：`lkserver2-game/test-gomoku.js`、`test-snake2.js`、`test-delete.js`。

## 骨架

```js
'use strict';
const BASE = 'http://127.0.0.1:8080';

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (extra ? '  -- ' + extra : '')); }
}

async function post(url, params) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString()
  });
  let d = null;
  try { d = await r.json(); } catch (e) { /* 忽略 */ }
  return { status: r.status, d };
}

(async function () {
  console.log('== 我的游戏测试 ==');
  // ... 用例 ...
  console.log('== 结果: ' + passed + ' 通过, ' + failed + ' 失败 ==');
  process.exit(failed ? 1 : 0);
})().catch(function (e) {
  console.error('测试脚本异常: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
```

## 联机世界要先启动

```js
const r = await post(BASE + '/api/games/' + GID + '/start', {});
ok(r.status === 200 || (r.status === 409 && /运行/.test((r.d && r.d.error) || '')),
   '世界已启动（或本来就在跑）', r.status);
```

（幂等写法：已在跑会返回 409「已经在运行了」，也算通过。）

## 找一个稳定的游戏 id

导入生成的 id 每次都变（`g<base36>`），测试**不要写死**，按名字查：

```js
const list = await (await fetch(BASE + '/api/games')).json();
const g = (list.games || []).find(x => x.name === '我的游戏');
const GID = g.id;
```

## 至少要覆盖

| 类别 | 断言 |
|---|---|
| 加入 | `join` 返回 `id`；同 cid 重进复用同一 id |
| 同步 | `sync` 返回本人状态；乱传参数不崩 |
| 非法输入 | 越界坐标 / 不存在 id / 缺参数 → 明确错误，不是 500 |
| 核心规则 | 胜负判定、计分、回合限制、房间满拒绝 |
| 退出 | `leave` 后别人看不到他；再 sync 得到 null |
| 生命周期 | 世界没启动 → 409；启动 → 200 |

## 注意

- 测试会**真实改动世界状态**（创建玩家、占座位），别在有真人玩的服务器上跑
- 等待类断言要给足窗口：地图越大、移动越慢，需要等得越久
  （例：60 格地图、150ms/格 → 最坏 9 秒）
- 需要跑多组参数时，**每组一个子进程**（同进程重跑会互相污染全局状态）
- 时序类断言可能被 CPU 峰值打出假失败（比如同时在做 Java 编译），单独重跑确认
