<script setup lang="ts">
import { ref, computed } from "vue";
import { useAdapters, type AdapterConfigInput } from "../../composables/useAdapters";

const {
  adapters,
  add,
  update,
  remove,
  connect,
  disconnect,
  setOwner,
} = useAdapters();

// 新增表单
const showForm = ref(false);
const formType = ref<"onebot" | "qqofficial">("onebot");
const formName = ref("");
const formWsUrl = ref("");
const formToken = ref("");
const formAppId = ref("");
const formSecret = ref("");
const formError = ref("");

const isOneBot = computed(() => formType.value === "onebot");

async function handleAdd() {
  formError.value = "";
  const name = formName.value.trim();
  if (!name) {
    formError.value = "请填写适配器名称";
    return;
  }
  if (formType.value === "onebot") {
    if (!formWsUrl.value.trim()) {
      formError.value = "OneBot 需要填写 WS 地址";
      return;
    }
    const cfg: AdapterConfigInput = {
      type: "onebot",
      name,
      enabled: true,
      config: {
        wsUrl: formWsUrl.value.trim(),
        token: formToken.value.trim() || undefined,
        protocol: "onebot11",
      },
      ownerAccount: null,
    };
    await add(cfg);
  } else {
    // QQ 官方机器人：第二阶段实现，先登记配置占位
    const cfg: AdapterConfigInput = {
      type: "qqofficial",
      name,
      enabled: false,
      config: {
        appId: formAppId.value.trim(),
        clientSecret: formSecret.value.trim(),
      },
      ownerAccount: null,
    };
    await add(cfg);
  }
  // 重置表单
  formName.value = "";
  formWsUrl.value = "";
  formToken.value = "";
  formAppId.value = "";
  formSecret.value = "";
  showForm.value = false;
}

async function handleToggle(ad: any) {
  if (ad.connected) await disconnect(ad.id);
  else await connect(ad.id);
}

async function handleRemove(ad: any) {
  await remove(ad.id);
}

async function handleSetOwner(ad: any) {
  const key = (ad as any)._ownerKey || "";
  await setOwner(ad.id, key);
}

async function handleGroupMode(ad: any, val: string) {
  await update(ad.id, { config: { groupReplyMode: val } });
}

async function handleGroupFilter(ad: any, val: string) {
  await update(ad.id, { config: { groupFilter: val } });
}

async function handleGroupList(ad: any, field: "groupAllowlist" | "groupBlocklist", val: string) {
  const arr = val
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  await update(ad.id, { config: { [field]: arr } });
}
</script>

