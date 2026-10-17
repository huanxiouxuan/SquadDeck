// 双 Edge 无头端到端验证：启动器聊天/表情公共频道 + 焦点管理 + 游戏零联系
//
// 场景：
//   实例 A（CDP 9222）：启动器 → 五子棋，创建房间
//   实例 B（CDP 9223）：启动器 → 贪吃蛇联机版，加入对局
//   两人分处不同游戏，验证：
//     ① 焦点管理：B 点启动器表情按钮后，贪吃蛇 iframe 仍收 WASD（需求①回归）
//     ② 聊天共通：B 发文字/表情，A 底栏收到；A 发，B 收到（全服单房间，不按游戏分房）
//     ③ 零联系：五子棋 iframe 里没有任何聊天/表情 DOM；旧协议 postMessage 表情无反应
//     ④ 双实例最终都进五子棋同一房间（A 建房、B 输房间码加入），期间聊天继续共通
//
// 运行：node 测试文件/test-chat-e2e.js（服务器须已在 8080 跑着）
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const BASE = 'http://127.0.0.1:8080';
const PROF_A = 'C:/Users/33763/AppData/Local/Temp/wb-cdp-a';
const PROF_B = 'C:/Users/33763/AppData/Local/Temp/wb-cdp-b';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  console.log((ok ? '  PASS ' : '  FAIL ') + '| ' + name + (detail ? ' | ' + detail : ''));
  if (ok) { pass++; } else { fail++; failures.push(name + (detail ? ' | ' + detail : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

// ---------------- CDP 客户端 ----------------
async function launchEdge(port, profileDir) {
  fs.mkdirSync(profileDir, { recursive: true });
  const child = spawn(EDGE, [
    '--headless=new',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profileDir,
    '--no-proxy-server',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1600,1000',
    'about:blank',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/json/version');
      if (r.ok) { return child; }
    } catch (e) { /* 未就绪 */ }
    await sleep(200);
  }
  throw new Error('Edge CDP 端口 ' + port + ' 未就绪');
}

function connectCdp(port) {
  return (async () => {
    const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    const page = list.find((t) => t.type === 'page');
    if (!page) { throw new Error('找不到 page target'); }
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws 连接失败')); });
    let msgId = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) { rej(new Error(m.error.message)); } else { res(m.result); }
      }
    };
    function send(method, params) {
      const id = ++msgId;
      return new Promise((res, rej) => {
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params: params || {} }));
        setTimeout(() => {
          if (pending.has(id)) { pending.delete(id); rej(new Error(method + ' 超时')); }
        }, 20000);
      });
    }
    await send('Page.enable');
    await send('Runtime.enable');
    return { send };
  })();
}

async function ev(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails.exception && r.exceptionDetails.exception.description;
    throw new Error('页面异常: ' + (d || r.exceptionDetails.text));
  }
  return r.result.value;
}

async function goto(cdp, url) {
  await cdp.send('Page.navigate', { url });
  for (let i = 0; i < 80; i++) {
    await sleep(150);
    if (await ev(cdp, 'document.readyState') === 'complete') { return; }
  }
  throw new Error('导航超时: ' + url);
}

