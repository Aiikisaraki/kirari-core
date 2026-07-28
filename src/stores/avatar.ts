import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { AvatarConfig, AvatarMeta, AvatarState } from "../pet/avatar/types";

// 内置形象：精灵帧（已就绪）+ Live2D（占位，待后期接入）。
// 这是前端写死的基线；用户通过"导入"添加的自定义形象存在主进程 config 里。
const BUILTIN_AVATARS: AvatarMeta[] = [
  {
    id: "kirari-sprite",
    name: "Aki Kirari（精灵帧）",
    type: "sprite",
    src: "pet://frames.json",
    builtin: true,
  },
  {
    id: "live2d-coming",
    name: "Live2D（即将推出）",
    type: "live2d",
    src: "",
    builtin: true,
  },
];

const DEFAULT_AVATAR: AvatarConfig = {
  id: "kirari-sprite",
  name: "Aki Kirari（精灵帧）",
  type: "sprite",
  src: "pet://frames.json",
};

type ElectronApi = {
  ipcRenderer?: {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    on: (channel: string, listener: (...args: unknown[]) => void) => void;
  };
};

function getWindow() {
  return window as unknown as {
    windowApi?: {
      getAvatar?: () => Promise<unknown>;
      getCustomAvatars?: () => Promise<unknown>;
      setAvatar?: (cfg: AvatarConfig) => Promise<unknown>;
      importAvatarFolder?: () => Promise<unknown>;
      onAvatarChanged?: (cb: (payload: unknown) => void) => void;
    };
    require?: (mod: string) => ElectronApi;
  };
}

function normalizeConfig(v: unknown): AvatarConfig {
  if (
    v &&
    typeof v === "object" &&
    (v as Record<string, unknown>).type &&
    typeof (v as Record<string, unknown>).src === "string"
  ) {
    return v as AvatarConfig;
  }
  return { ...DEFAULT_AVATAR };
}

// 形象系统：当前形象配置 + 当前播放状态 + 可选形象列表。
// 持久化在主进程 pet-client.config.json（avatar + customAvatars）；
// 切换时主进程广播 avatar:changed 同步所有已打开窗口（含 pet 窗口与设置窗口）。
export const useAvatarStore = defineStore("avatar", () => {
  const current = ref<AvatarConfig>({ ...DEFAULT_AVATAR });
  const currentState = ref<AvatarState>("idle");
  const ready = ref(false);
  const customAvatars = ref<AvatarMeta[]>([]);
  // 各状态动画时长（ms）：一次性动画为 frames/fps，loop 状态为 0（持续不自动结束）。
  // 由 PetAvatar 加载 frames.json 后回填，供调度器精确衔接"播完回 idle"。
  const durations = ref<Partial<Record<AvatarState, number>>>({});

  const list = computed<AvatarMeta[]>(() => [...BUILTIN_AVATARS, ...customAvatars.value]);

  function isActive(meta: AvatarMeta): boolean {
    return current.value.type === meta.type && current.value.src === meta.src;
  }

  function apply(cfg: AvatarConfig) {
    current.value = cfg;
    currentState.value = "idle";
  }

  async function init() {
    const w = getWindow();

    // 1) 异步读取主进程持久化的当前形象
    try {
      if (w.windowApi?.getAvatar) {
        const saved = await w.windowApi.getAvatar();
        if (saved) apply(normalizeConfig(saved));
      }
    } catch {
      /* 读取失败则用默认 */
    }

    // 2) 读取用户导入的自定义形象列表
    try {
      if (w.windowApi?.getCustomAvatars) {
        const custom = await w.windowApi.getCustomAvatars();
        if (Array.isArray(custom)) customAvatars.value = custom as AvatarMeta[];
      }
    } catch {
      /* 忽略 */
    }

    // 3) 跨窗口同步：监听主进程广播的形象变更（含 current + custom 列表）
    try {
      if (w.windowApi?.onAvatarChanged) {
        w.windowApi.onAvatarChanged((payload: unknown) => {
          const p = payload as { current?: AvatarConfig; custom?: AvatarMeta[] };
          if (p?.current) apply(normalizeConfig(p.current));
          if (Array.isArray(p?.custom)) customAvatars.value = p.custom;
        });
      } else if (w.require) {
        w.require("electron").ipcRenderer.on(
          "avatar:changed",
          (_e: unknown, payload: unknown) => {
            const p = payload as { current?: AvatarConfig; custom?: AvatarMeta[] };
            if (p?.current) apply(normalizeConfig(p.current));
            if (Array.isArray(p?.custom)) customAvatars.value = p.custom;
          },
        );
      }
    } catch {
      /* 控件不可用则忽略 */
    }

    ready.value = true;
  }

  async function setAvatar(cfg: AvatarConfig) {
    apply(cfg);
    const w = getWindow();
    try {
      if (w.windowApi?.setAvatar) await w.windowApi.setAvatar(cfg);
      else if (w.require) await w.require("electron").ipcRenderer.invoke("avatar:set", cfg);
    } catch {
      /* 持久化失败则忽略（本窗口已应用） */
    }
  }

  // 驱动播放状态（语义意图）。idle 为基础态，其他动作播完由渲染器自动回到 idle。
  function setState(s: AvatarState) {
    currentState.value = s;
  }

  // 由 PetAvatar 在加载 frames.json 后回填各状态动画时长（ms）。
  function setDurations(map: Partial<Record<AvatarState, number>>) {
    durations.value = map;
  }

  // 导入自定义精灵形象：弹出目录选择框 → 主进程复制并注册 → 返回 meta → 加入列表并切换。
  async function importAvatarFolder(): Promise<{ ok: boolean; message?: string }> {
    const w = getWindow();
    try {
      let r: unknown = null;
      if (w.windowApi?.importAvatarFolder) r = await w.windowApi.importAvatarFolder();
      else if (w.require) r = await w.require("electron").ipcRenderer.invoke("avatar:import-folder");
      const res = r as { ok: boolean; meta?: AvatarMeta; message?: string };
      if (res?.ok && res.meta) {
        customAvatars.value = [...customAvatars.value, res.meta];
        await setAvatar(res.meta);
        return { ok: true };
      }
      return { ok: false, message: res?.message || "导入失败" };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : "导入失败" };
    }
  }

  return { current, currentState, ready, customAvatars, durations, list, isActive, init, setAvatar, setState, setDurations, importAvatarFolder };
});
