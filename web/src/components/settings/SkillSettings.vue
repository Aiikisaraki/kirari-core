<script setup>
// 技能设置：给助手挂「行为模板」和「可调用工具」。
// 与桌宠版「技能」页等价 —— 同一份 skills.json，在哪边改另一边同步。
//
// 两种技能形态：
//   行为模板（prompt）：一段话注入系统指令，改变说话方式/职责
//   可调用工具（tools）：模型能主动调用的动作（发 HTTP 请求 / 演示透传）
import { ref, onMounted } from "vue";
import { api } from "../../api.js";

const emit = defineEmits(["saved"]);

const skills = ref([]);
const loading = ref(false);
const errorMsg = ref("");
const notice = ref("");
const editing = ref(null); // { id: "new"|string, name, description, enabled, prompt, tools }

async function load() {
    loading.value = true;
    errorMsg.value = "";
    try {
        const d = await api.listSkills();
        skills.value = d.items || [];
    } catch (e) {
        errorMsg.value = e.authFailed ? "口令不对，请重新进入" : e.message || "读取失败";
    } finally {
        loading.value = false;
    }
}

function startAdd() {
    editing.value = {
        id: "new",
        name: "",
        description: "",
        enabled: true,
        prompt: "",
        tools: [],
    };
    notice.value = "";
}

function startEdit(s) {
    editing.value = JSON.parse(JSON.stringify({ ...s, tools: s.tools || [] }));
    notice.value = "";
}

function cancelEdit() {
    editing.value = null;
}

async function saveEdit() {
    if (!editing.value) return;
    const f = editing.value;
    if (!f.name.trim()) {
        errorMsg.value = "名字要填";
        return;
    }
    errorMsg.value = "";
    try {
        const payload = {
            name: f.name,
            description: f.description,
            enabled: f.enabled,
            prompt: f.prompt,
            tools: f.tools,
        };
        if (f.id === "new") await api.addSkill(payload);
        else await api.updateSkill(f.id, payload);
        notice.value = "已保存";
        await load();
        emit("saved");
        editing.value = null;
    } catch (e) {
        errorMsg.value = e.authFailed ? "口令不对，请重新进入" : e.message || "保存失败";
    }
}

async function toggle(s) {
    try {
        await api.updateSkill(s.id, { enabled: !s.enabled });
        await load();
        emit("saved");
    } catch (e) {
        errorMsg.value = e.authFailed ? "口令不对，请重新进入" : e.message || "操作失败";
    }
}

async function remove(s) {
    if (!confirm(`删掉技能「${s.name}」？删了就找不回来了。`)) return;
    try {
        await api.deleteSkill(s.id);
        notice.value = "已删除";
        await load();
    } catch (e) {
        errorMsg.value = e.authFailed ? "口令不对，请重新进入" : e.message || "删除失败";
    }
}

// ── 工具编辑器（技能的 tools 字段）──
function addTool() {
    editing.value.tools.push({
        name: "",
        description: "",
        parameters: { type: "object", properties: {} },
        exec: { kind: "echo" },
    });
}
function removeTool(i) {
    editing.value.tools.splice(i, 1);
}

onMounted(load);
</script>

<template>
  <section class="card wide">
    <h2>技能</h2>
    <p class="card-desc">
      给助手挂上额外本领。两种形式：<b>行为模板</b>是一段话，告诉它该怎么说话、负责什么；
      <b>可调用工具</b>是模型能主动触发的动作（比如查一下你的服务）。和桌宠版共用同一份设置。
    </p>

    <div v-if="loading && skills.length === 0" class="dim">读取中…</div>
    <div v-else-if="skills.length === 0 && !editing" class="dim">
      还没有技能。点下面的「添加一个」试试。
    </div>

    <div v-for="s in skills" :key="s.id" class="list-item">
      <div class="list-main">
        <div class="list-title">
          <label class="switch" :aria-label="`启用 ${s.name}`">
            <input type="checkbox" :checked="s.enabled !== false" @change="toggle(s)" />
            <span class="switch__slider"></span>
          </label>
          <strong>{{ s.name }}</strong>
          <span v-if="s.prompt" class="pill">行为模板</span>
          <span v-if="s.tools?.length" class="pill">{{ s.tools.length }} 个工具</span>
        </div>
        <div class="list-desc">{{ s.description || "（没说这个技能做什么）" }}</div>
      </div>
      <div class="list-ops">
        <button class="mini" @click="startEdit(s)">编辑</button>
        <button class="mini danger" @click="remove(s)">删除</button>
      </div>
    </div>

    <p v-if="notice" class="notice">{{ notice }}</p>
    <p v-if="errorMsg" class="error">{{ errorMsg }}</p>

    <div v-if="editing" class="edit-box">
      <h3>{{ editing.id === "new" ? "添加一个技能" : "编辑技能" }}</h3>
      <label class="field-label">名字</label>
      <input v-model="editing.name" maxlength="40" placeholder="例如：贴心助手" />
      <label class="field-label">一句话说明</label>
      <input v-model="editing.description" maxlength="200" placeholder="这个技能是干什么的" />
      <label class="checkbox-row">
        <input type="checkbox" v-model="editing.enabled" />
        <span>启用这个技能</span>
      </label>
      <label class="field-label">行为模板（可选）</label>
      <textarea
        v-model="editing.prompt"
        class="text-area"
        rows="4"
        maxlength="4000"
        placeholder="例如：你是一只温柔的桌宠，回答简洁友好…"
      ></textarea>

      <div class="tools-head">
        <label class="field-label">可调用工具（可选）</label>
        <button class="mini" type="button" @click="addTool">＋ 加一个工具</button>
      </div>
      <div v-for="(t, i) in editing.tools" :key="i" class="tool-row">
        <input v-model="t.name" placeholder="工具名，如 query_status" />
        <input v-model="t.description" placeholder="这个工具做什么" />
        <select v-model="t.exec.kind">
          <option value="echo">演示透传（原样返回参数）</option>
          <option value="http">发一个 HTTP 请求</option>
        </select>
        <input v-if="t.exec.kind === 'http'" v-model="t.exec.url" placeholder="https://example.com/api" />
        <input v-if="t.exec.kind === 'http'" v-model="t.exec.method" placeholder="GET 或 POST" />
        <button class="mini danger" type="button" @click="removeTool(i)">删</button>
      </div>

      <div class="edit-ops">
        <button class="primary" @click="saveEdit">保存</button>
        <button class="ghost" @click="cancelEdit">取消</button>
      </div>
    </div>

    <button v-else class="ghost add-btn" @click="startAdd">＋ 添加一个技能</button>
  </section>
</template>
