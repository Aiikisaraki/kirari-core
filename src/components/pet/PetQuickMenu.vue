<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useThemeStore } from "../../stores/theme";

// 悬浮菜单的常用动作（桌宠高频操作）。图标优先于文字，鼠标悬停图标仍有 tooltip 提示。
type MenuItem = {
  key: string;
  label: string;
  icon: keyof typeof ICONS;
  run: () => void;
};

// 内联 SVG 图标（24x24，currentColor 描边，随主题变色），避免引入图标库依赖。
const ICONS = {
  chat: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 9 9 0 0 1-3.9-.9L3 21l1.9-5.6A8.38 8.38 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z"/></svg>`,
  settings: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  theme: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r="1.5"/><circle cx="17.5" cy="10.5" r="1.5"/><circle cx="8.5" cy="7.5" r="1.5"/><circle cx="6.5" cy="12.5" r="1.5"/><path d="M12 2a10 10 0 0 0 0 20 2.5 2.5 0 0 0 2.5-2.5c0-.7-.3-1.3-.7-1.8-.4-.5-.7-1-.7-1.7A2.5 2.5 0 0 1 15.5 13H18a4 4 0 0 0 4-4 10 10 0 0 0-10-7z"/></svg>`,
  reset: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><circle cx="12" cy="12" r="2"/></svg>`,
  hide: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.9 4.2A9.1 9.1 0 0 1 12 4c7 0 10 8 10 8a13.2 13.2 0 0 1-2.16 3.19M6.6 6.6A13.3 13.3 0 0 0 2 12s3 8 10 8a9.1 9.1 0 0 0 4.1-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><line x1="2" y1="2" x2="22" y2="22"/></svg>`,
  sparkle: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.6 5.4L19 9l-5.4 1.6L12 16l-1.6-5.4L5 9l5.4-1.6z"/><path d="M19 14l.8 2.6L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.4z" opacity=".75"/></svg>`,
};

const props = defineProps<{ hover: boolean }>();
const emit = defineEmits<{
  openChat: [];
  openSettings: [];
  hidePet: [];
  resetPosition: [];
}>();

const theme = useThemeStore();
const open = ref(false);
const visible = computed(() => props.hover || open.value);

function toggleTheme() {
  const next = theme.current === "aurora-glass" ? "pet-pink" : "aurora-glass";
  void theme.setTheme(next);
}

const items = computed<MenuItem[]>(() => [
  { key: "chat", label: "打开对话框", icon: "chat", run: () => emit("openChat") },
  { key: "settings", label: "打开设置", icon: "settings", run: () => emit("openSettings") },
  { key: "theme", label: "切换主题", icon: "theme", run: toggleTheme },
  { key: "reset", label: "重置位置", icon: "reset", run: () => emit("resetPosition") },
  { key: "hide", label: "隐藏桌宠", icon: "hide", run: () => emit("hidePet") },
]);

function toggle() {
  open.value = !open.value;
}
function runItem(it: MenuItem) {
  it.run();
  open.value = false;
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") open.value = false;
}
onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div class="pet-quick" :class="{ 'is-visible': visible, 'is-open': open }">
    <!-- 展开的图标菜单：相对桌宠主体水平居中、位于小球正左侧、向左弹出 -->
    <div class="quick-menu" :inert="!open" role="menu" aria-label="桌宠快捷操作">
      <button
        v-for="(it, i) in items"
        :key="it.key"
        type="button"
        class="quick-item"
        role="menuitem"
        :title="it.label"
        :aria-label="it.label"
        :style="{ '--i': i }"
        @click="runItem(it)"
      >
        <span class="ico" v-html="ICONS[it.icon]"></span>
      </button>
    </div>

    <!-- 折叠小球（FAB）：hover pet 时显示，点击展开菜单 -->
    <button
      type="button"
      class="quick-fab"
      :aria-expanded="open"
      aria-label="桌宠快捷菜单"
      :title="open ? '收起菜单' : '打开菜单'"
      @click="toggle"
    >
      <span class="fab-ico" v-html="ICONS.sparkle"></span>
    </button>
  </div>
