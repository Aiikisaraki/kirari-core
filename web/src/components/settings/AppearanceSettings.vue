<script setup>
// 控制台外观：明暗（浅色 / 深色 / 跟随系统）+ 配色（四选一）。
//
// 与桌宠版「外观」页**不互通**（用户拍板）：桌面小窗和网页后台是两种场景，
// 一套设置两头改只会互相干扰。这里读写的是核心版自己的
// data/console-appearance.json，跟 pet-client.config.json 的 theme 没关系。
import { ref, onMounted } from "vue";
import { api } from "../../api.js";

const emit = defineEmits(["saved", "appearance-change"]);

const themes = ref([]);
const modes = ref([]);
const current = ref(""); // 配色
const mode = ref("light"); // 明暗
const saving = ref(false);
const errorMsg = ref("");

onMounted(async () => {
    try {
        const r = await api.getAppearance();
        themes.value = r?.themes || [];
        modes.value = r?.modes || [];
        if (r?.theme) current.value = r.theme;
        if (r?.mode) mode.value = r.mode;
    } catch {
        /* 读不到就保持空，用户仍能手动点（点了会回默认外观） */
    }
});

/**
 * 改外观。乐观更新：先按新值把界面刷了，请求失败再整组回滚 ——
 * 配色/明暗是即时可见的偏好，点下去没反应比慢半拍难受得多。
 */
async function pick(patch) {
    if (saving.value) return;
    const prevTheme = current.value;
    const prevMode = mode.value;
    if (patch.theme !== undefined && patch.theme !== prevTheme) current.value = patch.theme;
    if (patch.mode !== undefined && patch.mode !== prevMode) mode.value = patch.mode;
    if (patch.theme === undefined && patch.mode === undefined) return;

    saving.value = true;
    errorMsg.value = "";
    emit("appearance-change", current.value, mode.value);
    try {
        const r = await api.saveAppearance(patch);
        if (r?.theme) current.value = r.theme;
        if (r?.mode) mode.value = r.mode;
        emit("appearance-change", current.value, mode.value);
        emit("saved");
    } catch (e) {
        current.value = prevTheme;
        mode.value = prevMode;
        emit("appearance-change", prevTheme, prevMode);
        errorMsg.value = e.message || "切换失败，请重试";
    } finally {
        saving.value = false;
    }
}
</script>

<template>
  <section class="card">
    <h2>明暗</h2>
    <p class="card-desc">控制台整体的深浅。选「跟随系统」就跟着电脑/手机的系统设置走，系统一变这边立刻变。</p>

    <div class="mode-row" role="radiogroup" aria-label="明暗模式">
      <button
        v-for="m in modes"
        :key="m.id"
        type="button"
        class="mode-card"
        :class="{ 'is-active': m.id === mode }"
        :disabled="saving"
        role="radio"
        :aria-checked="m.id === mode"
        @click="pick({ mode: m.id })"
      >
        <svg class="mode-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <template v-if="m.id === 'light'">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" />
          </template>
          <template v-else-if="m.id === 'dark'">
            <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
          </template>
          <template v-else>
            <path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5A6.6 6.6 0 0 1 12 3.5Z" />
            <circle cx="12" cy="12" r="8.5" />
          </template>
        </svg>
        <span class="mode-card__text">
          <span class="mode-card__label">{{ m.label }}</span>
          <span class="mode-card__sub">{{ m.sub }}</span>
        </span>
        <span v-if="m.id === mode" class="mode-card__check">✓</span>
      </button>
    </div>

    <div class="divider" />

    <h2>配色</h2>
    <p class="card-desc">主色调。只改按钮、选中态和高亮的色相，排版和间距都不动。</p>

    <div class="theme-grid">
      <button
        v-for="t in themes"
        :key="t.id"
        type="button"
        class="theme-card"
        :class="{ 'is-active': t.id === current }"
        :disabled="saving"
        @click="pick({ theme: t.id })"
      >
        <span class="theme-swatch" :class="'swatch-' + t.id" />
        <span class="theme-card__text">
          <span class="theme-card__label">{{ t.label }}</span>
          <span class="theme-card__sub">{{ t.sub }}</span>
        </span>
        <span v-if="t.id === current" class="theme-card__check">✓</span>
      </button>
    </div>

    <p class="footnote">
      这里只管控制台（这个网页）的显示效果，跟桌宠版的主题是两套，互不影响。
    </p>

    <p v-if="errorMsg" class="error">{{ errorMsg }}</p>
  </section>
</template>

<style scoped>
.mode-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 12px;
    margin-top: 10px;
}
.mode-card {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 13px 14px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--card);
    cursor: pointer;
    text-align: left;
    color: var(--text);
    transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
}
.mode-card:hover {
    border-color: var(--line-strong);
}
.mode-card.is-active {
    border-color: var(--brand);
    box-shadow: 0 0 0 2px var(--brand-ring);
    background: var(--brand-weak);
}
.mode-icon {
    width: 20px;
    height: 20px;
    flex: none;
    color: var(--brand);
}
.mode-card__text,
.theme-card__text {
    display: flex;
    flex-direction: column;
    line-height: 1.25;
    min-width: 0;
}
.mode-card__label,
.theme-card__label {
    font-size: 13px;
    font-weight: 500;
}
.mode-card__sub,
.theme-card__sub {
    font-size: 11px;
    color: var(--dim);
}
.mode-card__check,
.theme-card__check {
    margin-left: auto;
    color: var(--brand);
    font-weight: 700;
}

.theme-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 12px;
    margin-top: 10px;
}
.theme-card {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--card);
    cursor: pointer;
    text-align: left;
    color: var(--text);
    transition: border-color 0.15s, box-shadow 0.15s;
}
.theme-card:hover {
    border-color: var(--brand);
}
.theme-card.is-active {
    border-color: var(--brand);
    box-shadow: 0 0 0 2px var(--brand-ring);
}
.theme-swatch {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    flex: none;
    border: 1px solid var(--line);
}
.swatch-aurora-glass {
    background: linear-gradient(135deg, #38bdf8 0%, #0ea5e9 55%, #6366f1 100%);
}
.swatch-pet-pink {
    background: linear-gradient(135deg, #fbc4d2 0%, #f29bae 55%, #f0a586 100%);
}
.swatch-mint-soft {
    background: linear-gradient(135deg, #a3d9c8 0%, #5fc4a8 55%, #88c9a4 100%);
}
.swatch-lavender-mist {
    background: linear-gradient(135deg, #d8c4ed 0%, #b196e0 55%, #c4a8d8 100%);
}
.footnote {
    margin-top: 18px;
}
</style>
