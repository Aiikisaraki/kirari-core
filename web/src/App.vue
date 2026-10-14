<script setup>
import { ref, computed, watch, onMounted } from "vue";
import { api, getToken, setToken, clearToken } from "./api.js";
import ChatPane from "./components/ChatPane.vue";
import SettingsNav from "./components/SettingsNav.vue";
import AppearanceSettings from "./components/settings/AppearanceSettings.vue";
import GeneralSettings from "./components/settings/GeneralSettings.vue";
import ProfileSettings from "./components/settings/ProfileSettings.vue";
import PersonaSettings from "./components/settings/PersonaSettings.vue";
import ModelSettings from "./components/settings/ModelSettings.vue";
import SkillSettings from "./components/settings/SkillSettings.vue";
import KnowledgeSettings from "./components/settings/KnowledgeSettings.vue";
import McpSettings from "./components/settings/McpSettings.vue";
import BotSettings from "./components/settings/BotSettings.vue";
import SyncSettings from "./components/settings/SyncSettings.vue";

// 外观缓存的 localStorage 键（防刷新闪白用，真正的配置以服务端那份为准）
const APPEARANCE_CACHE = "kirari-console-appearance";

// 未验证口令前先门口令；验证通过才进主界面
const authed = ref(false);
const checking = ref(false);
const tokenInput = ref("");
const authError = ref("");
const page = ref("chat"); // chat | settings
const settingsPage = ref("general"); // 设置子页（见 SettingsNav）
const brainReady = ref(null);
const netInfo = ref(null);
const petName = ref("Kirari");
const savedOk = ref("");
const navOpen = ref(false); // 移动端抽屉开关
// 控制台外观：{ theme 配色, mode 明暗 }。mode 存的是用户选的意图，
// auto 会在 applyAppearance 里按系统偏好算成 light/dark 再显示。
// 初值取上次缓存 —— 深色用户刷新时不会先闪一帧白（服务端那份要等鉴权后才拿得到）。
const isDark = ref(false); // 当前实际是不是深色（跟随系统算出来的结果）
const appearance = ref((() => {
    try {
        const c = JSON.parse(localStorage.getItem(APPEARANCE_CACHE) || "null");
        if (c && typeof c.theme === "string") {
            return { theme: c.theme, mode: ["light", "dark", "auto"].includes(c.mode) ? c.mode : "light" };
        }
    } catch {
        /* 缓存坏了就走默认 */
    }
    return { theme: "aurora-glass", mode: "light" };
})());
let savedTimer = null;

// 面包屑：聊天 / 设置 · <子页>。这份 key→文案 和 SettingsNav 的 items 保持一致，
// 拆成共享模块反而要为一个标题加一层依赖，不值得（改文案时两处一起搜「label」即可）。
const SETTINGS_LABELS = {
    appearance: "外观",
    general: "通用",
    profile: "个人",
    persona: "人格",
    model: "大脑",
    skill: "技能",
    knowledge: "知识库",
    mcp: "工具服务",
    bot: "机器人",
    sync: "组网",
};
const crumbMain = computed(() => (page.value === "chat" ? "聊天" : "设置"));
const crumbSub = computed(() =>
    page.value === "settings" ? SETTINGS_LABELS[settingsPage.value] || "" : ""
);

// 移动端：切页即收起抽屉（点导航本来就为去别的页面）
watch([page, settingsPage], () => {
    navOpen.value = false;
});

async function tryToken(t) {
    // 口令两端空白先去掉：服务端 requireAdmin 也会 trim，这里对齐，
    // 免得用户复制粘贴带了空格却被判「口令不对」。
    const token = String(t || "").trim();
    if (!token) {
        authError.value = "请输入管理口令";
        return;
    }
    checking.value = true;
    authError.value = "";
    // 必须先把本次输入的口令写进去再发请求。
    // 原因：api.js 的 request() 统一从 localStorage 取 X-Admin-Token，
    // 之前是「先请求、成功后才 setToken」——首次登录时localStorage 还是空的，
    // 请求必然带空口令 → 401 → setToken 执行不到 → 之后永远进不去（死循环）。
    setToken(token);
    try {
        const s = await api.status();
        authed.value = true;
        brainReady.value = s.brainReady;
        netInfo.value = s.net;
        loadAppearance();
        loadPetName();
    } catch (e) {
        if (e.authFailed) {
            // 口令不对：把刚才存进去的错口令清掉，别让下次自动重试用它当默认
            clearToken();
            authError.value = "口令不对，再试一次";
        } else {
            // 连不上服务这类问题跟口令无关，保留口令方便直接重试
            authError.value = e.message || "连不上服务";
        }
    } finally {
        checking.value = false;
    }
}

