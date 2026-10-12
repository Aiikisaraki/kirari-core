<script setup>
// 机器人设置：接入 OneBot（NapCat / LLOneBot），让助手能当 QQ 机器人用。
// 与桌宠版「机器人」页等价 —— 同一份 pet-client.config.json 的 adapters[]，连接状态实时显示。
//
// 两层安全闸门（默认全关，绝不无差别骚扰群聊）：
//   1. 群消息回复触发方式：off（不回群消息）/ mention（被 @ 才回）/ all（全回）
//   2. 群范围：whitelist（只回白名单群）/ blacklist（除了黑名单都回）
import { ref, onMounted } from "vue";
import { api } from "../../api.js";

const emit = defineEmits(["saved"]);

const adapters = ref([]);
const loading = ref(false);
const errorMsg = ref("");
const notice = ref("");
const editing = ref(null);

const REPLY_MODES = [
    { value: "off", label: "不回复群消息（最安全）" },
    { value: "mention", label: "被 @ 到才回复" },
    { value: "all", label: "回复群里所有消息（小心使用）" },
];
const FILTERS = [
    { value: "whitelist", label: "只回复白名单里的群" },
    { value: "blacklist", label: "除了黑名单，其余群都回复" },
];

async function load() {
    loading.value = true;
    errorMsg.value = "";
    try {
        const d = await api.listBot();
        adapters.value = d.items || [];
    } catch (e) {
        errorMsg.value = e.authFailed ? "口令不对，请重新进入" : e.message || "读取失败";
    } finally {
        loading.value = false;
    }
}

function defaultConfig() {
    return {
        wsUrl: "",
        token: "",
        groupReplyMode: "off",
        groupFilter: "whitelist",
        groupAllowlist: [],
        groupBlocklist: [],
    };
}

function startAdd() {
    editing.value = { id: "new", type: "onebot", name: "", enabled: true, config: defaultConfig() };
    notice.value = "";
}

function startEdit(a) {
    editing.value = JSON.parse(JSON.stringify({ ...a, config: { ...defaultConfig(), ...(a.config || {}) } }));
    notice.value = "";
}

function cancelEdit() {
    editing.value = null;
}

function parseGroupList(text) {
    return String(text || "")
        .split(/[,，\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
}

async function saveEdit() {
    if (!editing.value) return;
    const f = editing.value;
    if (!f.name.trim()) {
        errorMsg.value = "名字要填";
        return;
    }
    if (f.type === "onebot" && !f.config.wsUrl.trim()) {
        errorMsg.value = "OneBot 要填 WS 地址";
        return;
    }
    errorMsg.value = "";
    try {
        const payload = { name: f.name, type: f.type, enabled: f.enabled, config: f.config };
        if (f.id === "new") await api.addBot(payload);
        else await api.updateBot(f.id, payload);
        notice.value = "已保存，正在连接";
        await load();
        emit("saved");
        editing.value = null;
    } catch (e) {
        errorMsg.value = e.authFailed ? "口令不对，请重新进入" : e.message || "保存失败";
    }
}

async function toggle(a) {
    try {
        await api.updateBot(a.id, { enabled: !a.enabled });
        await load();
        emit("saved");
    } catch (e) {
        errorMsg.value = e.authFailed ? "口令不对，请重新进入" : e.message || "操作失败";
    }
}

async function remove(a) {
    if (!confirm(`删掉机器人「${a.name}」？连接配置会一起消失。`)) return;
    try {
        await api.deleteBot(a.id);
        notice.value = "已删除";
        await load();
    } catch (e) {
        errorMsg.value = e.authFailed ? "口令不对，请重新进入" : e.message || "删除失败";
    }
}

onMounted(load);
</script>

<template>
  <section class="card wide">
    <h2>机器人</h2>
    <p class="card-desc">
      接入 OneBot 协议的 QQ 机器人框架（NapCat / LLOneBot 等），助手就能在 QQ 里聊天。
      填上框架提供的 WS 地址即可，和桌宠版共用同一份配置。
    </p>

    <div v-if="loading && adapters.length === 0" class="dim">读取中…</div>
    <div v-else-if="adapters.length === 0 && !editing" class="dim">
      还没有接入机器人。点下面的「添加一个」开始。
    </div>

    <div v-for="a in adapters" :key="a.id" class="list-item">
      <div class="list-main">
        <div class="list-title">
          <label class="switch" :aria-label="`启用 ${a.name}`">
            <input type="checkbox" :checked="a.enabled !== false" @change="toggle(a)" />
            <span class="switch__slider"></span>
          </label>
          <strong>{{ a.name }}</strong>
          <span class="pill" :class="a.connected ? 'ok' : 'bad'">
            {{ a.connected ? "已连接" : "未连接" }}
          </span>
          <span v-if="a.selfQQ" class="pill dim">QQ {{ a.selfQQ }}</span>
        </div>
        <div class="list-desc dim">{{ a.config?.wsUrl || "（没填地址）" }}</div>
        <div v-if="a.lastError" class="list-desc error">{{ a.lastError }}</div>
      </div>
      <div class="list-ops">
        <button class="mini" @click="startEdit(a)">编辑</button>
        <button class="mini danger" @click="remove(a)">删除</button>
      </div>
    </div>

    <p v-if="notice" class="notice">{{ notice }}</p>
    <p v-if="errorMsg" class="error">{{ errorMsg }}</p>

    <div v-if="editing" class="edit-box">
      <h3>{{ editing.id === "new" ? "添加机器人" : "编辑机器人" }}</h3>

      <label class="field-label">名称</label>
      <input v-model="editing.name" maxlength="60" placeholder="如：NapCat 主号" />

      <label class="field-label">WS 地址</label>
      <input v-model="editing.config.wsUrl" placeholder="ws://127.0.0.1:3001" />

      <label class="field-label">访问令牌（可选）</label>
      <input v-model="editing.config.token" type="password" placeholder="对应 OneBot 的 access_token" />

      <div class="divider"></div>
      <h4>群消息怎么回复</h4>

      <label class="field-label">回复触发方式</label>
      <select v-model="editing.config.groupReplyMode">
        <option v-for="m in REPLY_MODES" :key="m.value" :value="m.value">{{ m.label }}</option>
      </select>

      <label class="field-label">群范围</label>
      <select v-model="editing.config.groupFilter">
        <option v-for="f in FILTERS" :key="f.value" :value="f.value">{{ f.label }}</option>
      </select>

      <template v-if="editing.config.groupFilter === 'whitelist'">
        <label class="field-label">允许回复的群号（逗号分隔）</label>
        <input
          :value="(editing.config.groupAllowlist || []).join(', ')"
          placeholder="123456789, 987654321"
          @input="editing.config.groupAllowlist = parseGroupList($event.target.value)"
        />
      </template>
      <template v-else>
        <label class="field-label">永不回复的群号（逗号分隔）</label>
        <input
          :value="(editing.config.groupBlocklist || []).join(', ')"
          placeholder="123456789, 987654321"
          @input="editing.config.groupBlocklist = parseGroupList($event.target.value)"
        />
      </template>

      <label class="checkbox-row">
        <input type="checkbox" v-model="editing.enabled" />
        <span>启用这个机器人</span>
      </label>

      <div class="edit-ops">
        <button class="primary" @click="saveEdit">保存</button>
        <button class="ghost" @click="cancelEdit">取消</button>
      </div>
    </div>

    <button v-else class="ghost add-btn" @click="startAdd">＋ 添加一个</button>
  </section>
</template>
