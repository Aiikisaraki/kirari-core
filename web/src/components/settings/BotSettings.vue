<script setup>
// 机器人设置：默认接入 QQ 官方机器人（官方 WebSocket 反向连接）；OneBot 作为通用协议端保留。
// 与桌宠版「机器人」页等价 —— 同一份 pet-client.config.json 的 adapters[]，连接状态实时显示。
//
// 两层安全闸门（默认全关，绝不无差别骚扰群聊）：
//   1. 群消息回复触发方式：off（不回群消息）/ mention（被 @ 才回）/ all（全回）
//   2. 群范围：whitelist（只回白名单群）/ blacklist（除了黑名单都回）
//
// 主人绑定（与桌宠版同一功能）：把某个 QQ 号设为「主人」后，该账号发来的消息
// 会并进主对话（和控制台、桌宠版共用同一段聊天记录），不再是独立的机器人会话。
import { ref, onMounted, onUnmounted } from "vue";
import { api } from "../../api.js";

const emit = defineEmits(["saved"]);
// 叶子节点只读：协议端跟随主机（主机才是 QQ 连接出口），本机改了不生效
const props = defineProps({ readonly: { type: Boolean, default: false } });

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

function defaultConfig(type) {
    const base = {
        groupReplyMode: "off",
        groupFilter: "whitelist",
        groupAllowlist: [],
        groupBlocklist: [],
    };
    if (type === "qqofficial") {
        return { ...base, appId: "", clientSecret: "" };
    }
    return { ...base, wsUrl: "", token: "", protocol: "onebot11" };
}

function startAdd() {
    if (props.readonly) return;
    // 默认 QQ 官方机器人（合规，无需第三方 QQ 客户端 / 公网回调）
    editing.value = { id: "new", type: "qqofficial", name: "", enabled: true, config: defaultConfig("qqofficial") };
    notice.value = "";
}