function logout() {
    clearToken();
    authed.value = false;
    tokenInput.value = "";
    navOpen.value = false;
}

function systemPrefersDark() {
    return typeof window !== "undefined" && window.matchMedia
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
        : false;
}

/**
 * 把外观打到 <html> 上，配色和明暗由 style.css 接管。
 *   data-theme  配色（极光玻璃 / 樱粉 / 薄荷嫩芽 / 薰衣草晨雾）
 *   data-mode   明暗（light / dark）。mode=auto 时按系统偏好现算 ——
 *               存的是用户选的「意图」，显示的是算出来的结果。
 */
function applyToDom(theme, mode) {
    if (theme) document.documentElement.setAttribute("data-theme", theme);
    const pref = mode || "light";
    const effective = pref === "auto" ? (systemPrefersDark() ? "dark" : "light") : pref;
    document.documentElement.setAttribute("data-mode", effective);
    isDark.value = effective === "dark";
}

/** 顶栏一键切换深浅：从「跟随系统」切走时，落定成当前的反面（auto → 手动）。 */
async function toggleDark() {
    const next = isDark.value ? "light" : "dark";
    applyAppearance(null, next);
    try {
        await api.saveAppearance({ mode: next });
    } catch {
        /* 存不下也先让界面变了，下次进来会回到上次存的值 */
    }
}

/** 记录当前外观（写缓存是为了下次进页面先按它上色，不等服务端返回）。 */
function applyAppearance(theme, mode) {
    if (theme) appearance.value = { ...appearance.value, theme };
    if (mode) appearance.value = { ...appearance.value, mode };
    applyToDom(appearance.value.theme, appearance.value.mode);
    try {
        localStorage.setItem(APPEARANCE_CACHE, JSON.stringify(appearance.value));
    } catch {
        /* 隐私模式下写不了就算了，只是少一层防闪 */
    }
}

let darkQuery = null;
function onSystemSchemeChange() {
    // 只有「跟随系统」才需要实时跟着变；手动选了浅/深的别去覆盖
    if (appearance.value.mode === "auto") applyAppearance(null, null);
}

/**
 * 控制台外观读的是核心版自己的 data/console-appearance.json —— 与桌宠版不互通。
 * 备注名那边仍然共享（见 loadPetName）。
 */
async function loadAppearance() {
    try {
        const r = await api.getAppearance();
        if (r?.theme || r?.mode) {
            applyAppearance(r.theme || "aurora-glass", r.mode || "light");
        }
    } catch {
        /* 读不到就用默认配色 */
    }
    // 跟随系统：注册一次监听，之后系统切深色这边立刻跟上（不刷新页面）
    if (window.matchMedia && !darkQuery) {
        darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
        darkQuery.addEventListener?.("change", onSystemSchemeChange);
    }
}

/** 备注名从 pet-client.config.json 读（桌宠版改了这边同步显示）。 */
async function loadPetName() {
    try {
        const r = await api.getPetName();
        if (r?.petName) petName.value = r.petName;
    } catch {
        /* 读不到就用默认名，不挡住进界面 */
    }
}

/** 保存成功的一闪提示（各设置页 @saved 触发）。 */
function flashSaved(msg) {
    savedOk.value = msg || "已保存";
    if (savedTimer) clearTimeout(savedTimer);
    savedTimer = setTimeout(() => (savedOk.value = ""), 2000);
}

onMounted(() => {
    // 先把缓存的外观打上再谈别的：口令门那一步还没鉴权，服务端那份拿不到，
    // 深色用户不该为此先挨一帧白屏。
    applyToDom(appearance.value.theme, appearance.value.mode);
    const saved = getToken();
    if (saved) tryToken(saved);
});
</script>

