import type {
  AvatarConfig,
  AvatarRenderer,
  AvatarState,
  SpriteManifest,
  SpriteStateDef,
} from "./types";

// 基础态：任何一次性（非 loop）动作播完后都平滑回到这个站姿，
// 保证本段动画既能自循环也能与其他动作无缝衔接。
const BASE_STATE: AvatarState = "idle";

// 精灵帧渲染器：用 2D canvas 按 fps 切帧播放。
// 读取 frames.json（映射 state -> {sheet, frameW, frameH, frames, fps, loop}），
// 预加载各 state 的横向 sprite sheet 为 Image，rAF 驱动切帧。
export class SpriteRenderer implements AvatarRenderer {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private manifest: SpriteManifest | null = null;
  private sheets: Partial<Record<AvatarState, HTMLImageElement>> = {};
  private state: AvatarState = BASE_STATE;
  private frame = 0;
  private acc = 0;
  private last = 0;
  private raf = 0;
  private running = false;
  private scale = 1;
  private baseDir = "";

  async load(config: AvatarConfig): Promise<void> {
    // ---- 加载 frames.json：先尝试 fetch（自定义协议），失败则走 IPC 兜底 ----
    let json: SpriteManifest;
    const isCustomProtocol = config.src.startsWith("pet://") || config.src.startsWith("avatar://");

    if (isCustomProtocol) {
      // 自定义协议在打包后可能因 origin 安全策略导致 fetch 不可用，
      // 因此同时准备 fetch + IPC 双通道。
      json = await this.loadManifestWithFallback(config.src);
    } else {
      // 标准 HTTP/文件路径：直接 fetch（开发模式 Vite dev server）
      const res = await fetch(config.src);
      if (!res.ok) throw new Error(`加载 frames.json 失败: ${config.src}`);
      json = (await res.json()) as SpriteManifest;
    }

    this.manifest = json;
    // sheet 相对 frames.json 所在目录解析
    const idx = config.src.lastIndexOf("/");
    this.baseDir = idx >= 0 ? config.src.slice(0, idx + 1) : "";

    const states = Object.keys(json) as AvatarState[];
    await Promise.all(
      states.map(
        (s) =>
          new Promise<void>((resolve) => {
            const sheetPath = this.baseDir + json[s].sheet;
            this.loadImageWithFallback(sheetPath, s).then((img) => {
              if (img) this.sheets[s] = img;
              resolve();
            });
          }),
      ),
    );

    if (typeof config.scale === "number" && config.scale > 0) this.scale = config.scale;
  }