async function box(cdp, selector) {
  const b = await ev(cdp, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  })()`);
  if (!b || !b.w || !b.h) { throw new Error('元素不可见: ' + selector); }
  return b;
}

async function clickAt(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function clickEl(cdp, selector) {
  const b = await box(cdp, selector);
  await clickAt(cdp, b.x, b.y);
  return b;
}

/** iframe 内元素在父文档视口中的坐标（同源，可直接读 contentDocument）。 */
async function iframeBox(cdp, selector) {
  const b = await ev(cdp, `(() => {
    const f = document.getElementById('stage');
    if (!f || !f.contentDocument) return null;
    const el = f.contentDocument.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const fr = f.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { x: fr.left + r.left + r.width / 2, y: fr.top + r.top + r.height / 2, w: r.width, h: r.height };
  })()`);
  if (!b || !b.w || !b.h) {
    const dbg = await ev(cdp, `(() => {
      const f = document.getElementById('stage');
      const d = f.contentDocument;
      return JSON.stringify({
        src: f.src,
        url: d ? d.URL : null,
        ready: d ? d.readyState : null,
        hasEl: !!(d && d.querySelector(${JSON.stringify(selector)})),
        loads: (window.__iframeLoads == null ? 'unset' : window.__iframeLoads),
        ovWelcomeHidden: !!(d && d.getElementById('ovWelcome') && d.getElementById('ovWelcome').classList.contains('hidden')),
        overlayHidden: !!(d && d.getElementById('overlay') && d.getElementById('overlay').classList.contains('hidden')),
      });
    })()`).catch(() => 'dump 失败');
    await sleep(600);
    const again = await ev(cdp, `(() => {
      const f = document.getElementById('stage');
      const d = f.contentDocument;
      const el = d && d.querySelector(${JSON.stringify(selector)});
      const r = el ? el.getBoundingClientRect() : null;
      return JSON.stringify({ ready: d ? d.readyState : null, w: r ? Math.round(r.width) : -1, h: r ? Math.round(r.height) : -1, loads: window.__iframeLoads == null ? 'unset' : window.__iframeLoads });
    })()`).catch(() => 'retry 失败');
    throw new Error('iframe 内元素不可见: ' + selector + ' | 现场: ' + dbg + ' | 600ms 后: ' + again);
  }
  return b;
}

async function clickInIframe(cdp, selector) {
  const b = await iframeBox(cdp, selector);
  await clickAt(cdp, b.x, b.y);
  return b;
}

/** 等 iframe 内元素真正可见（大厅层等异步展开后再点）。
 *  判据含 readyState==='complete'：导航中途 contentDocument 会被整体替换，
 *  「上一份文档有布局、下一份还在 loading」会让两次连查一个有一个无。 */
async function waitIframeVisible(cdp, selector, timeout, label) {
  return waitFor(async () => {
    const b = await ev(cdp, `(() => {
      const f = document.getElementById('stage');
      if (!f || !f.contentDocument) return null;
      const d = f.contentDocument;
      if (d.readyState !== 'complete') return null;
      const el = d.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return (r.width > 4 && r.height > 4) ? 1 : 0;
    })()`);
    return b ? true : null;
  }, timeout, label);
}

/** 等 iframe 导航到目标游戏并加载完成（点卡片会重设 src，触发一次新导航）。
 *  导航提交有几百毫秒延迟，期间旧文档仍是 complete 且按钮可见——只看 readyState
 *  会被旧文档骗过。调用方先给当前文档打 __marker，这里只认「marker 已随旧文档
 *  销毁 + 新文档 complete」；3 秒兜底（src 相同未触发重载时旧文档就是目标）。 */
async function waitIframeReady(cdp, urlPart, timeout, label) {
  const t0 = Date.now();
  return waitFor(async () => {
    const s = await ev(cdp, `(() => {
      const f = document.getElementById('stage');
      const d = f && f.contentDocument;
      return JSON.stringify({
        marker: !!(d && d.__marker),
        ready: d ? d.readyState : null,
        srcOk: f.src.indexOf(${JSON.stringify(urlPart)}) >= 0,
      });
    })()`).then((x) => JSON.parse(x));
    if (s.srcOk && s.ready === 'complete' && (Date.now() - t0 > 3000 || !s.marker)) { return true; }
    return null;
  }, timeout, label);
}

/** 切换游戏：给旧文档打标记 → 真实点击卡片 → 等新文档就绪。 */
async function switchGame(cdp, gameId, urlPart, label) {
  await ev(cdp, `(() => {
    const d = document.getElementById('stage').contentDocument;
    if (d) { d.__marker = 1; }
    return 1;
  })()`);
  await clickEl(cdp, '.game-item[data-id="' + gameId + '"]');
  await waitIframeReady(cdp, urlPart, 15000, label);
}

async function clickInIframeWhenReady(cdp, selector, timeout, label) {
  await waitIframeVisible(cdp, selector, timeout, label);
  return clickInIframe(cdp, selector);
}

async function tapKey(cdp, key, code, vk) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
}
const tapW = (cdp) => tapKey(cdp, 'w', 'KeyW', 87);
const tapD = (cdp) => tapKey(cdp, 'd', 'KeyD', 68);

async function tapEnter(cdp) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
}

/** 动态栏快照：[{name,text,me,emoji}] */
function feedSnapshot(cdp) {
  return ev(cdp, `JSON.stringify(Array.from(document.querySelectorAll('#emoteFeed .feed-item')).map(e => ({
    name: (e.querySelector('b') || {}).textContent || '',
    text: (e.querySelector('span') || {}).textContent || '',
    me: e.classList.contains('me'),
    emoji: !e.classList.contains('txt')
  })))`).then((s) => JSON.parse(s));
}

async function waitFeedHas(cdp, want, timeout, label) {
  const t0 = Date.now();
  let last = [];
  while (Date.now() - t0 < timeout) {
    last = await feedSnapshot(cdp);
    const hit = last.find((m) =>
      (want.name === undefined || m.name === want.name) &&
      (want.text === undefined || m.text === want.text) &&
      (want.me === undefined || m.me === want.me) &&
      (want.emoji === undefined || m.emoji === want.emoji));
    if (hit) { return hit; }
    await sleep(250);
  }
  throw new Error('等待超时[' + label + ']，当前动态栏: ' + JSON.stringify(last));
}

function waitFor(fn, timeout, label) {
  const t0 = Date.now();
  return (async () => {
    while (Date.now() - t0 < timeout) {
      try { const v = await fn(); if (v) { return v; } } catch (e) { /* 继续等 */ }
      await sleep(200);
    }
    throw new Error('等待超时: ' + label);
  })();
}

/** 给 iframe 装键盘探针（真实按键是否送达 iframe 文档，直接观测，不靠游戏内部状态）。 */
async function armKeyboardProbe(cdp) {
  return ev(cdp, `(() => {
    const f = document.getElementById('stage');
    if (!f || !f.contentWindow) return 'no-iframe';
    const w = f.contentWindow;
    w.__keys = [];
    w.addEventListener('keydown', (e) => { w.__keys.push(e.key); });
    return 'ok';
  })()`);
}

function iframeKeys(cdp) {
  return ev(cdp, `(() => {
    const f = document.getElementById('stage');
    return (f && f.contentWindow && f.contentWindow.__keys) ? JSON.stringify(f.contentWindow.__keys) : '[]';
  })()`).then((s) => JSON.parse(s));
}

function activeElementIsIframe(cdp) {
  return ev(cdp, `document.activeElement === document.getElementById('stage')`);
}

async function setName(cdp, name) {
  await ev(cdp, `(() => {
    const inp = document.getElementById('playerName');
    inp.value = ${JSON.stringify(name)};
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return inp.value;
  })()`);
}

// ---------------- 主流程 ----------------
(async () => {
  let edgeA = null, edgeB = null;
  try {
    section('启动双 Edge 无头实例');
    edgeA = await launchEdge(9222, PROF_A);
    edgeB = await launchEdge(9223, PROF_B);
    const A = await connectCdp(9222);
    const B = await connectCdp(9223);
    check('两个 CDP 会话就绪', true, 'A=9222 B=9223');

    section('打开启动器并登记名字');
    await goto(A, BASE + '/');
    await goto(B, BASE + '/');
    // 启动器打开就会自动选中并加载第一个游戏；等它就绪，后面的点卡片才是「切换」语义
    await waitIframeReady(A, '/games/', 15000, 'A 的启动器自动加载首个游戏');
    await waitIframeReady(B, '/games/', 15000, 'B 的启动器自动加载首个游戏');
    await setName(A, '甲玩家');
    await setName(B, '乙玩家');
    check('启动器页面加载 + 名字登记', true);

    section('A 进五子棋并创建房间');
    await switchGame(A, 'gmv9ny2bh', '/games/gmv9ny2bh/', 'A 的五子棋 iframe 就绪');
    await clickInIframeWhenReady(A, '#btnEnter', 10000, '五子棋「进入大厅」按钮可见');
    await clickInIframeWhenReady(A, '#btnCreate', 10000, '五子棋「创建房间」按钮可见');
    const roomCode = await waitFor(async () => {
      const c = await ev(A, `(() => {
        const f = document.getElementById('stage');
        const el = f && f.contentDocument && f.contentDocument.getElementById('roomCode');
        return el && /^[A-Z0-9]{4}$/.test(el.textContent.trim()) ? el.textContent.trim() : '';
      })()`);
      return c || null;
    }, 10000, '五子棋房间码');
    check('A 创建五子棋房间', true, '房间码=' + roomCode);

    section('B 进贪吃蛇联机版并加入对局');
    await switchGame(B, 'snake2', '/games/snake2/', 'B 的贪吃蛇 iframe 就绪');
    await clickInIframeWhenReady(B, '#join', 10000, '贪吃蛇「开始」按钮可见');
    await waitFor(async () => await ev(B, `(() => {
      const f = document.getElementById('stage');
      const ov = f && f.contentDocument && f.contentDocument.getElementById('overlay');
      return ov && ov.classList.contains('hidden') ? 1 : 0;
    })()`), 10000, '贪吃蛇 join 成功（overlay 收起）');
    check('B 加入贪吃蛇对局', true);
    await armKeyboardProbe(B);
    await sleep(500);

    section('① 焦点管理：点启动器表情后贪吃蛇 WASD 仍灵（需求①回归）');
    await tapW(B);
    await sleep(120);
    const keys1 = await iframeKeys(B);
    check('点表情前：iframe 收到 w', keys1.includes('w'), JSON.stringify(keys1));

    const emojiBtn = await box(B, '#emoteList button');
    await clickAt(B, emojiBtn.x, emojiBtn.y);   // 真实鼠标点启动器底栏表情按钮
    await sleep(250);
    const stillIframe = await activeElementIsIframe(B);
    check('点表情后：焦点仍在游戏 iframe（未被启动器抢走）', stillIframe === true,
      'activeElement===stage ? ' + stillIframe);

    await tapD(B);
    await sleep(120);
    const keys2 = await iframeKeys(B);
    check('点表情后：iframe 仍收到 d（WASD 没失灵）', keys2.includes('d'), JSON.stringify(keys2));

    section('② 聊天共通：B 发文字/表情 → A 底栏收到（分处不同游戏）');
    await clickEl(B, '#chatInput');
    await B.send('Input.insertText', { text: '大家好' });
    await tapEnter(B);
    await waitFeedHas(B, { text: '大家好', me: true, emoji: false }, 5000, 'B 自己的消息上屏');
    check('B 发文字：自己的动态栏立即出现（me 样式）', true);

    const gotText = await waitFeedHas(A, { name: '乙玩家', text: '大家好', me: false, emoji: false }, 5000, 'A 收到 B 的文字');
    check('A 底栏收到 B 的文字消息（跨游戏共通）', true, JSON.stringify(gotText));

    const emojiBtn2 = await box(B, '#emoteList button:nth-child(2)');
    await clickAt(B, emojiBtn2.x, emojiBtn2.y);
    const sentEmoji = await ev(B, `document.querySelector('#emoteList button:nth-child(2)').textContent`);
    const gotEmoji = await waitFeedHas(A, { name: '乙玩家', text: sentEmoji, me: false, emoji: true }, 5000, 'A 收到 B 的表情');
    check('A 底栏收到 B 的表情（大号表情样式，非文本）', true, JSON.stringify(gotEmoji));

    section('③ 零联系：五子棋 iframe 无任何聊天/表情 DOM；旧协议无反应');
    const clean = await ev(A, `(() => {
      const d = document.getElementById('stage').contentDocument;
      const ids = ['chatInput', 'emoteFeed', 'emoteList', 'chatSend'];
      const found = ids.filter((id) => d.getElementById(id));
      const bodyText = (d.body && d.body.textContent) || '';
      return JSON.stringify({ found: found, leakChat: bodyText.indexOf('大家好') >= 0 });
    })()`).then((s) => JSON.parse(s));
    check('五子棋页面里没有聊天/表情元素', clean.found.length === 0, JSON.stringify(clean.found));
    check('五子棋页面里不显示聊天内容', clean.leakChat === false);

    await ev(A, `document.getElementById('stage').contentWindow.postMessage({ kaihei: 'emoji', e: '👻' }, '*')`);
    await sleep(2500);   // 轮询至少跑 1 轮：若协议还通，双方动态栏都会出现 👻
    const feedA = await feedSnapshot(A);
    const feedB = await feedSnapshot(B);
    check('旧协议表情 postMessage 不再送达任何一方（协议已拆除）',
      !feedA.some((m) => m.text === '👻') && !feedB.some((m) => m.text === '👻'),
      'A:' + JSON.stringify(feedA.map((m) => m.text)) + ' B:' + JSON.stringify(feedB.map((m) => m.text)));
    const gomokuAlive = await ev(A, `(() => {
      const d = document.getElementById('stage').contentDocument;
      return !!(d.getElementById('turnLine') || d.getElementById('roomCode'));
    })()`);
    check('旧协议消息没把五子棋搞坏', gomokuAlive === true);

    section('④ 双实例同房五子棋，聊天继续共通');
    await switchGame(B, 'gmv9ny2bh', '/games/gmv9ny2bh/', 'B 的五子棋 iframe 就绪');
    await clickInIframeWhenReady(B, '#btnEnter', 10000, 'B 的五子棋「进入大厅」按钮可见');
    await waitIframeVisible(B, '#roomInput', 10000, 'B 的五子棋房间码输入框可见');
    await ev(B, `(() => {
      const d = document.getElementById('stage').contentDocument;
      const inp = d.getElementById('roomInput');
      inp.value = ${JSON.stringify(roomCode)};
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      d.getElementById('btnJoin').click();
      return 1;
    })()`);
    let joined = false, joinDetail = '';
    try {
      const r = await waitFor(async () => {
        const s = await ev(B, `(() => {
          const d = document.getElementById('stage').contentDocument;
          const tl = d.getElementById('turnLine');
          const lobbyErr = (d.getElementById('lobbyErr') || {}).textContent || '';
          const status = (d.getElementById('status') || {}).textContent || '';
          const toastEl = (d.getElementById('toast') || {}).textContent || '';
          const cardRoom = d.getElementById('cardRoom');
          const roomVisible = !!(cardRoom && cardRoom.style.display !== 'none');
          const roomCodeNow = (d.getElementById('roomCode') || {}).textContent || '';
          return JSON.stringify({
            tlVisible: !!(tl && tl.offsetParent !== null),
            lobbyErr: lobbyErr, status: status, toast: toastEl,
            roomVisible: roomVisible, roomCodeNow: roomCodeNow,
          });
        })()`).then((x) => JSON.parse(x));
        if (s.lobbyErr || s.toast || s.status) { return 'ERR:' + JSON.stringify(s); }
        return s.tlVisible ? s : null;
      }, 12000, 'B 加入五子棋房间');
      joined = r.tlVisible === true;
      joinDetail = JSON.stringify(r);
    } catch (e) {
      joinDetail = e.message;
    }
    check('B 输入房间码加入 A 的五子棋对局', joined === true, joinDetail);

    await clickEl(A, '#chatInput');
    await A.send('Input.insertText', { text: '五子棋里也能聊' });
    await tapEnter(A);
    const gotBack = await waitFeedHas(B, { name: '甲玩家', text: '五子棋里也能聊' }, 5000, 'B 收到 A 的消息');
    check('同房后 A 发消息 B 照样收到', true, JSON.stringify(gotBack));

    const finalA = await feedSnapshot(A);
    const finalB = await feedSnapshot(B);
    check('双方动态栏条数一致（同一公共频道）',
      finalA.length === finalB.length,
      'A=' + finalA.length + ' B=' + finalB.length);
  } catch (err) {
    console.log('\n!! 主流程异常: ' + err.message);
    fail++;
    failures.push('主流程异常: ' + err.message);
  } finally {
    if (edgeA) { try { edgeA.kill(); } catch (e) { /* 忽略 */ } }
    if (edgeB) { try { edgeB.kill(); } catch (e) { /* 忽略 */ } }
  }

  console.log('\n========== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 ==========');
  if (failures.length) {
    console.log('失败项:');
    failures.forEach((f) => console.log('  - ' + f));
  }
  process.exit(fail ? 1 : 0);
})();
