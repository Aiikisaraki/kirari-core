import type { InjectionKey, Ref } from "vue";

export type AuthResult = { ok: boolean; uid?: number; message?: string };

/**
 * 设置页跨区块共享的上下文。
 * 主页面（SettingsPage）持有 mode / authed / accountName 与鉴权动作，
 * 各区块组件通过 inject 读取，彼此不再相互耦合。
 */
export interface SettingsContext {
    mode: Ref<"local" | "remote">;
    authed: Ref<boolean>;
    accountName: Ref<string>;
    /** 重新拉取鉴权态（登录/登出后调用） */
    refreshAuth: () => Promise<void>;
    login: (username: string, password: string) => Promise<AuthResult>;
    register: (username: string, password: string) => Promise<AuthResult>;
    logout: () => void;
}

export const SETTINGS_CONTEXT = Symbol(
    "settings-context",
) as InjectionKey<SettingsContext>;