function startEdit(a) {
    if (props.readonly) return;
    editing.value = JSON.parse(JSON.stringify({ ...a, config: { ...defaultConfig(a.type), ...(a.config || {}) } }));
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
    if (props.readonly || !editing.value) return;
    const f = editing.value;
    if (!f.name.trim()) {
        errorMsg.value = "名字要填";
        return;
    }
    if (f.type === "onebot" && !f.config.wsUrl.trim()) {
        errorMsg.value = "OneBot 要填 WS 地址";
        return;
    }
    if (f.type === "qqofficial" && (!f.config.appId.trim() || !f.config.clientSecret.trim())) {
        errorMsg.value = "QQ 官方机器人要填 AppID 和 Client Secret";
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
    if (props.readonly) return;
    try {
        await api.updateBot(a.id, { enabled: !a.enabled });
        await load();
        emit("saved");
    } catch (e) {
        errorMsg.value = e.authFailed ? "口令不对，请重新进入" : e.message || "操作失败";
    }
}

async function remove(a) {
    if (props.readonly) return;
    if (!confirm(`删掉机器人「${a.name}」？连接配置会一起消失。`)) return;
    try {
        await api.deleteBot(a.id);
        notice.value = "已删除";
        await load();
    } catch (e) {
        errorMsg.value = e.authFailed ? "口令不对，请重新进入" : e.message || "删除失败";
    }
}

// 设为主人：该账号之后发来的消息并进主对话（和控制台/桌宠版共用同一段记录）
async function setOwner(a) {
    if (props.readonly) return;
    try {
        const r = await api.setBotOwner(a.id, a._ownerKey || "");
        const moved = r?.moved || 0;
        notice.value =
            moved > 0
                ? `已设好主人，还把之前聊过的 ${moved} 条记录并进了主对话`
                : "已设好主人，之后这个账号的消息会并进主对话";
        await load();
        emit("saved");
    } catch (e) {
        errorMsg.value = e.authFailed ? "口令不对，请重新进入" : e.message || "设置失败";
    }
}

async function clearOwner(a) {
    if (props.readonly) return;
    try {
        await api.setBotOwner(a.id, "");
        notice.value = "已取消主人";
        await load();
        emit("saved");
    } catch (e) {
        errorMsg.value = e.authFailed ? "口令不对，请重新进入" : e.message || "取消失败";
    }
}

// 连接状态、新出现的账号每隔几秒自动刷新（桌宠版是主进程推送，控制台用轮询等效）
let statusTimer = null;
onMounted(() => {
    load();
    statusTimer = setInterval(load, 5000);
});
onUnmounted(() => {
    if (statusTimer) clearInterval(statusTimer);
});
</script>

<template>
  <section class="card wide">
    <h2>机器人</h2>
    <p v-if="readonly" class="leaf-lock">当前节点是组网叶子，QQ 连接由主机统一驱动，协议端设置跟随主机、这里只读。要修改请到主机上操作，或先退出组网。</p>
    <p class="card-desc">
      默认使用 QQ 官方机器人（官方 WebSocket 反向连接，合规稳定，无需公网回调与第三方 QQ 客户端）。
      OneBot 作为通用协议端保留，用于非 QQ 的自有机器人框架。与桌宠版共用同一份配置。
    </p>

    <div v-if="loading && adapters.length === 0" class="dim">读取中…</div>
    <div v-else-if="adapters.length === 0 && !editing" class="dim">
      {{ readonly ? "机器人由主机统一接入，本机不单独配置。" : "还没有接入机器人。点下面的「添加一个」开始。" }}
    </div>

    <div v-for="a in adapters" :key="a.id" class="list-item">
      <div class="list-main">
        <div class="list-title">
          <label v-if="!readonly" class="switch" :aria-label="`启用 ${a.name}`">
            <input type="checkbox" :checked="a.enabled !== false" @change="toggle(a)" />
            <span class="switch__slider"></span>
          </label>
          <strong>{{ a.name }}</strong>
          <span class="pill" :class="a.connected ? 'ok' : 'bad'">
            {{ a.connected ? "已连接" : "未连接" }}
          </span>
          <span v-if="a.selfQQ" class="pill dim">QQ {{ a.selfQQ }}</span>
        </div>
        <div class="list-desc dim">
          <span class="pill dim">{{ a.type === "qqofficial" ? "QQ官方" : "OneBot" }}</span>
          {{ a.type === "qqofficial" ? `AppID ${a.config?.appId || "（未填）"}` : a.config?.wsUrl || "（没填地址）" }}
        </div>
        <div v-if="a.lastError" class="list-desc error">{{ a.lastError }}</div>

        <!-- 主人绑定：被设为 owner 的账号，消息并进主对话（与桌宠版同一功能） -->
        <div class="owner-row" v-if="!readonly">
          <template v-if="a.ownerAccount">
            <span class="pill ok">主人：{{ a.ownerAccount }}</span>
            <button class="mini" @click="clearOwner(a)">取消主人</button>
          </template>
          <template v-else>
            <select v-model="a._ownerKey" class="owner-select">
              <option value="">设为某账号为主人…</option>
              <option v-for="acc in a.knownAccounts || []" :key="acc" :value="acc">{{ acc }}</option>
            </select>
            <button class="mini primary" :disabled="!a._ownerKey" @click="setOwner(a)">设为主人</button>
          </template>
        </div>
        <p v-if="!(a.knownAccounts || []).length" class="list-desc dim">
          连接后收到消息，这里才会出现可设为主人的账号。
        </p>
      </div>
      <div class="list-ops" v-if="!readonly">
        <button class="mini" @click="startEdit(a)">编辑</button>
        <button class="mini danger" @click="remove(a)">删除</button>
      </div>
    </div>

    <p v-if="notice" class="notice">{{ notice }}</p>
    <p v-if="errorMsg" class="error">{{ errorMsg }}</p>

    <div v-if="editing" class="edit-box">
      <h3>{{ editing.id === "new" ? "添加机器人" : "编辑机器人" }}</h3>

      <label class="field-label">协议类型</label>
      <select v-model="editing.type" @change="editing.config = defaultConfig(editing.type)">
        <option value="qqofficial">QQ 官方机器人（默认推荐）</option>
        <option value="onebot">OneBot（通用协议端，非 QQ 默认）</option>
      </select>

      <label class="field-label">名称</label>
      <input v-model="editing.name" maxlength="60" placeholder="如：我的 QQ 机器人" />

      <template v-if="editing.type === 'onebot'">
        <label class="field-label">WS 地址</label>
        <input v-model="editing.config.wsUrl" placeholder="ws://127.0.0.1:3001" />

        <label class="field-label">访问令牌（可选）</label>
        <input v-model="editing.config.token" type="password" placeholder="对应 OneBot 的 access_token" />
      </template>
      <template v-else>
        <label class="field-label">AppID</label>
        <input v-model="editing.config.appId" placeholder="QQ 开放平台 AppID" />

        <label class="field-label">Client Secret</label>
        <input v-model="editing.config.clientSecret" type="password" placeholder="QQ 开放平台 Client Secret" />
        <p class="dim">在 QQ 开放平台创建机器人后填写；程序主动连官方 WSS，无需公网回调。</p>
      </template>

      <div class="divider"></div>
      <h4>群消息怎么回复（OneBot 通用协议端适用）</h4>

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

    <button v-else-if="!readonly" class="ghost add-btn" @click="startAdd">＋ 添加一个</button>
  </section>
</template>

<style scoped>
/* 主人绑定行：与列表项其它控件同一节奏，select 继承 .card select 全局样式 */
.owner-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 6px;
}
.owner-select {
    min-width: 160px;
}
</style>