<template>
  <div class="shell">
    <!-- 口令门 -->
    <div v-if="!authed" class="gate">
      <div class="gate-card">
        <span class="gate-mark">✦</span>
        <h1>kirari 控制台</h1>
        <p class="hint">输入服务端 .env 里设置的管理口令</p>
        <input
          v-model="tokenInput"
          type="password"
          placeholder="管理口令"
          @keyup.enter="tryToken(tokenInput)"
        />
        <button :disabled="checking || !tokenInput" @click="tryToken(tokenInput)">
          {{ checking ? "验证中…" : "进入" }}
        </button>
        <p v-if="authError" class="error">{{ authError }}</p>
      </div>
    </div>

    <!-- 主界面：顶栏 +（侧栏 + 内容），SnowLuma 式骨架 -->
    <template v-else>
      <header class="topbar">
        <button
          class="tb-burger"
          :aria-expanded="navOpen"
          aria-label="打开导航菜单"
          @click="navOpen = !navOpen"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <div class="crumb">
          <strong>{{ crumbMain }}</strong>
          <span v-if="crumbSub" class="crumb-sub">· {{ crumbSub }}</span>
        </div>
        <div class="tb-right">
          <span class="pill" :class="brainReady ? 'ok' : 'bad'">
            <span class="dot" :class="brainReady ? 'ok' : 'bad'" />
            {{ brainReady ? "大脑已就绪" : "还没配大脑" }}
          </span>
          <button
            class="tb-icon"
            :title="isDark ? '切换成浅色' : '切换成深色'"
            :aria-label="isDark ? '切换成浅色' : '切换成深色'"
            @click="toggleDark"
          >
            <svg v-if="isDark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" />
            </svg>
            <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
            </svg>
          </button>
          <button class="tb-icon" title="退出登录" aria-label="退出登录" @click="logout">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M15 4h3.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H15" />
              <path d="M10 8l-4 4 4 4M6 12h10" />
            </svg>
          </button>
        </div>
      </header>

      <div class="layout" :class="{ 'nav-open': navOpen }">
        <div class="scrim" @click="navOpen = false" />
        <aside class="sidebar">
          <div class="side-brand">
            <span class="side-avatar">✦</span>
            <div class="side-brand-text">
              <strong>{{ petName }}</strong>
              <span>智能助手</span>
            </div>
          </div>
          <SettingsNav v-model:page="page" v-model:settings="settingsPage" />
          <div class="side-foot">聊天记录与桌宠版互通</div>
        </aside>

        <main class="content">
          <ChatPane v-if="page === 'chat'" :pet-name="petName" />
          <template v-else>
            <AppearanceSettings
              v-if="settingsPage === 'appearance'"
              @saved="flashSaved('外观已切换')"
              @appearance-change="applyAppearance"
            />
            <GeneralSettings
              v-if="settingsPage === 'general'"
              v-model="petName"
              @saved="flashSaved('备注名已保存')"
            />
            <ProfileSettings v-else-if="settingsPage === 'profile'" @saved="flashSaved('头像已保存')" />
            <PersonaSettings v-else-if="settingsPage === 'persona'" @saved="flashSaved('人格已保存')" />
            <ModelSettings
              v-else-if="settingsPage === 'model'"
              :brain-ready="brainReady"
              @saved="flashSaved('大脑配置已保存')"
            />
            <SkillSettings v-else-if="settingsPage === 'skill'" @saved="flashSaved('技能已保存')" />
            <KnowledgeSettings v-else-if="settingsPage === 'knowledge'" @saved="flashSaved('知识库已保存')" />
            <McpSettings v-else-if="settingsPage === 'mcp'" @saved="flashSaved('工具服务已保存')" />
            <BotSettings v-else-if="settingsPage === 'bot'" @saved="flashSaved('机器人已保存')" />
            <SyncSettings
              v-else-if="settingsPage === 'sync'"
              :net-info="netInfo"
              @saved="flashSaved('组网配置已保存')"
            />
          </template>

          <div class="saved-toast" v-if="savedOk">{{ savedOk }}</div>
        </main>
      </div>
    </template>
  </div>
</template>
