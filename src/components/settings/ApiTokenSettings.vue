<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useApiToken } from "../../composables/useApiToken";
import { useThemeStore, THEMES } from "../../stores/theme";
import { useAvatarStore } from "../../stores/avatar";
import WindowChrome from "../common/WindowChrome.vue";

const avatarStore = useAvatarStore();
const isImporting = ref(false);
const importError = ref("");

async function handleImport() {
    importError.value = "";
    isImporting.value = true;
    try {
        const r = await avatarStore.importAvatarFolder();
        if (!r.ok) importError.value = r.message || "导入失败";
    } finally {
        isImporting.value = false;
    }
}

const {
    isLoading,
    error,
    getDeployConfig,
    login,
    getProfile,
    updateProfile,
    logout,
    readProfileCache,
    getModelConfig,
    setModelConfig,
    onModelConfigChanged,
} = useApiToken();
const themeStore = useThemeStore();
// 免费大模型 API Key 领取指引（chatanywhere，支持 gpt/deepseek/通义千问等，国内直连免代理）
const freeKeyUrl = "https://github.com/chatanywhere/GPT_API_free";

const mode = ref<"local" | "remote">("local");
const authed = ref(false);
const username = ref("");
const password = ref("");
const loginError = ref("");

const modelInput = ref("gpt-5.4-mini");
const apiEndpointInput = ref("https://api.chatanywhere.tech/v1");
const tokenMasked = ref("");
const hasToken = ref(false);
const newTokenInput = ref("");
const accountName = ref("");
const saveSuccess = ref(false);
// 记录打开时从后端/缓存读到的最新值，保存时只发送「发生变更」的字段，
// 这样用户改一个就只改一个，不必三个一起填。
const baseProfile = ref<{ model: string; apiEndpoint: string } | null>(null);
let clearTimer: ReturnType<typeof setTimeout> | undefined;

function applyProfile(p: {
    username: string;
    model: string;
    apiEndpoint: string;
    tokenMasked: string;
    hasToken: boolean;
}) {
    accountName.value = p.username;
    modelInput.value = p.model;
    apiEndpointInput.value = p.apiEndpoint;
    tokenMasked.value = p.tokenMasked;
    hasToken.value = p.hasToken;
}

onMounted(async () => {
    try {
        await avatarStore.init();
        const config = await getDeployConfig();
        mode.value = config.mode;
        if (config.mode === "local") {
            // 本地模式：config.json 为权威配置文件，订阅外部编辑实时刷新
            onModelConfigChanged((p) => {
                applyProfile(p);
                baseProfile.value = {
                    model: p.model,
                    apiEndpoint: p.apiEndpoint,
                };
            });
            await loadProfile();
        }
        // remote 模式：需先在下方登录板块通过验证，authed 保持 false 直到登录成功
    } catch (err) {
        loginError.value = err instanceof Error ? err.message : "读取配置失败";
    }
});

async function loadProfile() {
    // 1) 先用本地缓存即时显示，避免表单闪现硬编码默认值
    const cached = readProfileCache();
    if (cached) {
        applyProfile({
            username: cached.username ?? "",
            model: cached.model ?? "gpt-5.4-mini",
            apiEndpoint:
                cached.apiEndpoint ?? "https://api.chatanywhere.tech/v1",
            tokenMasked: cached.tokenMasked ?? "",
            hasToken: cached.hasToken === true,
        });
        authed.value = true;
    }
    // 2) 拉取当前最新值（本地=config.json，远程=后端 /api/profile），覆盖缓存
    try {
        const profile =
            mode.value === "remote"
                ? await getProfile()
                : await getModelConfig();
        applyProfile(profile);
        baseProfile.value = {
            model: profile.model,
            apiEndpoint: profile.apiEndpoint,
        };
        authed.value = true;
    } catch {
        // 不可达：已显示缓存；若连缓存也没有则保持默认占位
    }
}

async function handleLogin() {
    loginError.value = "";
    if (!username.value || !password.value) {
        loginError.value = "请输入用户名和密码";
        return;
    }
    const result = await login(username.value, password.value);
    if (result.ok) {
        await loadProfile();
    } else {
        loginError.value = result.message || "登录失败";
    }
}

function handleLogout() {
    logout();
    authed.value = false;
    username.value = "";
    password.value = "";
    newTokenInput.value = "";
    hasToken.value = false;
    tokenMasked.value = "";
    baseProfile.value = null;
}