<template>
  <section class="adapter-section">
    <h3 class="section-title">机器人适配器</h3>
    <p class="hint">
      接入 OneBot（NapCat / LLOneBot）或 QQ 官方机器人，让桌宠通过 QQ 收发消息。可同时挂多个适配器。
      把某个 QQ 号设为「主人」后，该账号与桌面宠共享同一份聊天记录与记忆。
    </p>

    <!-- 已配置适配器列表 -->
    <div v-if="adapters.length" class="adapter-list">
      <div v-for="ad in adapters" :key="ad.id" class="adapter-card">
        <div class="adapter-head">
          <div class="adapter-name">
            <span class="badge" :class="ad.type">{{ ad.type === 'onebot' ? 'OneBot' : 'QQ官方' }}</span>
            <strong>{{ ad.name }}</strong>
          </div>
          <span
            class="status-dot"
            :class="{ on: ad.connected, off: !ad.connected }"
          >{{ ad.connected ? "已连接" : "未连接" }}</span>
        </div>

        <div v-if="ad.lastError" class="adapter-err">⚠ {{ ad.lastError }}</div>

        <div class="adapter-actions">
          <button
            type="button"
            class="mini-btn"
            @click="handleToggle(ad)"
          >
            {{ ad.connected ? "断开" : "连接" }}
          </button>
          <button type="button" class="mini-btn ghost" @click="handleRemove(ad)">删除</button>
        </div>

        <!-- 群消息回复触发方式（仅 OneBot，默认关闭，最安全） -->
        <div v-if="ad.type === 'onebot'" class="group-mode-row">
          <label class="group-mode-label">群消息回复</label>
          <select
            class="group-mode-select"
            :value="(ad.config && ad.config.groupReplyMode) || 'off'"
            @change="handleGroupMode(ad, ($event.target as HTMLSelectElement).value)"
          >
            <option value="off">关闭（不回复群消息）</option>
            <option value="mention">仅当我被 @ 时回复</option>
            <option value="all">回复所有消息（危险）</option>
          </select>
        </div>

        <!-- 群范围过滤：白名单 / 黑名单（选择回复方式后展示，与触发方式正交） -->
        <template
          v-if="ad.type === 'onebot' && ad.config && ad.config.groupReplyMode && ad.config.groupReplyMode !== 'off'"
        >
          <div class="group-mode-row">
            <label class="group-mode-label">群范围</label>
            <select
              class="group-mode-select"
              :value="(ad.config && ad.config.groupFilter) || 'whitelist'"
              @change="handleGroupFilter(ad, ($event.target as HTMLSelectElement).value)"
            >
              <option value="whitelist">白名单（仅允许列表内的群可被回复）</option>
              <option value="blacklist">黑名单（排除列表内的群，其余均可回复）</option>
            </select>
          </div>

          <div v-if="(ad.config && ad.config.groupFilter) !== 'blacklist'" class="group-allow-row">
            <label class="group-mode-label">允许回复的群号</label>
            <input
              class="group-allow-input"
              type="text"
              :value="((ad.config && (ad.config.groupAllowlist as unknown as string[])) || []).join(', ')"
              @change="handleGroupList(ad, 'groupAllowlist', ($event.target as HTMLInputElement).value)"
              placeholder="输入允许回复的群号，逗号分隔，如 123456789, 987654321"
            />
          </div>
          <div v-else class="group-allow-row">
            <label class="group-mode-label">排除回复的群号</label>
            <input
              class="group-allow-input block"
              type="text"
              :value="((ad.config && (ad.config.groupBlocklist as unknown as string[])) || []).join(', ')"
              @change="handleGroupList(ad, 'groupBlocklist', ($event.target as HTMLInputElement).value)"
              placeholder="输入永不回复的群号，逗号分隔，如 123456789（真实群聊建议列入此处）"
            />
          </div>
        </template>
        <p v-if="ad.type === 'onebot'" class="hint small warn">
          ⚠ 群消息默认关闭。开启后默认「白名单」模式——只有你显式加入允许列表的群才会被回复；选「黑名单」会回复除排除列表外的所有群，请谨慎。
        </p>

        <!-- 主人绑定 -->
        <div class="owner-row">
          <template v-if="ad.ownerAccount">
            <span class="owner-tag">主人：{{ ad.ownerAccount }}</span>
            <button
              type="button"
              class="mini-btn ghost"
              @click="setOwner(ad.id, '')"
            >
              取消主人
            </button>
          </template>
          <template v-else>
            <select v-model="(ad as any)._ownerKey" class="owner-select">
              <option value="">设为某账号为主人…</option>
              <option v-for="acc in ad.knownAccounts" :key="acc" :value="acc">
                {{ acc }}
              </option>
            </select>
            <button
              type="button"
              class="mini-btn"
              :disabled="!(ad as any)._ownerKey"
              @click="handleSetOwner(ad)"
            >
              设为主人
            </button>
          </template>
        </div>
        <p v-if="!ad.knownAccounts.length" class="hint small">
          连接后收到消息，才会出现可设为主人的账号。
        </p>
      </div>
    </div>

    <!-- 新增表单 -->
    <div v-if="showForm" class="adapter-form">
      <label>协议类型</label>
      <div class="provider-row">
        <label class="provider-option">
          <input type="radio" value="onebot" v-model="formType" />
          <span>OneBot（NapCat / LLOneBot）</span>
        </label>
        <label class="provider-option">
          <input type="radio" value="qqofficial" v-model="formType" />
          <span>QQ 官方机器人（第二阶段）</span>
        </label>
      </div>

      <label for="ad-name">名称</label>
      <input id="ad-name" v-model="formName" type="text" placeholder="如：NapCat 主号" />

      <template v-if="isOneBot">
        <label for="ad-ws">WS 地址</label>
        <input id="ad-ws" v-model="formWsUrl" type="text" placeholder="ws://127.0.0.1:3001" />
        <label for="ad-token">访问令牌（可选）</label>
        <input id="ad-token" v-model="formToken" type="password" placeholder="对应 OneBot 的 access_token" />
      </template>
      <template v-else>
        <label for="ad-appid">AppID</label>
        <input id="ad-appid" v-model="formAppId" type="text" placeholder="QQ 开放平台 AppID" />
        <label for="ad-secret">Client Secret</label>
        <input id="ad-secret" v-model="formSecret" type="password" placeholder="QQ 开放平台密钥" />
        <p class="hint small">QQ 官方机器人收发逻辑将在第二阶段接入，此处仅登记配置。</p>
      </template>

      <div v-if="formError" class="error-message">{{ formError }}</div>
      <div class="form-actions">
        <button type="button" class="primary-btn" @click="handleAdd">添加</button>
        <button type="button" class="ghost-btn" @click="showForm = false">取消</button>
      </div>
    </div>

    <button v-else type="button" class="import-btn" @click="showForm = true">
      + 添加机器人适配器
    </button>
  </section>
</template>

