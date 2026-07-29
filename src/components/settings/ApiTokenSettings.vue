<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useApiToken } from "../../composables/useApiToken";
import { useThemeStore, THEMES } from "../../stores/theme";
import { useAvatarStore } from "../../stores/avatar";
import WindowChrome from "../common/WindowChrome.vue";

const avatarStore = useAvatarStore();
const isZipping = ref(false);
const zipError = ref("");
const avatarError = ref("");

// 上传形象压缩包：选择 ZIP → 主进程解压到形象目录 → 校验 → 注册并切换。
async function handleImportZip() {
    zipError.value = "";
    isZipping.value = true;
    try {
        const r = await avatarStore.importAvatarZip();
        if (!r.ok) zipError.value = r.message || "上传失败";
    } finally {
        isZipping.value = false;
    }
}

// 打开形象目录，方便用户把自定义形象文件夹放进去。
async function handleOpenFolder() {
    try {
        await avatarStore.openAvatarsFolder();
    } catch {
        /* 忽略 */
    }
}

// 用系统默认浏览器打开外部链接（经主进程 shell.openExternal，避免 Electron 内置窗口打开）。
function openExternal(url: string) {
    const w = window as unknown as {
        windowApi?: { openExternal?: (u: string) => Promise<void> };
    };
    w.windowApi?.openExternal?.(url);
}

// 开机自启动：读取当前登录项状态，以及切换时写回。
const autoLaunch = ref(false);
const autoLaunchBusy = ref(false);

async function loadAutoLaunch() {
    try {
        const w = window as unknown as {
            windowApi?: { getAutoLaunch?: () => Promise<boolean> };
        };
        if (w.windowApi?.getAutoLaunch) {
            autoLaunch.value = await w.windowApi.getAutoLaunch();
        }
    } catch {
        /* 忽略：读取失败则不勾选 */
    }
}

async function handleAutoLaunchChange() {
    autoLaunchBusy.value = true;
    try {
        const w = window as unknown as {
            windowApi?: { setAutoLaunch?: (e: boolean) => Promise<void> };
        };
        await w.windowApi?.setAutoLaunch?.(autoLaunch.value);
    } catch {
        /* 忽略 */
    } finally {
        autoLaunchBusy.value = false;
    }
}

async function handleSelectAvatar(id: string) {
    avatarError.value = "";
    const found = avatarStore.list.find((a) => a.id === id);
    if (!found) {
        avatarError.value = `未找到形象 ${id}`;
        return;
    }
    try {
        await avatarStore.setAvatar(found);
    } catch (e) {
        avatarError.value = e instanceof Error ? e.message : "切换形象失败";
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
const searchKeyMasked = ref("");
const hasSearchKey = ref(false);
const newSearchKeyInput = ref("");
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
    searchKeyMasked?: string;
    hasSearchKey?: boolean;
}) {
    accountName.value = p.username;
    modelInput.value = p.model;
    apiEndpointInput.value = p.apiEndpoint;
    tokenMasked.value = p.tokenMasked;
    hasToken.value = p.hasToken;
    searchKeyMasked.value = p.searchKeyMasked ?? "";
    hasSearchKey.value = p.hasSearchKey === true;
}

