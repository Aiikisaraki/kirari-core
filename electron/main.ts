import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, protocol, screen, shell, Tray } from "electron";
import fs from "fs";
import path from "path";
import { ChatSessionService, type ChatStateSnapshot } from "./chat-session-service";
import { startBackendIfLocal, stopBackend, applyConfigToBackend } from "./backend-launcher";
import { readModelConfigFile, writeModelConfigFile, onModelConfigChanged, startModelConfigWatch } from "./model-config";
import { initAppLogger, getLogPath, isDebugMode } from "./app-logger";

type PetWindow = InstanceType<typeof BrowserWindow>;
type PetTray = InstanceType<typeof Tray>;

// ---- 部署配置（由"安装过程"生成的 pet-client.config.json 决定工作模式）----
type ThemeName = "aurora-glass" | "pet-pink";
const THEME_LIST: ThemeName[] = ["aurora-glass", "pet-pink"];
const DEFAULT_THEME: ThemeName = "aurora-glass";

// 桌宠形象配置（与前端 AvatarConfig 对应，主进程独立定义以避免依赖前端运行时模块）
type AvatarConfig = {
  type: "sprite" | "live2d";
  src: string;
  scale?: number;
  id?: string;
  name?: string;
  builtin?: boolean;
};
type AvatarMeta = AvatarConfig & { id: string; name: string; builtin?: boolean };

const DEFAULT_AVATAR: AvatarConfig = {
  id: "kirari-sprite",
  name: "Aki Kirari（精灵帧）",
  type: "sprite",
  src: "pet://frames.json",
};

type DeployConfig = {
  mode: "local" | "remote";
  server: { wsUrl: string; httpUrl: string };
  builtinToken?: string;
  theme?: ThemeName;
  avatar?: AvatarConfig;
  customAvatars?: AvatarMeta[];
};
const DEFAULT_BUILTIN_TOKEN = "kirari-local-builtin";
const DEFAULT_LOCAL = {
  mode: "local" as const,
  server: { wsUrl: "ws://localhost:9089/ws", httpUrl: "http://localhost:9089" },
  builtinToken: DEFAULT_BUILTIN_TOKEN,
  theme: DEFAULT_THEME,
  avatar: DEFAULT_AVATAR,
};

function loadClientConfig(): DeployConfig {
  const candidates = [
    process.env.PET_CLIENT_CONFIG,
    path.join(app.getPath("userData"), "pet-client.config.json"),
  ].filter(Boolean) as string[];
  for (const p of candidates) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      if (raw && (raw.mode === "local" || raw.mode === "remote") && raw.server) {
      return {
        mode: raw.mode,
        server: {
          wsUrl: raw.server.wsUrl || (raw.mode === "local" ? "ws://localhost:9089/ws" : ""),
          httpUrl: raw.server.httpUrl || (raw.mode === "local" ? "http://localhost:9089" : ""),
        },
        builtinToken: raw.builtinToken || DEFAULT_BUILTIN_TOKEN,
        theme: THEME_LIST.includes(raw.theme) ? raw.theme : DEFAULT_THEME,
        avatar: raw.avatar && raw.avatar.type && raw.avatar.src ? raw.avatar : DEFAULT_AVATAR,
        customAvatars: Array.isArray(raw.customAvatars) ? raw.customAvatars : [],
      };
      }
    } catch {
      // 配置无效则尝试下一个候选
    }
  }
  return { ...DEFAULT_LOCAL };
}

const clientConfig = loadClientConfig();

function saveClientConfig() {
  try {
    fs.writeFileSync(
      path.join(app.getPath("userData"), "pet-client.config.json"),
      JSON.stringify(clientConfig, null, 2)
    );
  } catch (e) {
    console.error("[config] 保存客户端配置失败:", e);
  }
}

