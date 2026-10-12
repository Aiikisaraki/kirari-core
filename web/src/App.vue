<script setup>
import { ref, onMounted } from "vue";
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
let savedTimer = null;

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
        loadTheme();
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
}

/** 套用外观主题：在 <html> 上打 data-theme，配色由 style.css 里的四套变量接管。 */
function applyTheme(name) {
    if (name) document.documentElement.setAttribute("data-theme", name);
}

/** 主题 + 备注名都从 pet-client.config.json 读（桌宠版改了这边同步显示）。 */
async function loadTheme() {
    try {
        const r = await api.getTheme();
        if (r?.theme) applyTheme(r.theme);
    } catch {
        /* 读不到就用默认配色 */
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
    const saved = getToken();
    if (saved) tryToken(saved);
});
</script>

<template>
  <div class="shell">
    <!-- 口令门 -->
    <div v-if="!authed" class="gate">
      <div class="gate-card">
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

    <!-- 主界面：左导航 + 右内容（与桌宠版设置窗口同构） -->
    <template v-else>
      <div class="layout">
        <aside class="sidebar">
          <div class="side-brand">
            <span class="side-avatar">✦</span>
            <div class="side-brand-text">
              <strong>{{ petName }}</strong>
              <span>智能助手</span>
            </div>
          </div>
          <SettingsNav v-model:page="page" v-model:settings="settingsPage" />
          <div class="side-foot">
            <span class="dot" :class="brainReady ? 'ok' : 'bad'" />
            {{ brainReady ? "大脑已就绪" : "还没配大脑" }}
          </div>
        </aside>

        <main class="content">
          <ChatPane v-if="page === 'chat'" :pet-name="petName" />
          <template v-else>
            <AppearanceSettings
              v-if="settingsPage === 'appearance'"
              @saved="flashSaved('主题已切换')"
              @theme-change="applyTheme"
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