onMounted(async () => {
    try {
        await avatarStore.init();
        // 每次打开设置页自动重新扫描形象目录，无需手动刷新。
        await avatarStore.rescanAvatars();
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
    // 开机自启动状态（与安装向导完成页的勾选共用同一套 Electron 登录项）
    await loadAutoLaunch();
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
    newSearchKeyInput.value = "";
    hasSearchKey.value = false;
    searchKeyMasked.value = "";
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
    // 字段名必须与 config.json / IPC config:set 保持一致（endpoint/model/key/searchKey）。
    const patch: { model?: string; endpoint?: string; key?: string; searchKey?: string } = {};
    if (model !== (baseProfile.value?.model ?? "")) patch.model = model;
    if (endpoint !== (baseProfile.value?.apiEndpoint ?? ""))
        patch.endpoint = endpoint;
    if (newTokenInput.value.trim()) patch.key = newTokenInput.value.trim();
    if (newSearchKeyInput.value.trim()) patch.searchKey = newSearchKeyInput.value.trim();

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
        searchKeyMasked.value = updated.searchKeyMasked;
        hasSearchKey.value = updated.hasSearchKey;
        baseProfile.value = {
            model: updated.model,
            apiEndpoint: updated.apiEndpoint,
        };
        newTokenInput.value = "";
        newSearchKeyInput.value = "";
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

            <!-- 通用：开机自启动 -->
            <section class="general-section">
                <h3>通用</h3>
                <label class="checkbox-row">
                    <input
                        type="checkbox"
                        v-model="autoLaunch"
                        :disabled="autoLaunchBusy"
                        @change="handleAutoLaunchChange"
                    />
                    <span>开机自动启动</span>
                </label>
                <p class="hint">
                    勾选后，系统登录时会自动启动 Kirari绮莉。也可在安装向导的最后一页勾选。
                </p>
            </section>

            <!-- 桌宠形象管理 -->
            <section class="avatar-section">
                <h3 class="section-title">桌宠形象</h3>
                <p class="hint">
                    切换桌宠形象。渲染方式由皮肤配置文件（frames.json）里的
                    <code>type</code> 字段自动决定，无需手动选择。
                </p>

                <div class="avatar-current">
                    <label for="avatar-select">当前形象</label>
                    <div class="select-wrap">
                        <select
                            id="avatar-select"
                            class="avatar-select"
                            :value="avatarStore.current.id"
                            @change="
                                handleSelectAvatar(($event.target as HTMLSelectElement).value)
                            "
                        >
                            <option
                                v-for="a in avatarStore.list"
                                :key="a.id"
                                :value="a.id"
                            >
                                {{ a.name }}
                            </option>
                        </select>
                        <svg
                            class="select-caret"
                            viewBox="0 0 24 24"
                            width="16"
                            height="16"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2.4"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                        >
                            <path d="M6 9l6 6 6-6" />
                        </svg>
                    </div>
                </div>

                <div class="avatar-actions">
                    <button
                        type="button"
                        class="import-btn"
                        :disabled="isZipping"
                        @click="handleImportZip"
                    >
                        <svg
                            viewBox="0 0 24 24"
                            width="17"
                            height="17"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                        >
                            <path d="M12 15V8m0 0L8.5 11.5M12 8l3.5 3.5" />
                            <path d="M20 16.5A4.5 4.5 0 0 0 17.5 8h-1.3A6 6 0 1 0 6 14.6" />
                        </svg>
                        <span>{{ isZipping ? "解压中…" : "上传压缩包" }}</span>
                    </button>
                    <button
                        type="button"
                        class="ghost-btn"
                        @click="handleOpenFolder"
                    >
                        <svg
                            viewBox="0 0 24 24"
                            width="17"
                            height="17"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                        >
                            <path d="M3 7a2 2 0 0 1 2-2h3.6a1 1 0 0 1 .8.4L10.5 7H18a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                        </svg>
                        <span>打开形象文件夹</span>
                    </button>
                </div>

                <div
                    v-if="zipError || avatarError"
                    class="error-message"
                >
                    {{ zipError || avatarError }}
                </div>

                <p class="avatar-tip">
                    <svg
                        viewBox="0 0 24 24"
                        width="15"
                        height="15"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                    >
                        <circle cx="12" cy="12" r="9" />
                        <path d="M12 11v5" />
                        <path d="M12 7.5h.01" />
                    </svg>
                    <span>自定义形象文件夹需包含 <code>frames.json</code> 与对应精灵图。直接丢进「形象文件夹」，或点「上传压缩包」自动解压；打开设置页时会自动刷新列表。</span>
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
                        href="#"
                        class="inline-link"
                        @click.prevent="openExternal(freeKeyUrl)"
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

                <label for="newSearchKey">搜索 / 新闻 API Key（Tavily）</label>
                <input
                    id="newSearchKey"
                    v-model="newSearchKeyInput"
                    type="password"
                    autocomplete="new-password"
                    placeholder="选填：填后可联网搜索/查新闻（留空则不修改）"
                    :disabled="isLoading"
                />
                <p class="hint">
                    用于「联网搜索 / 新闻」工具。天气与时间无需 Key；不填则桌宠只能回答天气、时间。
                    在
                    <a
                        href="#"
                        class="inline-link"
                        @click.prevent="openExternal('https://tavily.com')"
                        >Tavily</a
                    >
                    免费领取（有免费额度，专为 LLM 优化）。
                </p>
                <p v-if="hasSearchKey" class="hint">
                    当前搜索 Key：{{ searchKeyMasked }}（已加密保存，无需查看明文）
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
    gap: 14px;
    padding: 18px 18px 20px;
    border-radius: 16px;
    background: rgba(255, 255, 255, 0.5);
    backdrop-filter: blur(12px) saturate(140%);
    -webkit-backdrop-filter: blur(12px) saturate(140%);
    border: 1px solid rgba(255, 255, 255, 0.6);
    box-shadow: 0 10px 28px rgba(57, 44, 76, 0.1);
    margin-bottom: 20px;
}
.avatar-section .section-title {
    display: flex;
    align-items: center;
    gap: 9px;
    margin: 0;
    font-size: 16px;
    font-weight: 800;
    letter-spacing: 0.5px;
    color: var(--pet-ink);
}
.avatar-section .section-title::before {
    content: "";
    width: 11px;
    height: 11px;
    border-radius: 50%;
    background: linear-gradient(135deg, #ff8fb1 0%, #a78bfa 100%);
    box-shadow: 0 0 0 4px rgba(167, 139, 250, 0.18);
    flex: 0 0 auto;
}

/* 当前形象子卡片 */
.avatar-current {
    display: grid;
    gap: 8px;
    padding: 14px;
    border-radius: 13px;
    background: linear-gradient(
        180deg,
        rgba(255, 255, 255, 0.7),
        rgba(255, 255, 255, 0.42)
    );
    border: 1px solid rgba(167, 139, 250, 0.18);
}
.avatar-current label {
    font-size: 13px;
    font-weight: 700;
    color: var(--pet-muted);
}
.select-wrap {
    position: relative;
    display: flex;
    align-items: center;
}
.avatar-select {
    width: 100%;
    padding: 11px 38px 11px 14px;
    border: 1.5px solid var(--pet-border);
    border-radius: 11px;
    background: rgba(255, 255, 255, 0.85);
    color: var(--pet-ink);
    font-size: 14px;
    font-weight: 600;
    font-family: "PingFang SC", "Microsoft YaHei", "Segoe UI", system-ui,
        -apple-system, sans-serif;
    cursor: pointer;
    appearance: none;
    -webkit-appearance: none;
    transition:
        border-color 140ms ease,
        box-shadow 140ms ease;
}
.avatar-select:focus {
    outline: none;
    border-color: #c4a3ff;
    box-shadow: 0 0 0 3px rgba(167, 139, 250, 0.25);
}
.select-caret {
    position: absolute;
    right: 12px;
    pointer-events: none;
    color: var(--pet-accent, #7c3aed);
}

/* 操作按钮：等宽胶囊按钮 + 内联图标 */
.avatar-actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
}
.import-btn,
.ghost-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 12px 14px;
    border-radius: 999px;
    font-size: 14px;
    font-weight: 700;
    letter-spacing: 0.3px;
    white-space: nowrap;
    font-family: "PingFang SC", "Microsoft YaHei", "Segoe UI", system-ui,
        -apple-system, sans-serif;
    cursor: pointer;
    transition:
        transform 160ms cubic-bezier(0.34, 1.56, 0.64, 1),
        box-shadow 160ms ease,
        filter 160ms ease,
        background 160ms ease,
        border-color 160ms ease;
}
@media (max-width: 420px) {
    .avatar-actions {
        grid-template-columns: 1fr;
    }
}
.import-btn svg,
.ghost-btn svg {
    width: 17px;
    height: 17px;
    flex: 0 0 auto;
}
.import-btn {
    border: 0;
    color: #fff;
    background: linear-gradient(135deg, #ff8fb1 0%, #b07cf0 55%, #8b5cf6 100%);
    box-shadow: 0 8px 18px rgba(176, 124, 240, 0.4);
}
.import-btn:not(:disabled):hover {
    transform: translateY(-2px) scale(1.02);
    filter: brightness(1.05);
    box-shadow: 0 12px 22px rgba(176, 124, 240, 0.5);
}
.import-btn:not(:disabled):active {
    transform: translateY(0) scale(0.97);
}
.import-btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
    box-shadow: none;
}
.ghost-btn {
    border: 1.5px solid rgba(167, 139, 250, 0.45);
    background: rgba(255, 255, 255, 0.7);
    color: var(--pet-accent, #7c3aed);
}
.ghost-btn:not(:disabled):hover {
    background: rgba(167, 139, 250, 0.12);
    border-color: rgba(167, 139, 250, 0.7);
    transform: translateY(-2px) scale(1.02);
}
.ghost-btn:not(:disabled):active {
    transform: translateY(0) scale(0.97);
}
.ghost-btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
}

/* 底部提示气泡 */
.avatar-tip {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin: 0;
    padding: 10px 12px;
    border-radius: 11px;
    background: rgba(167, 139, 250, 0.1);
    color: var(--pet-muted);
    font-size: 12.5px;
    line-height: 1.55;
}
.avatar-tip svg {
    flex: 0 0 auto;
    margin-top: 1px;
    color: var(--pet-accent, #7c3aed);
}
.avatar-tip code {
    background: rgba(124, 58, 237, 0.16);
    color: var(--pet-accent, #7c3aed);
    padding: 1px 6px;
    border-radius: 6px;
    font-size: 11.5px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
code {
    background: rgba(124, 58, 237, 0.12);
    color: var(--pet-accent);
    padding: 1px 6px;
    border-radius: 6px;
    font-size: 12px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
</style>
