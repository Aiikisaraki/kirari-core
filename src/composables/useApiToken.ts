import { ref } from 'vue';

interface DeployConfig {
    mode: 'local' | 'remote';
    server: { wsUrl: string; httpUrl: string };
    builtinToken?: string;
}

// 模型配置文件（config.json）结构：本地模式设置界面与用户外部编辑共用。
interface ModelConfigFile {
    endpoint?: string;
    model?: string;
    key?: string;
    seeded?: boolean;
}

interface TokenApiBridge {
    getDeployConfig(): Promise<DeployConfig>;
    setSession(token: string | null): Promise<void>;
    login(username: string, password: string): Promise<{ ok: boolean; uid?: number; message?: string }>;
    request(request: { method: 'GET' | 'POST' | 'PUT'; path: string; body: Record<string, unknown> }): Promise<{ status: number; data: Record<string, unknown> }>;
    getModelConfig(): Promise<ModelConfigFile>;
    setModelConfig(patch: Partial<ModelConfigFile>): Promise<ModelConfigFile>;
    onModelConfigChanged(cb: (cfg: ModelConfigFile) => void): void;
}

declare global {
    interface Window { tokenApi?: TokenApiBridge }
}

const isLoading = ref(false);
const error = ref('');

function getBridge() {
    if (!window.tokenApi) throw new Error('设置窗口通信不可用');
    return window.tokenApi;
}

// 本地缓存：保存最近一次从后端拿到的模型配置，作为打开设置界面时的「即时显示」
// 与「后端暂时不可达时的兜底」，避免表单闪现硬编码默认值、也避免重复手工设置。
const PROFILE_CACHE_KEY = 'kirari.profile.cache.v1';

interface ProfileCache {
    username?: string;
    model?: string;
    apiEndpoint?: string;
    tokenMasked?: string;
    hasToken?: boolean;
}

export function readProfileCache(): ProfileCache | null {
    try {
        const raw = localStorage.getItem(PROFILE_CACHE_KEY);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        if (obj && typeof obj === 'object') return obj as ProfileCache;
    } catch {
        // 缓存损坏则忽略
    }
    return null;
}

function writeProfileCache(p: ProfileCache) {
    try {
        localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(p));
    } catch {
        // 无视缓存写入失败
    }
}