// 主题变更时广播给所有已打开窗口，保证跨窗口一致
function broadcastTheme(name: ThemeName) {
  for (const win of [petWindow, chatWindow, settingsWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send("theme:changed", name);
  }
}

// 形象变更时广播给所有已打开窗口，含当前形象与自定义形象列表
function broadcastAvatar() {
  const payload = {
    current: clientConfig.avatar || DEFAULT_AVATAR,
    custom: clientConfig.customAvatars || [],
  };
  for (const win of [petWindow, chatWindow, settingsWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send("avatar:changed", payload);
  }
}

type SettingsApiRequest = {
  method: "GET" | "POST" | "PUT";
  path: string;
  body: Record<string, unknown>;
};

const petWindowSize = { width: 360, height: 400 };
const chatWindowSize = { width: 420, height: 620 };
const settingsWindowSize = { width: 560, height: 720 };
const backendUrl = clientConfig.server.wsUrl || "ws://localhost:9089/ws";
const backendHttpUrl = clientConfig.server.httpUrl || "http://localhost:9089";
const backendHealthUrl = `${backendHttpUrl.replace(/\/$/, "")}/health`;
let loggedInUid: number | null = null; // 非本地模式：登录后的 uid（聊天身份）
let chatServiceUserid: number | null = null; // 已创建的聊天服务所用 uid，便于登录/登出后重建

// 聊天身份：本地模式固定为内置账户 uid=1；非本地模式使用登录后的 uid。
function resolveChatUserid(): number {
  if (clientConfig.mode === "local") return 1;
  return loggedInUid && loggedInUid > 0 ? loggedInUid : 1;
}

let settingsSessionToken: string | null = null;
let settingsWindow: PetWindow | null = null;

let petWindow: PetWindow | null = null;
let chatWindow: PetWindow | null = null;
let tray: PetTray | null = null;
let dragState: {
  windowId: number;
  windowStart: { x: number; y: number };
  pointerStart: { x: number; y: number };
} | null = null;
let isQuitting = false;
let chatSessionService: ChatSessionService | null = null;

async function readApiResponse(response: Response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) as Record<string, unknown> : {};
  } catch {
    return { message: `后端返回了非 JSON 响应（HTTP ${response.status}）` };
  }
}

// 设置/账号类请求：本地模式带内置账户令牌，远程模式带登录后的会话令牌。
// 不再使用 ed25519 客户端签名，配置读写由账户凭证驱动，对前端无感。
async function requestSettingsApi(request: SettingsApiRequest) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (clientConfig.mode === "local") {
    headers["X-Builtin-Token"] = clientConfig.builtinToken || DEFAULT_BUILTIN_TOKEN;
  } else if (settingsSessionToken) {
    headers["Authorization"] = `Bearer ${settingsSessionToken}`;
  }
  const response = await fetch(`${backendHttpUrl}${request.path}`, {
    method: request.method,
    headers,
    body: request.method === "GET" ? undefined : JSON.stringify(request.body),
  });
  return { status: response.status, data: await readApiResponse(response) };
}