</template>

<style scoped>
/* 悬浮菜单容器：铺满整个 pet-stage，使菜单能以“桌宠主体”为基准水平居中；
   同时保持 pointer-events:none，让拖拽等事件穿透到宠物本体（仅 FAB / 菜单项可点击）。 */
.pet-quick {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 5;
}

/* 折叠小球：与菜单等高(40px)，位于菜单右侧外侧(不重叠)；默认隐藏，hover / 菜单打开时显现 */
.quick-fab {
  position: absolute;
  right: 36px;
  bottom: 8px;
  box-sizing: border-box;
  width: 40px;
  height: 40px;
  transform: translateY(6px) scale(0.8);
  display: grid;
  place-items: center;
  border: 1px solid var(--pet-border);
  border-radius: 50%;
  background: var(--pet-surface-strong);
  color: var(--pet-accent);
  box-shadow: var(--pet-shadow);
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  transition:
    opacity 0.18s ease,
    transform 0.18s ease,
    background 0.15s ease,
    color 0.15s ease;
}
.pet-quick.is-visible .quick-fab {
  opacity: 1;
  transform: translateY(0) scale(1);
  pointer-events: auto;
}
.quick-fab:hover,
.pet-quick.is-open .quick-fab {
  background: var(--pet-accent);
  color: #fff;
}
.quick-fab:focus-visible {
  outline: 3px solid var(--pet-focus-ring);
  outline-offset: 3px;
}
.fab-ico {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  transition: transform 0.25s ease;
}
.fab-ico :deep(svg) {
  width: 18px;
  height: 18px;
}
.pet-quick.is-open .fab-ico {
  transform: rotate(90deg);
}

/* 展开菜单：玻璃质感胶囊，高 40px（与 FAB 等高）。整体以“桌宠主体”水平居中（left:50% 相对铺满的容器），
   底边与 FAB 同高(底对齐) → 垂直中心自动对齐、位于小球正左侧同一水平线；
   transform-origin:right center，从小球一侧向左展开，逐项自右向左错峰显隐。 */
.quick-menu {
  position: absolute;
  left: 50%;
  bottom: 8px;
  box-sizing: border-box;
  height: 40px;
  transform: translateX(-50%) translateX(10px) scale(0.92);
  transform-origin: right center;
  display: flex;
  flex-direction: row;
  gap: 4px;
  padding: 5px;
  border: 1px solid var(--pet-border);
  border-radius: 18px;
  background: var(--pet-surface-strong);
  box-shadow: var(--pet-shadow);
  backdrop-filter: blur(18px) saturate(150%);
  -webkit-backdrop-filter: blur(18px) saturate(150%);
  opacity: 0;
  pointer-events: none;
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}
.pet-quick.is-open .quick-menu {
  opacity: 1;
  transform: translateX(-50%) scale(1);
  pointer-events: auto;
}

.quick-item {
  box-sizing: border-box;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border: 1px solid transparent;
  border-radius: 50%;
  background: transparent;
  color: var(--pet-ink);
  cursor: pointer;
  opacity: 0;
  transform: translateX(8px);
  transition:
    background 0.15s ease,
    color 0.15s ease,
    transform 0.15s ease,
    opacity 0.15s ease;
}
.pet-quick.is-open .quick-item {
  opacity: 1;
  transform: translateX(0);
  /* 自右向左错峰入场：贴近小球的项先出现，营造“向左展开”的方向感 */
  transition-delay: calc((4 - var(--i)) * 28ms);
}
.quick-item:hover {
  background: var(--pet-accent-soft);
  color: var(--pet-accent);
  transform: translateX(-1px);
}
.quick-item:focus-visible {
  outline: 3px solid var(--pet-focus-ring);
  outline-offset: 2px;
}
.ico {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
}
.ico :deep(svg) {
  width: 18px;
  height: 18px;
}
</style>