function flashSuccess() {
    saveSuccess.value = true;
    if (clearTimer) clearTimeout(clearTimer);
    clearTimer = setTimeout(() => {
        saveSuccess.value = false;
    }, 2000);
}

async function handleSave() {
    const model = modelInput.value.trim();
    const endpoint = apiEndpointInput.value.trim();
    if (!model || !endpoint) {
        loginError.value = "模型名称和 API 端点不能为空";
        return;
    }
    // 仅发送变更过的字段：改一个就只发一个，不必三个一起填。
    // 字段名必须与 config.json / IPC config:set 保持一致（endpoint/model/key）。
    const patch: { model?: string; endpoint?: string; key?: string } = {};
    if (model !== (baseProfile.value?.model ?? "")) patch.model = model;
    if (endpoint !== (baseProfile.value?.apiEndpoint ?? ""))
        patch.endpoint = endpoint;
    if (newTokenInput.value.trim()) patch.key = newTokenInput.value.trim();

    if (Object.keys(patch).length === 0) {
        // 没有任何变更，无需请求
        flashSuccess();
        return;
    }
    try {
        // 本地模式直接写 config.json（权威配置文件）；远程模式写后端 /api/profile。
        const updated =
            mode.value === "remote"
                ? await updateProfile(patch)
                : await setModelConfig(patch);
        modelInput.value = updated.model;
        apiEndpointInput.value = updated.apiEndpoint;
        tokenMasked.value = updated.tokenMasked;
        hasToken.value = updated.hasToken;
        baseProfile.value = {
            model: updated.model,
            apiEndpoint: updated.apiEndpoint,
        };
        newTokenInput.value = "";
        flashSuccess();
    } catch {
        // error 已由 composable 写入
    }
}
</script>