// 自定义窗口控件（最小化 / 关闭 / 最大化）的 IPC 入口；
// 用 event.sender 反查触发窗口，避免直接持有窗口引用。
ipcMain.on("window:control", (event, action: string) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  if (action === "minimize") win.minimize();
  else if (action === "close") win.close();
  else if (action === "toggle-maximize") {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  }
});

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return settingsWindow;
  }
  settingsWindow = new BrowserWindow({
    title: "设置",
    width: settingsWindowSize.width,
    height: settingsWindowSize.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    autoHideMenuBar: true,
    webPreferences: { preload: path.resolve(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  settingsWindow.on("closed", () => { settingsWindow = null; });
  const settingsTheme = clientConfig.theme || DEFAULT_THEME;
  if (process.env.VITE_DEV_SERVER_URL) settingsWindow.loadURL(new URL(`?window=settings&theme=${settingsTheme}`, process.env.VITE_DEV_SERVER_URL).toString());
  else settingsWindow.loadFile(path.resolve(__dirname, "../dist/index.html"), { query: { window: "settings", theme: settingsTheme } });
  settingsWindow.once("ready-to-show", () => settingsWindow?.show());
  return settingsWindow;
}

ipcMain.handle("deploy:get-config", () => clientConfig);
ipcMain.handle("theme:get", () => clientConfig.theme || DEFAULT_THEME);
ipcMain.handle("theme:set", (_event, name: string) => {
  const next: ThemeName = (THEME_LIST as string[]).includes(name) ? (name as ThemeName) : DEFAULT_THEME;
  clientConfig.theme = next;
  saveClientConfig();
  broadcastTheme(next);
  return next;
});

// ---- 桌宠形象：读取 / 设置当前形象 + 列表 + 导入 ----
ipcMain.handle("avatar:get", () => clientConfig.avatar || DEFAULT_AVATAR);
ipcMain.handle("avatar:custom-get", () => clientConfig.customAvatars || []);

ipcMain.handle("avatar:set", (_event, cfg: AvatarConfig) => {
  clientConfig.avatar = cfg;
  saveClientConfig();
  broadcastAvatar();
});

// 导入自定义精灵形象：弹出目录选择框，校验 frames.json 后复制到 userData/avatars，
// 注册 avatar:// 协议供渲染进程加载，并切换到该形象。
ipcMain.handle("avatar:import-folder", async () => {
  const result = await dialog.showOpenDialog({
    title: "选择精灵形象文件夹",
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, message: "已取消" };
  const srcDir = result.filePaths[0];
  const framesPath = path.join(srcDir, "frames.json");
  if (!fs.existsSync(framesPath)) return { ok: false, message: "该文件夹缺少 frames.json" };
  let manifest: Record<string, unknown> = {};
  try {
    manifest = JSON.parse(fs.readFileSync(framesPath, "utf8"));
  } catch {
    return { ok: false, message: "frames.json 解析失败" };
  }
  if (!manifest || typeof manifest !== "object") return { ok: false, message: "frames.json 内容无效" };
  const name = path.basename(srcDir);
  const destDir = path.join(app.getPath("userData"), "avatars", name);
  try {
    fs.cpSync(srcDir, destDir, { recursive: true });
  } catch (e) {
    return { ok: false, message: "复制失败：" + (e instanceof Error ? e.message : "") };
  }
  const meta: AvatarMeta = {
    id: "custom-" + name,
    name,
    type: "sprite",
    src: `avatar://${encodeURIComponent(name)}/frames.json`,
    builtin: false,
  };
  clientConfig.customAvatars = clientConfig.customAvatars || [];
  const idx = clientConfig.customAvatars.findIndex((a) => a.id === meta.id);
  if (idx >= 0) clientConfig.customAvatars[idx] = meta;
  else clientConfig.customAvatars.push(meta);
  clientConfig.avatar = meta;
  saveClientConfig();
  broadcastAvatar();
  return { ok: true, meta };
});
ipcMain.handle("deploy:set-session", (_event, token: string | null) => {
  settingsSessionToken = token || null;
  if (!token) {
    // 登出：清空远程 uid，并按本地身份（uid=1）重建聊天服务。
    loggedInUid = null;
    if (chatSessionService) {
      chatSessionService.dispose();
      chatSessionService = null;
      chatServiceUserid = null;
    }
  }
});
ipcMain.handle("token:login", async (_event, credentials: { username: string; password: string }) => {
  try {
    const response = await fetch(`${backendHttpUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(credentials),
    });
    const data = await readApiResponse(response);
    if (!response.ok) return { ok: false, message: String(data.message || "登录失败") };
    settingsSessionToken = String(data.sessionToken);
    loggedInUid = Number(data.uid);
    // 登录账户变化后，按新身份重建聊天服务，避免聊天记忆/配置错配。
    if (chatSessionService && chatServiceUserid !== loggedInUid) {
      chatSessionService.dispose();
      chatSessionService = null;
      chatServiceUserid = null;
    }
    return { ok: true, uid: data.uid };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "无法连接服务端" };
  }
});
ipcMain.handle("token:request", (_event, request: SettingsApiRequest) => requestSettingsApi(request));

// ---- 模型配置（config.json）：本地模式的「用户级可编辑配置文件」 ----
// 本地模式设置界面直接读写 config.json；远程模式仍走后端 /api/profile。
ipcMain.handle("config:get", () => readModelConfigFile());
ipcMain.handle("config:set", (_event, patch: Record<string, unknown>) => {
  const next = writeModelConfigFile({
    endpoint: typeof patch.endpoint === "string" ? patch.endpoint : undefined,
    model: typeof patch.model === "string" ? patch.model : undefined,
    key: typeof patch.key === "string" ? patch.key : undefined,
  });
  // 写文件会触发 fs.watch → 同步后端 + 广播；这里再显式执行一次，确保本进程内保存也能即时生效。
  handleModelConfigChanged(next);
  return next;
});

// config.json 被外部编辑器修改（或本进程写入）后：同步到后端 DB 并广播给所有窗口。
function handleModelConfigChanged(cfg: ReturnType<typeof readModelConfigFile>) {
  void applyConfigToBackend();
  for (const win of [petWindow, chatWindow, settingsWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send("config:changed", cfg);
  }
}

// 监听 config.json 外部编辑：用户用文本编辑器改文件后实时同步到后端与前端。
onModelConfigChanged(handleModelConfigChanged);

function getDefaultWindowPosition(win: PetWindow) {
  const display = screen.getPrimaryDisplay();
  const bounds = win.getBounds();
  const { x, y, width, height } = display.workArea;

  return {
    x: x + width - bounds.width - 32,
    y: y + height - bounds.height - 32,
  };
}

function resetWindowPosition(win: PetWindow) {
  const nextPosition = getDefaultWindowPosition(win);
  win.setPosition(nextPosition.x, nextPosition.y, false);
  win.moveTop();
}

function resolveTrayIconPath() {
  // 使用软件图标 app-icon.ico（与 exe / 任务栏 / 安装包一致），而非旧的 tray.png
  if (process.env.VITE_DEV_SERVER_URL) {
    return path.resolve(__dirname, "../public/app-icon.ico");
  }

  return path.resolve(__dirname, "../dist/app-icon.ico");
}

function getTrayIcon() {
  const icon = nativeImage.createFromPath(resolveTrayIconPath());
  return icon.resize({ width: 16, height: 16 });
}

function getAllLiveWindows() {
  return [petWindow, chatWindow].filter((win): win is PetWindow => !!win && !win.isDestroyed());
}

function broadcastChatState(state: ChatStateSnapshot) {
  getAllLiveWindows().forEach((win) => {
    win.webContents.send("chat:state", state);
  });
}

function ensureChatSessionService() {
  const uid = resolveChatUserid();
  if (!chatSessionService || chatServiceUserid !== uid) {
    if (chatSessionService) chatSessionService.dispose();
    chatServiceUserid = uid;
    // 会话令牌：本地模式带内置账户令牌，远程模式带登录后的会话令牌；由后端在 WS 握手阶段校验。
    const token =
      clientConfig.mode === "local"
        ? clientConfig.builtinToken || DEFAULT_BUILTIN_TOKEN
        : (settingsSessionToken ?? "");
    chatSessionService = new ChatSessionService({
      backendUrl,
      userid: uid,
      token,
      requireToken: true,
      emitState: broadcastChatState,
    });
  }

  return chatSessionService;
}

function ensurePetWindow() {
  if (!petWindow || petWindow.isDestroyed()) {
    petWindow = createWindow();
  }

  return petWindow;
}

function ensureChatWindow() {
  if (!chatWindow || chatWindow.isDestroyed()) {
    chatWindow = createChatWindow();
  }

  return chatWindow;
}

function showChatWindow() {
  const win = ensureChatWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  // 对话框已打开：通知桌宠窗口清零未读（打开即视为已读）。
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send("chat:open-changed", true);
  }
  updateTrayMenu();
}

function showPetWindow() {
  const win = ensurePetWindow();
  win.showInactive();
  win.setSkipTaskbar(true);
  win.setAlwaysOnTop(true);
  win.moveTop();
  updateTrayMenu();
}

function hidePetWindow() {
  if (!petWindow) return;

  petWindow.hide();
  updateTrayMenu();
}

function quitApp() {
  isQuitting = true;
  app.quit();
}

function updateTrayMenu() {
  if (!tray) return;

  const isWindowVisible = petWindow?.isVisible() ?? false;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "显示桌宠",
        enabled: !isWindowVisible,
        click: showPetWindow,
      },
      {
        label: "隐藏桌宠",
        enabled: isWindowVisible,
        click: hidePetWindow,
      },
      { type: "separator" },
      {
        label: "打开对话框",
        click: showChatWindow,
      },
      { type: "separator" },
      {
        label: "打开设置",
        click: createSettingsWindow,
      },
      {
        label: "打开调试日志",
        click: () => {
          const p = getLogPath();
          if (p) shell.openPath(path.dirname(p));
          else dialog.showErrorBox("无法打开日志", "未找到日志文件路径，可能在 sandbox 环境下 userData 不可写。");
        },
      },
      { type: "separator" },
      {
        label: "重置位置",
        click: () => {
          const win = ensurePetWindow();
          resetWindowPosition(win);
          showPetWindow();
        },
      },
      { type: "separator" },
      {
        label: "退出",
        click: quitApp,
      },
    ]),
  );
}

function createTray() {
  if (tray) return;

  tray = new Tray(getTrayIcon());
  tray.setToolTip("Aki Kirari 桌宠");
  tray.on("click", () => {
    if (petWindow?.isVisible()) {
      hidePetWindow();
      return;
    }

    showPetWindow();
  });
  updateTrayMenu();
}

function createWindow() {
  const win = new BrowserWindow({
    title: "Aki Kirari",
    frame: false,
    show: false,
    skipTaskbar: true,
    transparent: true,
    width: petWindowSize.width,
    height: petWindowSize.height,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    autoHideMenuBar: true,
    resizable: false,
    maximizable: false,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  petWindow = win;
  resetWindowPosition(win);
  win.setAlwaysOnTop(true);
  win.setSkipTaskbar(true);

  win.on("close", (event) => {
    if (isQuitting) return;

    event.preventDefault();
    hidePetWindow();
  });

  win.on("show", updateTrayMenu);
  win.on("hide", updateTrayMenu);
  win.on("closed", () => {
    if (petWindow === win) petWindow = null;
    updateTrayMenu();
  });

  win.once("ready-to-show", () => {
    showPetWindow();
    if (isDebugMode()) win.webContents.openDevTools({ mode: "detach" });
    const snapshot = ensureChatSessionService().getSnapshot();
    win.webContents.send("chat:state", snapshot);
  });

  const petTheme = clientConfig.theme || DEFAULT_THEME;
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(new URL(`?theme=${petTheme}`, process.env.VITE_DEV_SERVER_URL).toString());
  } else {
    win.loadFile(path.resolve(__dirname, "../dist/index.html"), { query: { theme: petTheme } });
  }

  return win;
}

function createChatWindow() {
  const win = new BrowserWindow({
    title: "和 Aki 聊天",
    width: chatWindowSize.width,
    height: chatWindowSize.height,
    minWidth: 360,
    minHeight: 500,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.resolve(__dirname, "preload.js"),
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  chatWindow = win;

  // 对话框关闭时通知桌宠窗口（已读状态复位），由 Pinia store 在关闭后
  // 对期间来的新消息重新计入未读。打开即视为已读的逻辑见 showChatWindow。
  win.on("closed", () => {
    if (chatWindow === win) chatWindow = null;
    if (petWindow && !petWindow.isDestroyed()) {
      petWindow.webContents.send("chat:open-changed", false);
    }
    updateTrayMenu();
  });

  win.once("ready-to-show", () => {
    if (isDebugMode()) win.webContents.openDevTools({ mode: "detach" });
    const snapshot = ensureChatSessionService().getSnapshot();
    win.webContents.send("chat:state", snapshot);
  });

  const chatTheme = clientConfig.theme || DEFAULT_THEME;
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(new URL(`?window=chat&theme=${chatTheme}`, process.env.VITE_DEV_SERVER_URL).toString());
  } else {
    win.loadFile(path.resolve(__dirname, "../dist/index.html"), {
      query: { window: "chat", theme: chatTheme },
    });
  }

  return win;
}

ipcMain.handle("chat:get-state", () => {
  return ensureChatSessionService().getSnapshot();
});

ipcMain.on("chat:send-message", (_event, content: string) => {
  void ensureChatSessionService().sendMessage(content);
});

ipcMain.on("desktop-pet:drag-start", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;

  const [x, y] = win.getPosition();
  const pointerStart = screen.getCursorScreenPoint();
  dragState = {
    windowId: win.id,
    windowStart: { x, y },
    pointerStart,
  };
  win.moveTop();
});

ipcMain.on("desktop-pet:drag-move", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || !dragState || dragState.windowId !== win.id) return;

  const pointer = screen.getCursorScreenPoint();
  const nextX = Math.round(dragState.windowStart.x + pointer.x - dragState.pointerStart.x);
  const nextY = Math.round(dragState.windowStart.y + pointer.y - dragState.pointerStart.y);

  win.setPosition(nextX, nextY, false);
});

ipcMain.on("desktop-pet:drag-end", () => {
  dragState = null;
});

// 逐像素点穿：渲染进程按光标处像素 alpha 判定后，通知主进程切换窗口的鼠标穿透。
// ignore=true 时桌宠窗口忽略鼠标、事件透传给下方窗口，实现"只有角色实心区才拦截、
// 透明背景可点穿"。光标位置由主进程轮询（见下方 setInterval）后广播给渲染进程，
// 不依赖窗口是否接收鼠标事件，从根上规避死锁。
ipcMain.on("desktop-pet:set-ignore-mouse", (event, ignore: boolean) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  win.setIgnoreMouseEvents(ignore);
});

// 光标轮询：主进程 screen 模块可用（渲染进程在 Electron 42 下已不可用），
// 每 20ms 取一次全局光标，换算成相对桌宠窗口的视口坐标，广播给渲染进程做逐像素判定。
// 关键：轮询在主进程，与桌宠窗口是否处于"点穿"(setIgnoreMouseEvents=true) 无关，
// 因此光标移回角色实心区时仍能正常广播、关闭点穿，不会陷入"点穿后收不到事件"的死锁。
let lastCursorSent = { x: Number.NaN, y: Number.NaN };
setInterval(() => {
  if (!petWindow || petWindow.isDestroyed()) return;
  const cursor = screen.getCursorScreenPoint();
  const b = petWindow.getBounds();
  // 关键修复：screen.getCursorScreenPoint() 返回物理像素，getBounds() 返回逻辑像素。
  // 必须按光标所在显示器的 scaleFactor 把光标换算成逻辑像素，再与 getBounds 相减，
  // 否则高 DPI 下坐标被放大，命中测试整片错位/越界 → 永久点穿。
  const disp = screen.getDisplayNearestPoint(cursor);
  const scale = disp?.scaleFactor || 1;
  const lx = cursor.x / scale - b.x;
  const ly = cursor.y / scale - b.y;
  // 坐标无变化则跳过，避免无谓 IPC 抖动
  if (lx === lastCursorSent.x && ly === lastCursorSent.y) return;
  lastCursorSent = { x: lx, y: ly };
  petWindow.webContents.send("desktop-pet:cursor", { x: lx, y: ly });
}, 20);

ipcMain.on("desktop-pet:reset-position", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;

  resetWindowPosition(win);
});

ipcMain.on("desktop-pet:open-chat", () => {
  showChatWindow();
});

// 悬浮菜单入口：从桌宠窗口打开设置界面 / 隐藏桌宠。
ipcMain.on("desktop-pet:open-settings", () => {
  createSettingsWindow();
});

ipcMain.on("desktop-pet:hide", () => {
  hidePetWindow();
});

ipcMain.on("desktop-pet:show-context-menu", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);

  Menu.buildFromTemplate([
    {
      label: "打开对话框",
      click: showChatWindow,
    },
    {
      label: "重置位置",
      click: () => {
        const petWin = ensurePetWindow();
        resetWindowPosition(petWin);
        showPetWindow();
      },
    },
    { type: "separator" },
    {
      label: "隐藏桌宠",
      click: hidePetWindow,
    },
  ]).popup({ window: win ?? undefined });
});

async function checkBackendHealth() {
  try {
    const res = await fetch(backendHealthUrl);
    if (!res.ok) throw new Error("后端服务未正常启动");
  } catch (e) {
    console.log("联调提示", `请先启动后端服务（${backendHealthUrl}）`);
  }
}

app.whenReady().then(async () => {
  // 初始化日志（劫持 console，主进程输出同时落盘到 userData/logs/）。
  // 必须在任何 console.* 输出之前调用，确保调试信息不丢失。
  const logPath = initAppLogger();
  const debug = isDebugMode();
  console.log("========================================");
  console.log(`Aki Kirari 桌宠 启动`);
  console.log(`调试模式: ${debug ? "开 (--debug)" : "关"}`);
  console.log(`日志文件: ${logPath ?? "(无法写入，请检查 userData 权限)"}`);
  console.log(`工作模式: ${clientConfig.mode}`);
  console.log("========================================");

  // 注册 pet:// 协议：打包后 loadFile 无 HTTP 服务器，
  // fetch('/pet/frames.json') 无法解析。通过自定义协议映射到精灵帧资源目录。
  // 注意：Electron 42.x 的 registerFileProtocol 回调要求 filePath 属性（非 path）。
  protocol.registerFileProtocol("pet", (request, callback) => {
    try {
      const rel = decodeURIComponent(request.url.replace("pet://", ""));
      const assetDir = process.env.VITE_DEV_SERVER_URL
        ? path.resolve(__dirname, "../public/pet")
        : path.resolve(__dirname, "../dist/pet");
      callback({ filePath: path.join(assetDir, rel) });
    } catch {
      callback({ error: -100 });
    }
  });

  // 注册 avatar:// 协议，使导入到 userData/avatars 的自定义形象可被渲染进程加载
  protocol.registerFileProtocol("avatar", (request, callback) => {
    try {
      const rel = decodeURIComponent(request.url.replace("avatar://", ""));
      callback({ filePath: path.join(app.getPath("userData"), "avatars", rel) });
    } catch {
      callback({ error: -100 });
    }
  });

  // ---- IPC：精灵帧资源加载兜底 ----
  // 当渲染进程的 fetch('pet://...') 因安全策略或兼容性问题失败时，
  // 可通过此通道由主进程直接读取 asar 内文件并返回内容。
  ipcMain.handle("pet:read-asset", async (_event, relativePath: string) => {
    try {
      const assetDir = process.env.VITE_DEV_SERVER_URL
        ? path.resolve(__dirname, "../public/pet")
        : path.resolve(__dirname, "../dist/pet");
      const fullPath = path.join(assetDir, relativePath);
      const buf = fs.readFileSync(fullPath);
      // 根据扩展名判断返回格式：JSON 返回解析后对象，图片返回 base64 data URL
      const ext = path.extname(relativePath).toLowerCase();
      if (ext === ".json") return { ok: true, data: JSON.parse(buf.toString("utf-8")) };
      const mime = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "application/octet-stream";
      return { ok: true, data: `data:${mime};base64,${buf.toString("base64")}` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // 本地模式（打包版）：以子进程方式自启动后端 API，关闭前端时一并关闭。
  // dev 与 remote 模式不启动本地后端。
  if (clientConfig.mode === "local") {
    await startBackendIfLocal({ isLocal: true });
  }

  // 启动 config.json 监听：用户在外部编辑器修改模型配置后，实时同步到后端并广播前端。
  startModelConfigWatch();

  let res = await checkBackendHealth();
  await ensureChatSessionService().init(path.join(app.getPath("userData"), "chat-session.json"));
  createTray();
  ensurePetWindow();

  app.on("activate", () => {
    showPetWindow();
  });
});

app.on("before-quit", () => {
  isQuitting = true;
  stopBackend();
  chatSessionService?.dispose();
});

app.on("window-all-closed", () => {
  updateTrayMenu();
});
