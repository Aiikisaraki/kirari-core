<script setup>
// 工具服务（MCP）设置：接入外部 MCP server，让助手多一批能调用的工具。
// 与桌宠版「MCP」页等价 —— 同一份 mcp-servers.json。
//
// 两种连接方式：
//   HTTP 型：填服务地址（streamable HTTP）
//   stdio 型：填启动命令和参数（本地起个子进程）
import { ref, onMounted } from "vue";
import { api } from "../../api.js";

const emit = defineEmits(["saved"]);

const servers = ref([]);
const loading = ref(false);
const errorMsg = ref("");
const notice = ref("");
const editing = ref(null); // { id: "new"|string, name, transport, url, command, args, enabled }
const probing = ref(false);
const probeResult = ref("");

async function load() {
    loading.value = true;
    errorMsg.value = "";
    try {
        const d = await api.listMcp();
        servers.value = d.items || [];
    } catch (e) {
        errorMsg.value = e.authFailed ? "口令不对，请重新进入" : e.message || "读取失败";
    } finally {
        loading.value = false;
    }
}

function startAdd() {
    editing.value = { id: "new", name: "", transport: "http", url: "", command: "", args: [], enabled: true };
    notice.value = "";
    probeResult.value = "";
}

function startEdit(s) {
    editing.value = JSON.parse(JSON.stringify({ ...s, args: s.args || [] }));
    notice.value = "";
    probeResult.value = "";
}

function cancelEdit() {
    editing.value = null;
    probeResult.value = "";
}

async function saveEdit() {
    if (!editing.value) return;
    const f = editing.value;
    if (!f.name.trim()) {
        errorMsg.value = "名字要填";
        return;
    }
    if (f.transport === "http" && !f.url.trim()) {
        errorMsg.value = "HTTP 型要填服务地址";
        return;
    }
    if (f.transport === "stdio" && !f.command.trim()) {
        errorMsg.value = "stdio 型要填启动命令";
        return;
    }
    errorMsg.value = "";
    try {
        const payload = {
            name: f.name,
            transport: f.transport,
            enabled: f.enabled,
            url: f.transport === "http" ? f.url : undefined,
            command: f.transport === "stdio" ? f.command : undefined,
            args: f.transport === "stdio" ? f.args : undefined,
        };
        if (f.id === "new") await api.addMcp(payload);
        else await api.updateMcp(f.id, payload);
        notice.value = "已保存，工具已重新加载";
        await load();
        emit("saved");
        editing.value = null;
    } catch (e) {
        errorMsg.value = e.authFailed ? "口令不对，请重新进入" : e.message || "保存失败";
    }
}

async function toggle(s) {
    try {
        await api.updateMcp(s.id, { enabled: !s.enabled });
        await load();
        emit("saved");
    } catch (e) {
        errorMsg.value = e.authFailed ? "口令不对，请重新进入" : e.message || "操作失败";
    }
}

async function remove(s) {
    if (!confirm(`删掉工具服务「${s.name}」？它提供的工具会一起消失。`)) return;
    try {
        await api.deleteMcp(s.id);
        notice.value = "已删除";
        await load();
    } catch (e) {
        errorMsg.value = e.authFailed ? "口令不对，请重新进入" : e.message || "删除失败";
    }
}

/** 保存前先试连：地址/命令填错时立刻报出来。 */
async function probe() {
    const f = editing.value;
    if (!f) return;
    probing.value = true;
    probeResult.value = "";
    try {
        const r = await api.probeMcp({
            name: f.name,
            transport: f.transport,
            url: f.url,
            command: f.command,
            args: f.args,
        });
        if (r.ok) {
            probeResult.value = `连通正常，这个服务提供 ${r.tools.length} 个工具` +
                (r.tools.length ? `：${r.tools.map((t) => t.name).slice(0, 8).join("、")}` : "");
        } else {
            probeResult.value = `连不上：${r.error || "未知原因"}`;
        }
    } catch (e) {
        probeResult.value = `测试失败：${e.authFailed ? "口令不对" : e.message || "未知原因"}`;
    } finally {
        probing.value = false;
    }
}

function onArgsInput(e) {
    editing.value.args = e.target.value
        .split(/[,，\s]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 30);
}

onMounted(load);
</script>

<template>
  <section class="card wide">
    <h2>工具服务（MCP）</h2>
    <p class="card-desc">
      接入外部 MCP 服务，助手就多一批能调用的工具（查文件、搜代码、操作你的系统之类）。
      <br />
      连上之后，模型会自己判断什么时候用这些工具 —— 你不用管。和桌宠版共用同一份配置。
    </p>

    <div v-if="loading && servers.length === 0" class="dim">读取中…</div>
    <div v-else-if="servers.length === 0 && !editing" class="dim">
      还没有接入任何工具服务。点下面的「添加一个」开始。
    </div>

    <div v-for="s in servers" :key="s.id" class="list-item">
      <div class="list-main">
        <div class="list-title">
          <label class="switch" :aria-label="`启用 ${s.name}`">
            <input type="checkbox" :checked="s.enabled !== false" @change="toggle(s)" />
            <span class="switch__slider"></span>
          </label>
          <strong>{{ s.name }}</strong>
          <span class="pill">{{ s.transport === "stdio" ? "本地命令" : "HTTP" }}</span>
          <span v-if="s.enabled === false" class="pill dim">已停用</span>
        </div>
        <div class="list-desc dim">{{ s.transport === "stdio" ? `${s.command} ${(s.args || []).join(" ")}` : s.url }}</div>
      </div>
      <div class="list-ops">
        <button class="mini" @click="startEdit(s)">编辑</button>
        <button class="mini danger" @click="remove(s)">删除</button>
      </div>
    </div>

    <p v-if="notice" class="notice">{{ notice }}</p>
    <p v-if="errorMsg" class="error">{{ errorMsg }}</p>

    <div v-if="editing" class="edit-box">
      <h3>{{ editing.id === "new" ? "添加工具服务" : "编辑工具服务" }}</h3>

      <label class="field-label">连接方式</label>
      <div class="radio-row">
        <label class="radio">
          <input type="radio" value="http" v-model="editing.transport" />
          <span>HTTP（填服务地址）</span>
        </label>
        <label class="radio">
          <input type="radio" value="stdio" v-model="editing.transport" />
          <span>本地命令（stdio）</span>
        </label>
      </div>

      <label class="field-label">名字</label>
      <input v-model="editing.name" maxlength="60" placeholder="例如：本地文件系统" />

      <template v-if="editing.transport === 'http'">
        <label class="field-label">服务地址</label>
        <input v-model="editing.url" placeholder="https://example.com/mcp" />
      </template>
      <template v-else>
        <label class="field-label">启动命令</label>
        <input v-model="editing.command" placeholder="npx" />
        <label class="field-label">参数（空格或逗号分隔）</label>
        <input :value="(editing.args || []).join(' ')" placeholder="-y, some-mcp-server" @input="onArgsInput" />
      </template>

      <label class="checkbox-row">
        <input type="checkbox" v-model="editing.enabled" />
        <span>启用这个工具服务</span>
      </label>

      <p v-if="probeResult" class="notice">{{ probeResult }}</p>

      <div class="edit-ops">
        <button class="primary" @click="saveEdit">保存</button>
        <button class="ghost" :disabled="probing" @click="probe">{{ probing ? "测试中…" : "测试连接" }}</button>
        <button class="ghost" @click="cancelEdit">取消</button>
      </div>
    </div>

    <button v-else class="ghost add-btn" @click="startAdd">＋ 添加一个</button>
  </section>
</template>
