import { contextBridge, ipcRenderer } from "electron";

type SettingsRequest = {
  method: "GET" | "POST" | "PUT";
  path: string;
  body: Record<string, unknown>;
};

type DeployConfig = {
  mode: "local" | "remote";
  server: { wsUrl: string; httpUrl: string };
  builtinToken?: string;
};

// 模型配置文件（config.json）的结构：本地模式下设置界面与用户外部编辑共用。
type ModelConfigFile = {
  endpoint?: string;
  model?: string;
  key?: string;
  seeded?: boolean;
};

contextBridge.exposeInMainWorld("tokenApi", {
  getDeployConfig: (): Promise<DeployConfig> => ipcRenderer.invoke("deploy:get-config"),
  setSession: (token: string | null): Promise<void> => ipcRenderer.invoke("deploy:set-session", token),
  login: (username: string, password: string): Promise<{ ok: boolean; uid?: number; message?: string }> =>
    ipcRenderer.invoke("token:login", { username, password }),
  request: (request: SettingsRequest): Promise<{ status: number; data: Record<string, unknown> }> =>
    ipcRenderer.invoke("token:request", request),
  // 本地模式：直接读写模型配置文件（config.json），外部编辑会实时同步。
  getModelConfig: (): Promise<ModelConfigFile> => ipcRenderer.invoke("config:get"),
  setModelConfig: (patch: Partial<ModelConfigFile>): Promise<ModelConfigFile> =>
    ipcRenderer.invoke("config:set", patch),
  onModelConfigChanged: (cb: (cfg: ModelConfigFile) => void): void => {
    ipcRenderer.on("config:changed", (_event, cfg: ModelConfigFile) => cb(cfg));
  },
});

// 自定义窗口控件（配合主进程 `window:control`）：最小化 / 关闭 / 最大化。
contextBridge.exposeInMainWorld("windowApi", {
  minimize: (): void => ipcRenderer.send("window:control", "minimize"),
  close: (): void => ipcRenderer.send("window:control", "close"),
  toggleMaximize: (): void => ipcRenderer.send("window:control", "toggle-maximize"),
  // 主题：读取 / 设置 / 订阅跨窗口变更广播
  getTheme: (): Promise<string> => ipcRenderer.invoke("theme:get"),
  setTheme: (name: string): Promise<string> => ipcRenderer.invoke("theme:set", name),
  onThemeChanged: (cb: (name: string) => void): void => {
    ipcRenderer.on("theme:changed", (_event, name: string) => cb(name));
  },
  // 桌宠形象：读取 / 设置 / 订阅 / 导入
  getAvatar: (): Promise<unknown> => ipcRenderer.invoke("avatar:get"),
  getCustomAvatars: (): Promise<unknown> => ipcRenderer.invoke("avatar:custom-get"),
  setAvatar: (cfg: Record<string, unknown>): Promise<void> => ipcRenderer.invoke("avatar:set", cfg),
  importAvatarFolder: (): Promise<unknown> => ipcRenderer.invoke("avatar:import-folder"),
  importAvatarZip: (): Promise<unknown> => ipcRenderer.invoke("avatar:import-zip"),
  rescanAvatars: (): Promise<unknown> => ipcRenderer.invoke("avatar:rescan"),
  openAvatarsFolder: (): Promise<void> => ipcRenderer.invoke("avatar:open-folder"),
  onAvatarChanged: (cb: (payload: unknown) => void): void => {
    ipcRenderer.on("avatar:changed", (_event, payload: unknown) => cb(payload));
  },
});