<template>
    <div class="app-shell">
        <WindowChrome title="设置" />
        <main class="api-token-settings">
            <h2>设置</h2>

            <!-- 外观主题：即时切换并自动保存 -->
            <section class="theme-section">
                <h3>外观主题</h3>
                <p class="hint">
                    对话框与设置界面的视觉风格，切换即时生效并自动保存。
                </p>
                <div class="theme-grid">
                    <button
                        v-for="t in THEMES"
                        :key="t.id"
                        type="button"
                        class="theme-card"
                        :class="{ 'is-active': themeStore.current === t.id }"
                        @click="themeStore.setTheme(t.id)"
                    >
                        <span
                            class="theme-swatch"
                            :class="'swatch-' + t.id"
                        ></span>
                        <span class="theme-label">{{ t.label }}</span>
                    </button>
                </div>
            </section>

            <!-- 桌宠形象管理 -->
            <section class="avatar-section">
                <h3>桌宠形象</h3>
                <p class="hint">
                    切换桌宠渲染形象。支持内置精灵帧与
                    Live2D（即将推出），也可导入你自己的精灵帧形象。
                </p>
                <div class="avatar-grid">
                    <button
                        v-for="a in avatarStore.list"
                        :key="a.id"
                        type="button"
                        class="avatar-card"
                        :class="{
                            'is-active': avatarStore.isActive(a),
                            'is-disabled': a.type === 'live2d',
                        }"
                        :disabled="a.type === 'live2d'"
                        @click="a.type !== 'live2d' && avatarStore.setAvatar(a)"
                    >
                        <span class="avatar-type">{{
                            a.type === "sprite" ? "精灵帧" : "Live2D"
                        }}</span>
                        <span class="avatar-label">{{ a.name }}</span>
                        <span v-if="a.type === 'live2d'" class="avatar-tag"
                            >即将推出</span
                        >
                        <span v-else-if="a.builtin" class="avatar-tag"
                            >内置</span
                        >
                        <span v-else class="avatar-tag">自定义</span>
                    </button>
                </div>
                <button
                    type="button"
                    class="import-btn"
                    :disabled="isImporting"
                    @click="handleImport"
                >
                    {{ isImporting ? "导入中..." : "导入精灵形象文件夹" }}
                </button>
                <div v-if="importError" class="error-message">
                    {{ importError }}
                </div>
                <p class="hint">
                    导入的文件夹需包含 frames.json 与对应精灵图（如
                    idle.png），格式参考内置形象。
                </p>
            </section>

            <!-- 远程模式：登录板块（本地模式不显示） -->
            <section v-if="mode === 'remote' && !authed" class="login-section">
                <h3>登录服务端</h3>
                <p class="hint">连接远程服务端，验证通过后才能修改配置。</p>
                <label for="username">用户名</label>
                <input
                    id="username"
                    v-model="username"
                    type="text"
                    autocomplete="username"
                    placeholder="用户名"
                    :disabled="isLoading"
                />
                <label for="password">密码</label>
                <div class="input-wrapper">
                    <input
                        id="password"
                        v-model="password"
                        type="password"
                        autocomplete="current-password"
                        placeholder="密码"
                        :disabled="isLoading"
                        @keyup.enter="handleLogin"
                    />
                </div>
                <button
                    type="button"
                    class="primary-btn"
                    :disabled="isLoading"
                    @click="handleLogin"
                >
                    {{ isLoading ? "登录中..." : "登录" }}
                </button>
                <div v-if="loginError || error" class="error-message">
                    {{ loginError || error }}
                </div>
            </section>

            <!-- 配置区：本地模式直接可用；远程模式登录后启用 -->
            <section v-if="authed" class="config-section">
                <div class="auth-bar">
                    <span class="hint"
                        >当前账户：{{
                            accountName ||
                            (mode === "local" ? "本地内置账户" : "")
                        }}</span
                    >
                    <button
                        v-if="mode === 'remote'"
                        type="button"
                        class="link-btn"
                        @click="handleLogout"
                    >
                        退出登录
                    </button>
                </div>

                <label for="model">模型名称</label>
                <input
                    id="model"
                    v-model="modelInput"
                    type="text"
                    autocomplete="off"
                    placeholder="例如 gpt-5.4-mini"
                    :disabled="isLoading"
                />

                <label for="endpoint">模型 API 端点</label>
                <input
                    id="endpoint"
                    v-model="apiEndpointInput"
                    type="url"
                    autocomplete="off"
                    placeholder="https://api.chatanywhere.tech/v1"
                    :disabled="isLoading"
                />
                <p class="hint">这是大模型 API 地址，不是本地后端地址。</p>
                <p class="hint free-key-hint">
                    没有 API Key？可前往
                    <a
                        :href="freeKeyUrl"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="inline-link"
                        >chatanywhere</a
                    >
                    免费领取（支持 gpt / deepseek /
                    通义千问等常用模型，国内直连、免代理，每日有免费额度）。
                </p>

                <label for="newToken">API Token</label>
                <input
                    id="newToken"
                    v-model="newTokenInput"
                    type="password"
                    autocomplete="new-password"
                    placeholder="输入新 Token 以替换（留空则不修改）"
                    :disabled="isLoading"
                />
                <p v-if="hasToken" class="hint">
                    当前 Token：{{ tokenMasked }}（已加密保存，无需查看明文）
                </p>

                <button
                    type="button"
                    class="primary-btn"
                    :disabled="isLoading"
                    @click="handleSave"
                >
                    {{ isLoading ? "保存中..." : "保存设置" }}
                </button>
                <div v-if="saveSuccess" class="success-message">保存成功</div>
                <div v-if="error" class="error-message">{{ error }}</div>
            </section>
        </main>
    </div>
</template>

