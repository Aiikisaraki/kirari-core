<script setup>
// 左侧导航：聊天 + 10 个设置页。
// 与桌宠版设置窗口同一套分组思路（外观/通用/个人在前，能力配置在中，机器人在后）。
// 唯一不做的是「形象」——那是桌宠角色皮肤，核心版没有桌宠可换。
//
// 图标统一为内联线性 SVG（stroke: currentColor），随主题变色；
// 不用 emoji：跨平台字形不一致，且和 SnowLuma 式细线风格不搭。
const props = defineProps({
    page: { type: String, default: "chat" },
    settings: { type: String, default: "general" },
});
const emit = defineEmits(["update:page", "update:settings"]);

const items = [
    { key: "appearance", label: "外观", desc: "配色主题", icon: "sparkles" },
    { key: "general", label: "通用", desc: "备注名", icon: "sliders" },
    { key: "profile", label: "个人", desc: "我的头像", icon: "user" },
    { key: "persona", label: "人格", desc: "基础人格", icon: "heart" },
    { key: "model", label: "大脑", desc: "多套模型", icon: "cpu" },
    { key: "skill", label: "技能", desc: "行为模板", icon: "wand" },
    { key: "knowledge", label: "知识库", desc: "私人知识", icon: "book" },
    { key: "mcp", label: "工具服务", desc: "MCP", icon: "plug" },
    { key: "bot", label: "机器人", desc: "QQ 接入", icon: "bot" },
    { key: "sync", label: "组网", desc: "多机同步", icon: "sync" },
];

function goChat() {
    emit("update:page", "chat");
}
function goSettings(key) {
    emit("update:page", "settings");
    emit("update:settings", key);
}
</script>

<template>
  <nav class="nav">
    <button class="nav-item nav-chat" :class="{ active: page === 'chat' }" @click="goChat">
      <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
      </svg>
      <span class="nav-label">聊天</span>
    </button>
    <div class="nav-group-title">设置</div>
    <button
      v-for="it in items"
      :key="it.key"
      class="nav-item"
      :class="{ active: page === 'settings' && settings === it.key }"
      @click="goSettings(it.key)"
    >
      <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <template v-if="it.icon === 'sparkles'">
          <path d="M12 3.5 13.8 8.2 18.5 10 13.8 11.8 12 16.5 10.2 11.8 5.5 10 10.2 8.2 12 3.5Z" />
          <path d="M18.5 15.5 19.3 17.7 21.5 18.5 19.3 19.3 18.5 21.5 17.7 19.3 15.5 18.5 17.7 17.7 18.5 15.5Z" />
        </template>
        <template v-else-if="it.icon === 'sliders'">
          <path d="M4 7h16M4 12h16M4 17h16" />
          <circle cx="9.5" cy="7" r="1.9" />
          <circle cx="15" cy="12" r="1.9" />
          <circle cx="7.5" cy="17" r="1.9" />
        </template>
        <template v-else-if="it.icon === 'user'">
          <circle cx="12" cy="8" r="3.6" />
          <path d="M5 20c1.2-3.2 3.9-4.8 7-4.8s5.8 1.6 7 4.8" />
        </template>
        <path v-else-if="it.icon === 'heart'" d="M12 20.3C6.4 16.9 3.5 13.7 3.5 10.2 3.5 7.6 5.5 5.7 8 5.7c1.6 0 3.1.8 4 2.1.9-1.3 2.4-2.1 4-2.1 2.5 0 4.5 1.9 4.5 4.5 0 3.5-2.9 6.7-8.5 10.1Z" />
        <template v-else-if="it.icon === 'cpu'">
          <rect x="7" y="7" width="10" height="10" rx="2" />
          <rect x="10.6" y="10.6" width="2.8" height="2.8" />
          <path d="M9 3.5v3M15 3.5v3M9 17.5v3M15 17.5v3M3.5 9h3M3.5 15h3M17.5 9h3M17.5 15h3" />
        </template>
        <template v-else-if="it.icon === 'wand'">
          <path d="M3 21 13 11" />
          <path d="M14.5 4 15.4 6.1 17.5 7 15.4 7.9 14.5 10 13.6 7.9 11.5 7 13.6 6.1 14.5 4Z" />
          <path d="M19 12.5 19.6 14 21 14.6 19.6 15.2 19 16.7 18.4 15.2 17 14.6 18.4 14 19 12.5Z" />
        </template>
        <path v-else-if="it.icon === 'book'" d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
        <template v-else-if="it.icon === 'plug'">
          <path d="M9 7V3M15 7V3" />
          <path d="M7 7h10v4a5 5 0 0 1-10 0V7Z" />
          <path d="M12 16v5" />
        </template>
        <template v-else-if="it.icon === 'bot'">
          <rect x="5" y="8.5" width="14" height="10.5" rx="3" />
          <path d="M12 8.5V5.5" />
          <circle cx="12" cy="4" r="1.3" />
          <path d="M9.5 13v1.6M14.5 13v1.6" />
        </template>
        <template v-else-if="it.icon === 'sync'">
          <path d="M20 7H7m0 0 3-3M7 7l3 3" />
          <path d="M4 17h13m0 0-3-3m3 3-3 3" />
        </template>
      </svg>
      <span class="nav-body">
        <span class="nav-label">{{ it.label }}</span>
        <span class="nav-desc">{{ it.desc }}</span>
      </span>
    </button>
  </nav>
</template>

<style scoped>
.nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 10px;
    overflow-y: auto;
}
.nav-group-title {
    font-size: 11px;
    color: var(--dim);
    padding: 14px 10px 5px;
    letter-spacing: 0.08em;
}
.nav-item {
    display: flex;
    align-items: center;
    gap: 10px;
    border: none;
    background: none;
    padding: 8px 10px;
    border-radius: 10px;
    cursor: pointer;
    text-align: left;
    color: var(--text);
    font-size: 13.5px;
    font-family: inherit;
    transition: background 0.15s, color 0.15s;
}
.nav-item:hover {
    background: var(--bg-soft);
}
/* SnowLuma 式选中态：浅色药丸 + 主色文字，不再是实心色块 */
.nav-item.active {
    background: var(--brand-weak);
    color: var(--brand);
}
.nav-item.active .nav-desc {
    color: var(--brand);
    opacity: 0.72;
}
.nav-icon {
    width: 18px;
    height: 18px;
    flex: none;
}
.nav-body {
    display: flex;
    flex-direction: column;
    line-height: 1.3;
    min-width: 0;
}
.nav-label {
    font-weight: 520;
}
.nav-desc {
    font-size: 11px;
    color: var(--dim);
}
.nav-chat {
    margin-bottom: 2px;
}
</style>
