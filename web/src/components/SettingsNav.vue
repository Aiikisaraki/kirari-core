<script setup>
// 左侧导航：聊天 + 10 个设置页。
// 与桌宠版设置窗口同一套分组思路（外观/通用/个人在前，能力配置在中，机器人在后）。
// 唯一不做的是「形象」——那是桌宠角色皮肤，核心版没有桌宠可换。
const props = defineProps({
    page: { type: String, default: "chat" },
    settings: { type: String, default: "general" },
});
const emit = defineEmits(["update:page", "update:settings"]);

const items = [
    { key: "appearance", icon: "✦", label: "外观", desc: "配色主题" },
    { key: "general", icon: "⚙", label: "通用", desc: "备注名" },
    { key: "profile", icon: "☺", label: "个人", desc: "我的头像" },
    { key: "persona", icon: "♪", label: "人格", desc: "基础人格" },
    { key: "model", icon: "✿", label: "大脑", desc: "多套模型" },
    { key: "skill", icon: "✧", label: "技能", desc: "行为模板" },
    { key: "knowledge", icon: "❋", label: "知识库", desc: "私人知识" },
    { key: "mcp", icon: "⌘", label: "工具服务", desc: "MCP" },
    { key: "bot", icon: "✉", label: "机器人", desc: "QQ 接入" },
    { key: "sync", icon: "⇄", label: "组网", desc: "多机同步" },
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
      <span class="nav-icon">💬</span>
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
      <span class="nav-icon">{{ it.icon }}</span>
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
    padding: 8px;
    overflow-y: auto;
}
.nav-group-title {
    font-size: 11px;
    color: var(--dim);
    padding: 12px 10px 4px;
    letter-spacing: 0.05em;
}
.nav-item {
    display: flex;
    align-items: center;
    gap: 10px;
    border: none;
    background: none;
    padding: 8px 10px;
    border-radius: 9px;
    cursor: pointer;
    text-align: left;
    color: var(--text);
    font-size: 13px;
}
.nav-item:hover {
    background: rgba(120, 130, 255, 0.08);
}
.nav-item.active {
    background: var(--brand);
    color: #fff;
}
.nav-item.active .nav-desc {
    color: rgba(255, 255, 255, 0.75);
}
.nav-icon {
    width: 20px;
    text-align: center;
    font-size: 14px;
    flex: none;
}
.nav-body {
    display: flex;
    flex-direction: column;
    line-height: 1.25;
    min-width: 0;
}
.nav-label {
    font-weight: 500;
}
.nav-desc {
    font-size: 11px;
    color: var(--dim);
}
.nav-chat {
    margin-bottom: 2px;
}
</style>
