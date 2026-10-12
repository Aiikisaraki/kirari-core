<script setup>
// 组网设置：多台设备共用一个大脑。
//
// 与桌宠版「组网」页**功能完全对等**（用户拍板）—— 同一个目录、同一份
// net-state.json、同一套操作：切角色、改设备名、主机签连接码/撤销/清理、
// 管理已接入设备、勾选同步项；叶子贴码接入、看待同步条数、立即补传、移除自己。
//
// 界面对主机与叶子完全相同，只是背后按 role 走不同分支 —— 不写两套页面
// （与桌宠版 SyncSettings.vue 同一设计）。
//
// 与桌宠版仅剩的差异：连接码以**文本**形式展示（桌宠版多一个二维码，
// 那是 electron 里的 qrcode 渲染；二维码本质是同一串字符的另一种编码，
// 复制粘贴一样能用）。
import { ref, computed, onMounted, onUnmounted } from "vue";
import { api } from "../../api.js";

const emit = defineEmits(["saved"]);

const EXPIRIES = [
    { value: "1h", label: "1 小时" },
    { value: "1d", label: "1 天" },
    { value: "7d", label: "7 天" },
    { value: "30d", label: "30 天" },
    { value: "forever", label: "永久" },
];

const SYNC_LABELS = {
    model: "当前用的模型型号",
    endpoint: "模型服务地址",
    basePersona: "基础人格",
    searchProvider: "搜索来源",
    searchEndpoint: "搜索服务地址",
};

const snap = ref(null);
const addresses = ref([]);
const canStart = ref(true);
const allFields = ref([]);
const whitelist = ref([]);
const busy = ref(false);
const errorMsg = ref("");
const notice = ref("");

// 表单态
const expiry = ref("7d");
const pairingText = ref("");
const codeDraft = ref("");
const nameDraft = ref("");
const lastCode = ref("");

const isHost = computed(() => snap.value?.role === "host");
const isLeaf = computed(() => snap.value?.role === "leaf");
const isOff = computed(() => snap.value?.role === "off");
const pendingBackfill = computed(() => snap.value?.pendingBackfill ?? 0);

// leafStatus 是字符串（"connected" / "connecting" / "offline" …），不是对象
const leafOnline = computed(() => snap.value?.leafStatus === "connected");
const leafStatusText = computed(() => {
    const s = snap.value?.leafStatus;
    if (s === "connected") return "已连接";
    if (s === "connecting") return "正在连接";
    if (!s) return "还没连上";
    return `没连上（${s}）`;
});

let pollTimer = null;

function applySnap(s) {
    if (s) snap.value = s;
}

function flash(msg) {
    notice.value = msg;
    setTimeout(() => (notice.value = ""), 3000);
}

async function load() {
    try {
        const [st, ad, cs, sw] = await Promise.all([
            api.netState(),
            api.netAddresses(),
            api.netCanStart(),
            api.netSyncWhitelist(),
        ]);
        applySnap(st.snapshot);
        addresses.value = ad.addresses || [];
        canStart.value = cs.enabled !== false;
        allFields.value = sw.fields || [];
        whitelist.value = sw.whitelist || [];
        nameDraft.value = snap.value?.deviceName || "";
    } catch (e) {
        errorMsg.value = e.authFailed ? "口令不对，请重新进入" : e.message || "读取失败";
    }
}

/** 主机开启组网，并生成第一个连接码。 */
async function startHost() {
    busy.value = true;
    errorMsg.value = "";
    try {
        const r = await api.netStartHost(expiry.value);
        applySnap(r.snapshot);
        if (r.ok) {
            lastCode.value = r.code || "";
            flash("已开启组网，把下面的连接码交给其他设备就能接入");
            emit("saved");
        } else {
            errorMsg.value = r.error || "开启失败";
        }
    } catch (e) {
        errorMsg.value = e.authFailed ? "口令不对，请重新进入" : e.message || "开启失败";
    } finally {
        busy.value = false;
    }
}

