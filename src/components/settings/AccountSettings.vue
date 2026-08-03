<script setup lang="ts">
import { inject, onMounted, ref, watch } from "vue";
import { SETTINGS_CONTEXT } from "./settingsContext";
import { useApiToken } from "../../composables/useApiToken";

const { mode, authed, accountName, refreshAuth, login, register, logout } =
    inject(SETTINGS_CONTEXT)!;
const { getDeployConfig, setDeployServer } = useApiToken();

const authMode = ref<"login" | "register">("login");
const username = ref("");
const password = ref("");
const isLoading = ref(false);
const loginError = ref("");

// —— 远程服务端地址（仅 remote 模式可编辑） ——
const wsUrl = ref("");
const httpUrl = ref("");
const serverLoading = ref(false);
const serverError = ref("");
const serverSaved = ref(false);

async function loadServerConfig() {
    try {
        const cfg = await getDeployConfig();
        wsUrl.value = cfg.server?.wsUrl || "";
        httpUrl.value = cfg.server?.httpUrl || "";
        serverSaved.value = false;
    } catch {
        // 读取失败则保留空值
    }
}

// 进入远程模式时加载当前服务端地址（首次挂载或 local→remote 切换时）。
onMounted(() => {
    if (mode.value === "remote") loadServerConfig();
});
watch(mode, (m) => {
    if (m === "remote") loadServerConfig();
});

async function handleSaveServer() {
    serverError.value = "";
    serverSaved.value = false;
    if (!httpUrl.value.trim()) {
        serverError.value = "请填写 HTTP 地址";
        return;
    }
    serverLoading.value = true;
    try {
        await setDeployServer({
            wsUrl: wsUrl.value.trim(),
            httpUrl: httpUrl.value.trim(),
        });
        serverSaved.value = true;
        // 重新校验连接状态（刷新登录态等）
        await refreshAuth();
    } catch (err) {
        serverError.value = err instanceof Error ? err.message : "保存失败";
    } finally {
        serverLoading.value = false;
    }
}

async function handleLogin() {
    loginError.value = "";
    if (!username.value || !password.value) {
        loginError.value = "请输入用户名和密码";
        return;
    }
    isLoading.value = true;
    try {
        const r = await login(username.value, password.value);
        if (r.ok) await refreshAuth();
        else loginError.value = r.message || "登录失败";
    } finally {
        isLoading.value = false;
    }
}

// 注册新账号：成功后用同一凭据自动登录，省去用户再登一次。
async function handleRegister() {
    loginError.value = "";
    if (!username.value || !password.value) {
        loginError.value = "请输入用户名和密码";
        return;
    }
    if (username.value.trim().length < 3) {
        loginError.value = "用户名至少 3 个字符";
        return;
    }
    if (password.value.length < 6) {
        loginError.value = "密码至少 6 位";
        return;
    }
    isLoading.value = true;
    try {
        const r = await register(username.value.trim(), password.value);
        if (!r.ok) {
            loginError.value = r.message || "注册失败";
            return;
        }
        const lr = await login(username.value.trim(), password.value);
        if (lr.ok) await refreshAuth();
        else loginError.value = lr.message || "注册成功，但自动登录失败，请手动登录";
    } finally {
        isLoading.value = false;
    }
}

function handleLogout() {
    logout();
    authed.value = false;
    accountName.value = "";
    username.value = "";
    password.value = "";
    loginError.value = "";
}
</script>

<template>
    <template v-if="mode === 'remote'">
        <!-- 远程服务端地址：用户部署好服务端后在此填写，保存即重连 -->
        <section class="settings-card">
            <h3 class="settings-card__title">
                <span class="title-emoji">🌐</span>
                <span>服务端地址</span>
            </h3>
            <p class="settings-card__desc">
                连接远程服务端时使用的地址。修改后自动重新连接，无需重启应用。
            </p>

            <div class="field">
                <label class="field-label" for="wsUrl">WebSocket 地址</label>
                <input
                    id="wsUrl"
                    v-model="wsUrl"
                    class="text-input"
                    type="text"
                    placeholder="ws://your-server:9089/ws"
                    :disabled="serverLoading"
                />
            </div>
            <div class="field">
                <label class="field-label" for="httpUrl">HTTP 地址</label>
                <input
                    id="httpUrl"
                    v-model="httpUrl"
                    class="text-input"
                    type="text"
                    placeholder="http://your-server:9089"
                    :disabled="serverLoading"
                />
            </div>

            <button
                type="button"
                class="btn btn--primary btn--block"
                :disabled="serverLoading"
                @click="handleSaveServer"
            >
                {{
                    serverLoading
                        ? "保存中..."
                        : serverSaved
                          ? "已保存 ✓"
                          : "保存并重新连接"
                }}
            </button>
            <div v-if="serverError" class="settings-error">{{ serverError }}</div>
        </section>

        <!-- 账号：登录 / 注册 -->
        <section id="account" class="settings-card">
            <!-- 未登录：登录 / 注册 -->
            <template v-if="!authed">
                <h3 class="settings-card__title">
                    <span class="title-emoji">🔑</span>
                    <span>{{
                        authMode === "login" ? "登录服务端" : "注册服务端账号"
                    }}</span>
                </h3>
                <p class="settings-card__desc">
                    {{
                        authMode === "login"
                            ? "连接远程服务端，验证通过后才能修改配置。"
                            : "创建服务端账号（用户名 3-32 字符、密码至少 6 位），注册成功后将自动登录。"
                    }}
                </p>

                <div class="auth-tabs">
                    <button
                        type="button"
                        class="auth-tab"
                        :class="{ 'is-active': authMode === 'login' }"
                        @click="authMode = 'login'"
                    >
                        登录
                    </button>
                    <button
                        type="button"
                        class="auth-tab"
                        :class="{ 'is-active': authMode === 'register' }"
                        @click="authMode = 'register'"
                    >
                        注册
                    </button>
                </div>

                <div class="field">
                    <label class="field-label" for="username">用户名</label>
                    <input
                        id="username"
                        v-model="username"
                        class="text-input"
                        type="text"
                        autocomplete="username"
                        placeholder="用户名"
                        :disabled="isLoading"
                    />
                </div>
                <div class="field">
                    <label class="field-label" for="password">密码</label>
                    <input
                        id="password"
                        v-model="password"
                        class="text-input"
                        type="password"
                        :autocomplete="
                            authMode === 'login' ? 'current-password' : 'new-password'
                        "
                        placeholder="密码"
                        :disabled="isLoading"
                        @keyup.enter="
                            authMode === 'login' ? handleLogin() : handleRegister()
                        "
                    />
                </div>

                <button
                    type="button"
                    class="btn btn--primary btn--block"
                    :disabled="isLoading"
                    @click="authMode === 'login' ? handleLogin() : handleRegister()"
                >
                    {{
                        isLoading
                            ? authMode === "login"
                                ? "登录中..."
                                : "注册中..."
                            : authMode === "login"
                              ? "登录"
                              : "注册"
                    }}
                </button>
                <div v-if="loginError" class="settings-error">{{ loginError }}</div>
            </template>

            <!-- 已登录：账户信息 + 退出 -->
            <template v-else>
                <h3 class="settings-card__title">
                    <span class="title-emoji">🔑</span>
                    <span>服务端账号</span>
                </h3>
                <div class="account-bar">
                    <span class="account-bar__name">
                        当前账户：<span class="me">{{ accountName || "已登录" }}</span>
                    </span>
                    <button type="button" class="btn btn--link" @click="handleLogout">
                        退出登录
                    </button>
                </div>
            </template>
        </section>
    </template>
</template>
