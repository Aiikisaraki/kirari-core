# 项目长期记忆：Aki Kirari 桌宠

## 项目定位
从零开发的集成式桌宠机器人：主体是透明无边框 Electron 桌面宠物（360×400），可选集成 OneBot/QQ 等机器人协议。技术栈 Vue3 + TS + Vite + Electron（main/preload 在 `electron/`，前端在 `src/`）。运行 `npm run electron:dev`（改 `main.ts` 主进程必须完整重启，HMR 只热更渲染进程）。

## 核心机制：逐像素鼠标点穿（透明背景可点穿、角色区可拖动）
- **主进程轮询光标**：`electron/main.ts` 里 `setInterval(20ms)` 读 `screen.getCursorScreenPoint()`，按 `screen.getDisplayNearestPoint(cursor).scaleFactor` 换算成逻辑像素，减 `petWindow.getBounds()`，广播 `desktop-pet:cursor {x,y}` 给渲染进程。
- **渲染进程判定**：`src/components/pet/PetStage.vue` 的 `onCursorPos` → `evaluateClickThrough`：拖拽中/交互 UI(气泡/菜单/按钮)→不穿；其余映射光标到 `.pet-canvas` 像素坐标，调 `SpriteRenderer.hitTest(x,y)`（读**显示画布**像素 alpha，>=16 视为实心）。
- **切换穿透**：IPC `desktop-pet:set-ignore-mouse` → `win.setIgnoreMouseEvents(ignore)`（不要 `{forward:true}`，本方案不依赖它）。
- **悬浮态**由「光标是否在桌宠窗口矩形内」驱动（`inWindow = 0<=clientX<=innerW && 0<=clientY<=innerH`，clientX/Y 来自主进程广播的 `desktop-pet:cursor` 相对窗口坐标），不再用 `@pointerenter`（点穿时收不到）也不再耦合 `wantIgnore`；透明留白区小球仍显示且可点中（点中由 isInteractiveEl 分支强制不点穿兜底）。

## 踩过的坑（勿回退）
1. 死锁：渲染进程靠 `pointermove` 自检会死锁（点穿后收不到事件）→ 改用主进程轮询广播。
2. 渲染进程拿不到 `electron.screen`（Electron 42）→ 读光标必须放主进程。
3. 高 DPI：光标是物理像素、`getBounds()` 是逻辑像素，必须 `/scaleFactor` 换算，否则坐标错位导致永久点穿。
4. hitTest 必须读**显示画布**（每帧必画），勿读离屏掩膜（绘制链路脆弱易空白）。
5. **绝对不要**用 `isVisible` store 控制「整窗点穿」——桌宠隐藏由主进程 `win.hide()` 负责；误用该分支会在 store 异常时把正常桌宠永久点穿（本次最致命的 bug）。

## 调试经验
- Electron 主进程 `console.log` 与渲染进程 `console.log` 不在同一控制台，排查时优先把渲染侧诊断 `ipcRenderer.send` 回传主进程打印。
- 改了主进程文件必须完整重启 dev。