<style scoped>
.adapter-section {
  display: grid;
  gap: 14px;
  padding: 18px 18px 20px;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.5);
  backdrop-filter: blur(12px) saturate(140%);
  -webkit-backdrop-filter: blur(12px) saturate(140%);
  border: 1px solid rgba(255, 255, 255, 0.6);
  box-shadow: 0 10px 28px rgba(57, 44, 76, 0.1);
  margin-top: 28px;
  margin-bottom: 20px;
}
.section-title {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 0;
  font-size: 16px;
  font-weight: 800;
  letter-spacing: 0.5px;
  color: var(--pet-ink);
}
.section-title::before {
  content: "";
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: linear-gradient(135deg, #ff8fb1 0%, #a78bfa 100%);
  box-shadow: 0 0 0 4px rgba(167, 139, 250, 0.18);
  flex: 0 0 auto;
}
.hint {
  color: var(--pet-muted);
  font-size: 13px;
}
.hint.small {
  font-size: 12px;
  margin: 4px 0 0;
}
.adapter-list {
  display: grid;
  gap: 12px;
}
.adapter-card {
  display: grid;
  gap: 10px;
  padding: 14px;
  border-radius: 13px;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.7), rgba(255, 255, 255, 0.42));
  border: 1px solid rgba(167, 139, 250, 0.18);
}
.adapter-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.adapter-name {
  display: flex;
  align-items: center;
  gap: 8px;
}
.badge {
  font-size: 11px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 999px;
  color: #fff;
}
.badge.onebot {
  background: linear-gradient(135deg, #34d399, #059669);
}
.badge.qqofficial {
  background: linear-gradient(135deg, #38bdf8, #2563eb);
}
.status-dot {
  font-size: 12px;
  font-weight: 700;
}
.status-dot.on {
  color: #16a34a;
}
.status-dot.off {
  color: var(--pet-muted);
}
.adapter-err {
  font-size: 12px;
  color: #d33;
}
.group-mode-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.group-mode-label {
  font-size: 13px;
  font-weight: 700;
  color: var(--pet-ink);
}
.group-mode-select {
  flex: 1;
  min-width: 160px;
  padding: 7px 10px;
  border: 1.5px solid var(--pet-border);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.85);
  color: var(--pet-ink);
}
.hint.small.warn {
  color: #c0392b;
  font-weight: 600;
}
.group-allow-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.group-allow-input {
  flex: 1;
  min-width: 200px;
  padding: 7px 10px;
  border: 1.5px solid #f0a8a0;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.85);
  color: var(--pet-ink);
}
.group-allow-input.block {
  border-color: #e0b85a;
}
.adapter-actions {
  display: flex;
  gap: 8px;
}
.mini-btn {
  padding: 6px 12px;
  border: 0;
  border-radius: 8px;
  background: var(--pet-accent, #7c3aed);
  color: #fff;
  font-weight: 600;
  font-size: 13px;
  cursor: pointer;
}
.mini-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.mini-btn.ghost {
  background: transparent;
  color: var(--pet-accent, #7c3aed);
  border: 1.5px solid rgba(167, 139, 250, 0.45);
}
.owner-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.owner-tag {
  font-size: 12px;
  font-weight: 700;
  color: #16a34a;
  background: rgba(22, 163, 74, 0.1);
  padding: 3px 8px;
  border-radius: 999px;
}
.owner-select {
  flex: 1;
  min-width: 140px;
  padding: 7px 10px;
  border: 1.5px solid var(--pet-border);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.85);
  color: var(--pet-ink);
}
.adapter-form {
  display: grid;
  gap: 10px;
  padding: 14px;
  border-radius: 13px;
  background: rgba(255, 255, 255, 0.5);
  border: 1px solid rgba(167, 139, 250, 0.25);
}
label {
  font-size: 13px;
  font-weight: 600;
  color: var(--pet-muted);
}
input {
  flex: 1;
  padding: 10px 12px;
  border: 1px solid var(--pet-border);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.55);
  color: var(--pet-ink);
}
input:focus {
  outline: none;
  border-color: var(--pet-accent);
  box-shadow: 0 0 0 3px var(--pet-focus-ring);
}
.provider-row {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}
.provider-option {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--pet-ink);
  cursor: pointer;
}
.provider-option input {
  width: auto;
  flex: 0 0 auto;
  margin: 0;
  accent-color: var(--pet-accent, #7c3aed);
}
.form-actions {
  display: flex;
  gap: 10px;
}
.primary-btn {
  background: var(--pet-accent);
  color: #fff;
  border: 0;
  border-radius: 8px;
  padding: 10px 16px;
  font-weight: 600;
  cursor: pointer;
}
.ghost-btn {
  border: 1.5px solid rgba(167, 139, 250, 0.45);
  background: rgba(255, 255, 255, 0.7);
  color: var(--pet-accent, #7c3aed);
  border-radius: 8px;
  padding: 10px 16px;
  font-weight: 600;
  cursor: pointer;
}
.import-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px 14px;
  border-radius: 999px;
  border: 0;
  color: #fff;
  background: linear-gradient(135deg, #ff8fb1 0%, #b07cf0 55%, #8b5cf6 100%);
  box-shadow: 0 8px 18px rgba(176, 124, 240, 0.4);
  font-size: 14px;
  font-weight: 700;
  cursor: pointer;
}
.error-message {
  color: #d33;
  font-size: 12px;
}
</style>