/** 再生成一个连接码（每台设备一个码）。 */
async function issuePairing() {
    busy.value = true;
    errorMsg.value = "";
    try {
        const r = await api.netIssuePairing(expiry.value);
        applySnap(r.snapshot);
        if (r.ok) {
            lastCode.value = r.code || "";
            flash("已生成新连接码（旧的还能用，不用就作废掉）");
        } else {
            errorMsg.value = r.error || "生成失败";
        }
    } catch (e) {
        errorMsg.value = e.authFailed ? "口令不对，请重新进入" : e.message || "生成失败";
    } finally {
        busy.value = false;
    }
}

async function copyCode() {
    if (!lastCode.value) return;
    try {
        await navigator.clipboard.writeText(lastCode.value);
        flash("连接码已复制");
    } catch {
        // 剪贴板被浏览器拦（非 https / 无权限）：让用户手动选中复制
        flash("浏览器不让自动复制，请手动选中那段文字");
    }
}

/** 作为叶子加入：填入连接码完成首次配对。 */
async function joinAsLeaf() {
    const text = codeDraft.value.trim();
    if (!text) {
        errorMsg.value = "先把主机给的连接码整串粘进来";
        return;
    }
    busy.value = true;
    errorMsg.value = "";
    try {
        const r = await api.netJoin(text);
        applySnap(r.snapshot);
        if (r.ok) {
            codeDraft.value = "";
            flash("已接入主机，凭据已保存，下次开机会自动重连");
            emit("saved");
        } else {
            errorMsg.value = r.error || "接入失败";
        }
    } catch (e) {
        errorMsg.value = e.authFailed ? "口令不对，请重新进入" : e.message || "接入失败";
    } finally {
        busy.value = false;
    }
}

/** 重新加入已配对的主机（打开开关时用，不需要重新填码）。 */
async function resumeAsLeaf() {
    busy.value = true;
    errorMsg.value = "";
    try {
        const r = await api.netResume();
        applySnap(r.snapshot);
        flash(r.ok ? "已重新接入主机" : r.error || "重连失败");
        if (!r.ok) errorMsg.value = r.error || "重连失败";
    } catch (e) {
        errorMsg.value = e.authFailed ? "口令不对，请重新进入" : e.message || "重连失败";
    } finally {
        busy.value = false;
    }
}

/**
 * 关闭组网。只「暂停参与」，不清除主机地址 / 长期凭据 / 已生成的连接码 ——
 * 下次打开凭持久化信息自动归位，用户零成本反复切换。
 */
async function stopNet() {
    busy.value = true;
    errorMsg.value = "";
    try {
        const r = await api.netStop();
        applySnap(r.snapshot);
        lastCode.value = "";
        flash("已关闭组网（配置都留着，再开自动归位）");
        emit("saved");
    } catch (e) {
        errorMsg.value = e.authFailed ? "口令不对，请重新进入" : e.message || "操作失败";
    } finally {
        busy.value = false;
    }
}

async function revokePairing(id) {
    try {
        const r = await api.netRevokePairing(id);
        applySnap(r.snapshot);
        flash("连接码已作废");
    } catch (e) {
        errorMsg.value = e.authFailed ? "口令不对，请重新进入" : e.message || "操作失败";
    }
}

async function prunePairings() {
    try {
        const r = await api.netPrunePairings();
        applySnap(r.snapshot);
        flash("已清理过期连接码");
    } catch (e) {
        errorMsg.value = e.authFailed ? "口令不对，请重新进入" : e.message || "操作失败";
    }
}

async function removeDevice(deviceId, name) {
    if (!confirm(`把「${name || deviceId}」移出去？它的访问资格会作废，之后连不上。`)) return;
    try {
        const r = await api.netRemoveDevice(deviceId);
        applySnap(r.snapshot);
        flash("已移除该设备");
    } catch (e) {
        errorMsg.value = e.authFailed ? "口令不对，请重新进入" : e.message || "操作失败";
    }
}