<style scoped>
.api-token-settings {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 22px 24px 28px;
    max-width: 600px;
    margin: 0 auto;
    width: 100%;
    color: var(--pet-ink);
}
.login-section,
.config-section {
    display: grid;
    gap: 12px;
    padding: 16px;
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.45);
    backdrop-filter: blur(12px) saturate(140%);
    -webkit-backdrop-filter: blur(12px) saturate(140%);
    border: 1px solid rgba(255, 255, 255, 0.5);
    box-shadow: 0 10px 28px rgba(57, 44, 76, 0.1);
}
.login-section {
    margin-bottom: 20px;
}
.auth-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
}
.input-wrapper {
    display: flex;
    gap: 8px;
}
label {
    font-size: 13px;
    font-weight: 600;
    color: var(--pet-muted);
}
input {
    flex: 1;
    padding: 10px 12px;
    border: 1px solid var(--pet-border);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.55);
    color: var(--pet-ink);
    transition:
        border-color 140ms ease,
        box-shadow 140ms ease;
}
input:focus {
    outline: none;
    border-color: var(--pet-accent);
    box-shadow: 0 0 0 3px var(--pet-focus-ring);
}
button {
    padding: 10px 16px;
    border: 0;
    border-radius: 8px;
    cursor: pointer;
    font-weight: 600;
}
button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}
.primary-btn {
    background: var(--pet-accent);
    color: #fff;
    box-shadow: var(--pet-primary-shadow);
    transition:
        filter 140ms ease,
        transform 140ms ease;
}
.primary-btn:not(:disabled):hover {
    filter: brightness(1.05);
}
.primary-btn:not(:disabled):active {
    transform: translateY(1px);
}
.link-btn {
    background: transparent;
    color: var(--pet-accent);
    padding: 4px 0;
}
.hint {
    color: var(--pet-muted);
    font-size: 13px;
}
.free-key-hint {
    line-height: 1.5;
}
.inline-link {
    color: var(--pet-accent);
    font-weight: 600;
    text-decoration: none;
    border-bottom: 1px solid currentColor;
    transition:
        filter 140ms ease,
        opacity 140ms ease;
}
.inline-link:hover {
    filter: brightness(1.1);
    opacity: 0.85;
}
.error-message {
    color: #d33;
}
.success-message {
    color: #298a29;
}
.theme-section {
    display: grid;
    gap: 12px;
    padding: 16px;
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.45);
    backdrop-filter: blur(12px) saturate(140%);
    -webkit-backdrop-filter: blur(12px) saturate(140%);
    border: 1px solid rgba(255, 255, 255, 0.5);
    box-shadow: 0 10px 28px rgba(57, 44, 76, 0.1);
    margin-bottom: 20px;
}
.theme-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 10px;
}
.theme-card {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border: 1.5px solid var(--pet-border);
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.5);
    color: var(--pet-ink);
    cursor: pointer;
    font-weight: 600;
    font-size: 13px;
    transition:
        border-color 140ms ease,
        box-shadow 140ms ease,
        transform 140ms ease;
}
.theme-card:hover {
    transform: translateY(-1px);
}
.theme-card.is-active {
    border-color: var(--pet-accent);
    box-shadow: 0 0 0 3px var(--pet-focus-ring);
}
.theme-swatch {
    width: 28px;
    height: 28px;
    border-radius: 8px;
    flex: 0 0 auto;
    border: 1px solid rgba(0, 0, 0, 0.08);
}
.swatch-aurora-glass {
    background: linear-gradient(135deg, #006fee 0%, #7c3aed 50%, #f31260 100%);
}
.swatch-pet-pink {
    background: linear-gradient(135deg, #ef7f8f 0%, #d85f75 100%);
}
.avatar-section {
    display: grid;
    gap: 12px;
    padding: 16px;
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.45);
    backdrop-filter: blur(12px) saturate(140%);
    -webkit-backdrop-filter: blur(12px) saturate(140%);
    border: 1px solid rgba(255, 255, 255, 0.5);
    box-shadow: 0 10px 28px rgba(57, 44, 76, 0.1);
    margin-bottom: 20px;
}
.avatar-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 10px;
}
.avatar-card {
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: flex-start;
    padding: 12px;
    border: 1.5px solid var(--pet-border);
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.5);
    color: var(--pet-ink);
    cursor: pointer;
    font-weight: 600;
    font-size: 13px;
    text-align: left;
    transition:
        border-color 140ms ease,
        box-shadow 140ms ease,
        transform 140ms ease;
}
.avatar-card:hover:not(.is-disabled) {
    transform: translateY(-1px);
}
.avatar-card.is-active {
    border-color: var(--pet-accent);
    box-shadow: 0 0 0 3px var(--pet-focus-ring);
}
.avatar-card.is-disabled {
    opacity: 0.55;
    cursor: not-allowed;
}
.avatar-type {
    font-size: 11px;
    color: var(--pet-muted);
    font-weight: 700;
    letter-spacing: 0.04em;
}
.avatar-label {
    font-size: 14px;
}
.avatar-tag {
    font-size: 11px;
    padding: 1px 8px;
    border-radius: 999px;
    background: var(--pet-accent-soft);
    color: var(--pet-accent);
}
.import-btn {
    background: var(--pet-accent);
    color: #fff;
    border: 0;
    border-radius: 8px;
    padding: 10px 16px;
    font-weight: 600;
    cursor: pointer;
    box-shadow: var(--pet-primary-shadow);
    transition:
        filter 140ms ease,
        transform 140ms ease;
}
.import-btn:not(:disabled):hover {
    filter: brightness(1.05);
}
.import-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}
</style>