  /** 双通道加载 manifest：fetch 优先，失败则 IPC 兜底 */
  private async loadManifestWithFallback(src: string): Promise<SpriteManifest> {
    // 通道 1：fetch（自定义协议或 HTTP）
    try {
      const res = await fetch(src);
      if (res.ok) return (await res.json()) as SpriteManifest;
    } catch {
      // fetch 不可用（打包后 file:// origin 可能阻止跨协议 fetch），走通道 2
    }

    // 通道 2：IPC → 主进程读取 asar 内文件
    console.log("[sprite] fetch 失败，切换到 IPC 加载:", src);
    const relPath = src.replace(/^pet:\/\//, "").replace(/^avatar:\/\//, "");
    const ipc = this.getIpc();
    if (!ipc) throw new Error("IPC 不可用且 fetch 也失败，无法加载精灵帧配置");

    const result = (await ipc.invoke("pet:read-asset", relPath)) as {
      ok: boolean; data?: SpriteManifest; error?: string;
    };
    if (!result?.ok || !result.data) {
      throw new Error(`IPC 加载精灵帧配置失败: ${result?.error || "未知错误"}`);
    }
    return result.data;
  }

  /** 双通道加载图片：Image() 优先（支持自定义协议），失败则 IPC data URL 兜底 */
  private async loadImageWithFallback(src: string, state: AvatarState): Promise<HTMLImageElement | null> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = async () => {
        // Image() 加载失败：尝试 IPC data URL 兜底
        console.log(`[sprite] Image() 加载失败 (${state})，尝试 IPC 兜底:`, src);
        const ipc = this.getIpc();
        if (!ipc) { resolve(null); return; }

        try {
          const relPath = src.replace(/^pet:\/\//, "").replace(/^avatar:\/\//, "");
          const result = (await ipc.invoke("pet:read-asset", relPath)) as {
            ok: boolean; data?: string; error?: string;
          };
          if (result?.ok && typeof result.data === "string" && result.data.startsWith("data:")) {
            const fallbackImg = new Image();
            fallbackImg.onload = () => resolve(fallbackImg);
            fallbackImg.onerror = () => resolve(null);
            fallbackImg.src = result.data;
          } else {
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      };
      img.src = src;
    });
  }

  /** 获取 ipcRenderer 实例（兼容 nodeIntegration 与 preload 两种模式） */
  private getIpc(): { invoke: (ch: string, ...args: unknown[]) => Promise<unknown> } | null {
    try {
      const w = window as unknown as { require?: (m: string) => { ipcRenderer: { invoke: (...a: unknown[]) => unknown } } };
      if (w.require) return w.require("electron").ipcRenderer;
      // 部分窗口通过 windowApi 暴露（preload 注入）
      const api = w as unknown as { electronApi?: { ipcRenderer: { invoke: (...a: unknown[]) => unknown } } };
      if (api.electronApi) return api.electronApi.ipcRenderer;
    } catch { /* 不可用 */ }
    return null;
  }

  mount(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    if (this.manifest && this.manifest[BASE_STATE]) {
      canvas.width = this.manifest[BASE_STATE].frameW;
      canvas.height = this.manifest[BASE_STATE].frameH;
    }
    this.start();
    this.draw();
  }

  setState(state: AvatarState): void {
    if (!this.manifest) return;
    // 该形象没有此状态则用基础态兜底（如切换后缺少某动作的素材）
    const target: AvatarState = this.manifest[state] ? state : BASE_STATE;
    this.state = target;
    this.frame = 0;
    this.acc = 0;
  }

  setScale(scale: number): void {
    this.scale = scale > 0 ? scale : 1;
    this.draw();
  }

  // 返回各状态动画时长（ms）：一次性动画 = frames/fps，loop 状态 = 0。
  // 供调度器精确衔接"播完回基础态"的时机。
  getStateDurations(): Partial<Record<AvatarState, number>> {
    const map: Partial<Record<AvatarState, number>> = {};
    if (this.manifest) {
      (Object.keys(this.manifest) as AvatarState[]).forEach((s) => {
        const def = this.manifest![s];
        map[s] = def.loop ? 0 : Math.round((def.frames / def.fps) * 1000);
      });
    }
    return map;
  }

  destroy(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.ctx = null;
    this.canvas = null;
    this.sheets = {};
    this.manifest = null;
  }

  private start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const tick = (now: number) => {
      if (!this.running) return;
      const def: SpriteStateDef | undefined = this.manifest?.[this.state];
      if (def) {
        const dt = now - this.last;
        this.last = now;
        this.acc += dt;
        const frameDur = 1000 / def.fps;
        let changed = false;
        while (this.acc >= frameDur) {
          this.acc -= frameDur;
          this.frame += 1;
          changed = true;
          if (this.frame >= def.frames) {
            if (def.loop) {
              this.frame = 0;
            } else {
              // 一次性动作播完：平滑回到基础态
              this.state = BASE_STATE;
              this.frame = 0;
              this.acc = 0;
              break;
            }
          }
        }
        if (changed) this.draw();
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private draw(): void {
    if (!this.ctx || !this.canvas || !this.manifest) return;
    const def: SpriteStateDef | undefined = this.manifest[this.state];
    const img = this.sheets[this.state];
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (def && img && img.complete && img.naturalWidth > 0) {
      const sx = this.frame * def.frameW;
      this.ctx.drawImage(img, sx, 0, def.frameW, def.frameH, 0, 0, def.frameW, def.frameH);
    }
  }
}