async function leaveHost() {
    if (!confirm("断开与主机的绑定？本机保存的主机地址和资格会清掉，下次要重新贴连接码。")) return;
    try {
        const r = await api.netLeave();
        applySnap(r.snapshot);
        flash("已断开与主机的绑定");
        emit("saved");
    } catch (e) {
        errorMsg.value = e.authFailed ? "口令不对，请重新进入" : e.message || "操作失败";
    }
}

async function renameSelf() {
    const name = nameDraft.value.trim();
    if (!name) {
        errorMsg.value = "设备名不能为空";
        return;
    }
    try {
        const r = await api.netRenameSelf(name);
        applySnap(r.snapshot);
        flash("设备名已更新");
        emit("saved");
    } catch (e) {
        errorMsg.value = e.authFailed ? "口令不对，请重新进入" : e.message || "操作失败";
    }
}

async function flushBackfill() {
    try {
        const r = await api.netFlush();
        applySnap(r.snapshot);
        flash("已把没同步的对话补传给主机");
    } catch (e) {
        errorMsg.value = e.authFailed ? "口令不对，请重新进入" : e.message || "操作失败";
    }
}

async function toggleSyncField(field) {
    const next = whitelist.value.includes(field)
        ? whitelist.value.filter((f) => f !== field)
        : [...whitelist.value, field];
    try {
        const r = await api.netSetSyncWhitelist(next);
        whitelist.value = r.whitelist || [];
        applySnap(r.snapshot);
        flash("同步项已更新，立即生效");
        emit("saved");
    } catch (e) {
        errorMsg.value = e.authFailed ? "口令不对，请重新进入" : e.message || "保存失败";
    }
}

