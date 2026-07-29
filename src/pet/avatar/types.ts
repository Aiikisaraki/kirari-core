// 桌宠形象抽象层：把"播放什么状态"与"用什么技术渲染"彻底解耦。
// 状态机（idle/blink/speak/wave/happy/sleepy）只认 AvatarRenderer 接口，
// 不关心底层是精灵帧（SpriteRenderer）还是 Live2D（Live2DRenderer）。
// 这样即可在同一套框架下支持多种形象，并允许用户上传自定义精灵形象。

export type AvatarState = "idle" | "blink" | "speak" | "wave" | "happy" | "sleepy";

export type AvatarType = "sprite" | "live2d";

// 单个动作的精灵帧定义（对应 frames.json 中某一 state 的条目）
export interface SpriteStateDef {
  sheet: string; // sheet 文件名，相对 frames.json 所在目录
  frameW: number;
  frameH: number;
  frames: number;
  fps: number;
  loop: boolean;
}

export type SpriteManifest = Record<string, SpriteStateDef>;

export interface AvatarConfig {
  type: AvatarType;
  // sprite: frames.json 的 URL（如 /pet/frames.json 或 avatar://<id>/frames.json）
  // live2d: model3.json 的 URL
  src: string;
  scale?: number;
  // 仅用于列表展示 / 持久化（以下字段不参与渲染）
  id?: string;
  name?: string;
  builtin?: boolean;
}

// 形象元信息（用于设置面板的列表与切换）
export interface AvatarMeta extends AvatarConfig {
  id: string;
  name: string;
  builtin?: boolean;
}

export interface AvatarRenderer {
  // 加载素材（sheet 或 model3.json）
  load(config: AvatarConfig): Promise<void>;
  // 挂载到 canvas 并开始播放
  mount(canvas: HTMLCanvasElement): void;
  // 切换到指定状态（语义意图，由实现内部映射）
  setState(state: AvatarState): void;
  // 缩放
  setScale(scale: number): void;
  // 卸载（切换形象时调用）
  destroy(): void;
  // 命中测试：画布内部像素坐标 (x, y) 处是否"实心"（alpha >= 阈值）。
  // 用于桌宠逐像素点穿：透明区透传点击给下方窗口，实心区才可拖动/交互。
  hitTest(x: number, y: number): boolean;
}

import { SpriteRenderer } from "./SpriteRenderer";
import { Live2DRenderer } from "./Live2DRenderer";

// 渲染器工厂：根据类型实例化对应实现。live2d 当前为占位（留空），
// 返回 null 时调用方应保持上一个可用形象。
export function createRenderer(type: AvatarType): AvatarRenderer | null {
  if (type === "sprite") return new SpriteRenderer();
  if (type === "live2d") return new Live2DRenderer();
  return null;
}