export function useApiToken() {
    async function getDeployConfig(): Promise<DeployConfig> {
        return await getBridge().getDeployConfig();
    }

    async function request(method: 'GET' | 'POST' | 'PUT', path: string, body: Record<string, unknown>) {
        const result = await getBridge().request({ method, path, body });
        if (result.status >= 400) throw new Error(String(result.data.message || '请求失败'));
        return result.data;
    }

    async function login(username: string, password: string) {
        isLoading.value = true;
        error.value = '';
        try {
            return await getBridge().login(username, password);
        } catch (err) {
            const message = err instanceof Error ? err.message : '登录失败';
            error.value = message;
            return { ok: false, message };
        } finally {
            isLoading.value = false;
        }
    }

    async function getProfile(): Promise<{ username: string; model: string; apiEndpoint: string; tokenMasked: string; hasToken: boolean }> {
        try {
            const data = await request('GET', '/api/profile', {});
            const profile = {
                username: typeof data.username === 'string' ? data.username : '',
                model: typeof data.model === 'string' ? data.model : 'gpt-5.4-mini',
                apiEndpoint: typeof data.api_endpoint === 'string' ? data.api_endpoint : 'https://api.chatanywhere.tech/v1',
                tokenMasked: typeof data.token_masked === 'string' ? data.token_masked : '',
                hasToken: data.hasToken === true,
            };
            writeProfileCache(profile);
            return profile;
        } catch (err) {
            // 后端不可达时回退本地缓存，避免表单直接闪现硬编码默认值
            const cached = readProfileCache();
            if (cached) {
                return {
                    username: cached.username ?? '',
                    model: cached.model ?? 'gpt-5.4-mini',
                    apiEndpoint: cached.apiEndpoint ?? 'https://api.chatanywhere.tech/v1',
                    tokenMasked: cached.tokenMasked ?? '',
                    hasToken: cached.hasToken === true,
                };
            }
            throw err;
        }
    }

    async function updateProfile(patch: { model?: string; apiEndpoint?: string; token?: string }) {
        isLoading.value = true;
        error.value = '';
        try {
            const data = await request('PUT', '/api/profile', patch);
            const profile = {
                model: typeof data.model === 'string' ? data.model : 'gpt-5.4-mini',
                apiEndpoint: typeof data.api_endpoint === 'string' ? data.api_endpoint : '',
                tokenMasked: typeof data.token_masked === 'string' ? data.token_masked : '',
                hasToken: data.hasToken === true,
            };
            writeProfileCache(profile);
            return profile;
        } catch (err) {
            error.value = err instanceof Error ? err.message : '保存失败';
            throw err;
        } finally {
            isLoading.value = false;
        }
    }

    async function logout() {
        await getBridge().setSession(null);
    }

    // ---- 本地模式：直接读写模型配置文件（config.json） ----
    function maskKeyLocal(key: string): string {
        if (!key) return "";
        if (key.length <= 6) return "****";
        return `${key.slice(0, 3)}${"*".repeat(6)}${key.slice(-4)}`;
    }

    async function getModelConfig(): Promise<{ username: string; model: string; apiEndpoint: string; tokenMasked: string; hasToken: boolean }> {
        const data = await getBridge().getModelConfig();
        const model = typeof data.model === "string" && data.model.trim() ? data.model.trim() : "gpt-5.4-mini";
        const apiEndpoint = typeof data.endpoint === "string" && data.endpoint.trim() ? data.endpoint.trim() : "https://api.chatanywhere.tech/v1";
        const key = typeof data.key === "string" ? data.key : "";
        const profile = {
            username: "",
            model,
            apiEndpoint,
            tokenMasked: key ? maskKeyLocal(key) : "",
            hasToken: !!key,
        };
        writeProfileCache(profile);
        return profile;
    }

    async function setModelConfig(patch: { model?: string; endpoint?: string; key?: string }) {
        isLoading.value = true;
        error.value = "";
        try {
            const data = await getBridge().setModelConfig(patch);
            const key = typeof data.key === "string" ? data.key : "";
            const profile = {
                model: typeof data.model === "string" && data.model.trim() ? data.model.trim() : "gpt-5.4-mini",
                apiEndpoint: typeof data.endpoint === "string" && data.endpoint.trim() ? data.endpoint.trim() : "https://api.chatanywhere.tech/v1",
                tokenMasked: key ? maskKeyLocal(key) : "",
                hasToken: !!key,
            };
            writeProfileCache(profile);
            return profile;
        } catch (err) {
            error.value = err instanceof Error ? err.message : "保存失败";
            throw err;
        } finally {
            isLoading.value = false;
        }
    }

    function onModelConfigChanged(cb: (p: { model: string; apiEndpoint: string; hasToken: boolean; tokenMasked: string }) => void) {
        try {
            getBridge().onModelConfigChanged((cfg: { model?: string; endpoint?: string; key?: string }) => {
                const key = typeof cfg.key === "string" ? cfg.key : "";
                cb({
                    model: typeof cfg.model === "string" && cfg.model.trim() ? cfg.model.trim() : "gpt-5.4-mini",
                    apiEndpoint: typeof cfg.endpoint === "string" && cfg.endpoint.trim() ? cfg.endpoint.trim() : "https://api.chatanywhere.tech/v1",
                    tokenMasked: key ? maskKeyLocal(key) : "",
                    hasToken: !!key,
                });
            });
        } catch {
            // 桥不可用则静默
        }
    }

    return { isLoading, error, getDeployConfig, login, getProfile, updateProfile, logout, readProfileCache, getModelConfig, setModelConfig, onModelConfigChanged };
}