function fmtTime(ts) {
    if (!ts) return "—";
    if (ts === 0) return "永久";
    return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

onMounted(() => {
    load();
    // 组网是长时连接：轮询拿最新状态（成员上下线、待同步条数都会变）
    pollTimer = setInterval(load, 5000);
});
onUnmounted(() => {
    if (pollTimer) clearInterval(pollTimer);
});
</script>

<template>
  <div class="net-page">
    <section class="card">
      <h2>组网</h2>
      <p class="card-desc">
        多台设备共用一个大脑时才需要开。开了之后，叶子设备的对话交给主机处理，
        模型、人格、搜索这些配置也会按你勾选的项同步。<br />
        配置文件和桌宠版是<strong>同一份</strong>（都在数据目录的 net-state.json）——
        在哪边改，另一边同时看到。
      </p>

      <p v-if="errorMsg" class="error">{{ errorMsg }}</p>
      <p v-if="notice" class="notice">{{ notice }}</p>

      <!-- 总开关 -->
      <div class="row">
        <div class="row-text">
          <h3>组网总开关</h3>
          <p>独立工作 / 当主机提供出口 / 当叶子用主机的大脑。随时可换，配置不丢。</p>
        </div>
        <div class="row-control">
          <div class="segmented" role="radiogroup">
            <button
              type="button"
              role="radio"
              :aria-checked="isOff"
              :class="{ on: isOff }"
              :disabled="busy"
              @click="isOff ? null : stopNet()"
            >
              关
            </button>
            <button
              type="button"
              role="radio"
              :aria-checked="isHost"
              :class="{ on: isHost }"
              :disabled="busy || !canStart"
              @click="isHost ? null : startHost()"
            >
              当主机
            </button>
            <button
              type="button"
              role="radio"
              :aria-checked="isLeaf"
              :class="{ on: isLeaf }"
              :disabled="busy || !canStart"
              @click="isLeaf ? resumeAsLeaf() : null"
            >
              当叶子
            </button>
          </div>
          <p v-if="!canStart" class="hint-warn">这台设备暂时不能开组网</p>
        </div>
      </div>

      <!-- 本机身份 -->
      <div class="row">
        <div class="row-text">
          <h3>这台设备的名字</h3>
          <p>其他设备在列表里看到的名字。</p>
        </div>
        <div class="row-control name-row">
          <input v-model="nameDraft" maxlength="40" placeholder="例如：客厅那台" />
          <button class="mini" :disabled="busy" @click="renameSelf">保存</button>
        </div>
      </div>

      <div class="row">
        <div class="row-text"><h3>本机设备号</h3><p>组网里的唯一标识，不用管。</p></div>
        <div class="row-control"><code>{{ snap?.deviceId || "—" }}</code></div>
      </div>

      <div class="row">
        <div class="row-text"><h3>连接状态</h3><p>当前角色与连接情况。</p></div>
        <div class="row-control">
          <span class="pill" :class="isOff ? 'dim' : 'ok'">
            {{ isOff ? "没开组网，本机独立工作" : isHost ? "主机：正在为其他设备提供出口" : "叶子：已接入主机" }}
          </span>
        </div>
      </div>
    </section>

    <!-- 主机侧 -->
    <section v-if="isHost" class="card">
      <h2>当主机</h2>
      <p class="card-desc">
        其他设备填你给的连接码就能接入。每个设备给一个码，用一次就失效；
        不需要的就作废掉。连接码等同于密码，别随便外传。
      </p>

      <div class="row">
        <div class="row-text"><h3>本机地址</h3><p>让对方连这个（同一局域网内）。</p></div>
        <div class="row-control">
          <code v-for="a in addresses" :key="a" class="addr">{{ a }}:{{ snap?.port }}</code>
        </div>
      </div>

      <div class="row">
        <div class="row-text"><h3>连接码有效期</h3><p>新签的码多久后不能再用。</p></div>
        <div class="row-control">
          <select v-model="expiry">
            <option v-for="e in EXPIRIES" :key="e.value" :value="e.value">{{ e.label }}</option>
          </select>
        </div>
      </div>

      <div class="row">
        <div class="row-text"><h3>生成连接码</h3><p>每台设备各给一个，别共用。</p></div>
        <div class="row-control">
          <button class="btn btn--primary btn--sm" :disabled="busy" @click="issuePairing">生成一个</button>
        </div>
      </div>

      <div v-if="lastCode" class="code-box">
        <div class="code-head">
          <span>新连接码（复制发给对方）</span>
          <button class="mini" @click="copyCode">复制</button>
        </div>
        <code class="code-text">{{ lastCode }}</code>
      </div>

      <h3 class="sub">已生成的连接码</h3>
      <div v-if="!snap?.pairings?.length" class="dim">还没有生成过连接码。</div>
      <div v-for="p in snap.pairings" :key="p.id" class="list-item">
        <div class="list-main">
          <div class="list-title">
            <code>{{ p.id }}</code>
            <span class="pill" :class="p.revoked ? 'bad' : p.usedBy ? 'dim' : 'ok'">
              {{ p.revoked ? "已作废" : p.usedBy ? `已被 ${p.usedBy} 用过` : "可用" }}
            </span>
          </div>
          <div class="list-desc dim">{{ p.remaining || "—" }} · 到期 {{ fmtTime(p.expiresAt) }}</div>
        </div>
        <div class="list-ops">
          <button v-if="!p.revoked" class="mini danger" @click="revokePairing(p.id)">作废</button>
        </div>
      </div>
      <button v-if="snap?.pairings?.length" class="ghost add-btn" @click="prunePairings">清理已过期没用过的</button>

      <h3 class="sub">已接入的设备</h3>
      <div v-if="!snap?.members?.length" class="dim">还没有设备接入。</div>
      <div v-for="m in snap.members" :key="m.deviceId" class="list-item">
        <div class="list-main">
          <div class="list-title"><strong>{{ m.name || m.deviceId }}</strong></div>
          <div class="list-desc dim"><code>{{ m.deviceId }}</code></div>
        </div>
        <div class="list-ops">
          <button class="mini danger" @click="removeDevice(m.deviceId, m.name)">移除</button>
        </div>
      </div>

      <h3 class="sub">统一哪些配置</h3>
      <p class="card-desc">勾选的会下发给所有叶子；没勾的各设备自管，互不干扰。</p>
      <label v-for="f in allFields" :key="f" class="checkbox-row">
        <input type="checkbox" :checked="whitelist.includes(f)" @change="toggleSyncField(f)" />
        <span>{{ SYNC_LABELS[f] || f }}</span>
      </label>
    </section>

    <!-- 叶子侧 -->
    <section v-if="isLeaf" class="card">
      <h2>当叶子</h2>
      <p class="card-desc">
        本机的对话会交给主机处理，所以本机不用配大脑钥匙。<br />
        主机地址和资格已保存，下次开机会自动重连。
      </p>

      <div class="row">
        <div class="row-text"><h3>连的是哪台主机</h3><p>从连接码里解析出来的。</p></div>
        <div class="row-control">
          <code>{{ snap?.address || "—" }}:{{ snap?.port }}</code>
          <span class="pill" :class="leafOnline ? 'ok' : 'bad'">
            {{ leafStatusText }}
          </span>
        </div>
      </div>

      <div class="row" v-if="pendingBackfill > 0">
        <div class="row-text">
          <h3>有 {{ pendingBackfill }} 条对话没同步</h3>
          <p>断线期间本机自己产生的对话，连上后可以补传给主机。</p>
        </div>
        <div class="row-control">
          <button class="btn btn--primary btn--sm" :disabled="busy" @click="flushBackfill">立即同步</button>
        </div>
      </div>

      <div class="row">
        <div class="row-text"><h3>换个主机接入</h3><p>贴另一个主机给的连接码。</p></div>
        <div class="row-control join-row">
          <input v-model="codeDraft" placeholder="把主机那边显示的那一整串粘进来" />
          <button class="mini primary" :disabled="busy" @click="joinAsLeaf">接入</button>
        </div>
      </div>

      <div class="row">
        <div class="row-text"><h3>退出这个网</h3><p>断开绑定并清掉本机保存的主机资格，下次要重新贴码。</p></div>
        <div class="row-control">
          <button class="btn btn--ghost btn--sm" :disabled="busy" @click="leaveHost">移除自己</button>
        </div>
      </div>
    </section>

    <!-- 没开组网时的引导 -->
    <section v-if="isOff" class="card">
      <h2>怎么用</h2>
      <p class="card-desc">
        选一台设备当<strong>主机</strong>（它需要配好大脑），其他设备当<strong>叶子</strong>。<br />
        主机点上方的「当主机」→ 生成一个连接码 → 把连接码发给叶子设备 → 叶子上贴进去。<br />
        叶子不用配任何钥匙，主机用自己的凭证支付，全网只有一个出口。
      </p>
    </section>
  </div>
</template>

<style scoped>
.net-page {
    display: flex;
    flex-direction: column;
    gap: 16px;
    max-width: 720px;
}
.sub {
    margin: 20px 0 4px;
    font-size: 14px;
    font-weight: 500;
}
.segmented {
    display: inline-flex;
    border: 1px solid var(--line);
    border-radius: 9px;
    overflow: hidden;
}
.segmented button {
    border: none;
    background: none;
    padding: 7px 14px;
    font-size: 13px;
    cursor: pointer;
    color: var(--dim);
}
.segmented button + button {
    border-left: 1px solid var(--line);
}
.segmented button.on {
    background: var(--brand);
    color: #fff;
}
.segmented button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}
.hint-warn {
    font-size: 12px;
    color: var(--warn);
    margin: 6px 0 0;
}
.name-row,
.join-row {
    display: flex;
    gap: 8px;
    align-items: center;
}
.name-row input,
.join-row input {
    flex: 1;
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 8px 11px;
    font: inherit;
    min-width: 0;
}
.addr {
    display: block;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    color: var(--text);
    word-break: break-all;
}
.code-box {
    border: 1px dashed var(--brand);
    border-radius: 10px;
    padding: 12px 14px;
    margin-top: 12px;
}
.code-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 13px;
    margin-bottom: 8px;
}
.code-text {
    display: block;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    line-height: 1.6;
    word-break: break-all;
    background: var(--bg);
    border-radius: 8px;
    padding: 10px;
    user-select: all;
}
.btn--sm {
    width: auto;
    padding: 7px 14px;
    margin: 0;
    font-size: 13px;
}
</style>
