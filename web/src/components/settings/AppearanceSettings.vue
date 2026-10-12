<script setup>
// 外观主题：和桌宠版「外观」页同一套四选一，读写同一个 theme 字段。
// 注意与「形象」区分：形象是桌宠角色皮肤（核心版没有桌宠，不做），
// 主题只是配色，控制台照样能套同一套。
import { ref, onMounted } from "vue";
import { api } from "../../api.js";

const emit = defineEmits(["saved", "theme-change"]);

const themes = ref([]);
const current = ref("");
const saving = ref(false);
const errorMsg = ref("");

onMounted(async () => {
    try {
        const r = await api.getTheme();
        themes.value = r?.themes || [];
        current.value = r?.theme || "";
    } catch {
        /* 读不到就保持空，用户仍能手动点（点了会回默认主题） */
    }
});

async function pick(id) {
    if (saving.value || id === current.value) return;
    saving.value = true;
    errorMsg.value = "";
    try {
        const r = await api.saveTheme(id);
        current.value = r?.theme || id;
        emit("theme-change", current.value);
        emit("saved");
    } catch (e) {
        errorMsg.value = e.message || "切换失败，请重试";
    } finally {
        saving.value = false;
    }
}
</script>

<template>
  <section class="card">
    <h2>外观主题</h2>
    <p class="card-desc">控制台的配色风格，和桌宠版共用同一份设置，切换即时生效。</p>

    <div class="theme-grid">
      <button
        v-for="t in themes"
        :key="t.id"
        type="button"
        class="theme-card"
        :class="{ 'is-active': t.id === current }"
        :disabled="saving"
        @click="pick(t.id)"
      >
        <span class="theme-swatch" :class="'swatch-' + t.id" />
        <span class="theme-card__text">
          <span class="theme-card__label">{{ t.label }}</span>
          <span class="theme-card__sub">{{ t.sub }}</span>
        </span>
        <span v-if="t.id === current" class="theme-card__check">✓</span>
      </button>
    </div>

    <p v-if="errorMsg" class="error">{{ errorMsg }}</p>
  </section>
</template>

<style scoped>
.theme-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 12px;
    margin-top: 8px;
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
}
.theme-card:hover {
    border-color: var(--brand);
}
.theme-card.is-active {
    border-color: var(--brand);
    box-shadow: 0 0 0 2px rgba(91, 108, 255, 0.16);
}
.theme-swatch {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    flex: none;
    border: 1px solid var(--line);
}
.swatch-aurora-glass {
    background: linear-gradient(135deg, #7eb1f5 0%, #5b8def 55%, #8c7ed8 100%);
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
.theme-card__text {
    display: flex;
    flex-direction: column;
    line-height: 1.25;
    min-width: 0;
}
.theme-card__label {
    font-size: 13px;
    font-weight: 500;
}
.theme-card__sub {
    font-size: 11px;
    color: var(--dim);
}
.theme-card__check {
    margin-left: auto;
    color: var(--brand);
    font-weight: 700;
}
</style>
