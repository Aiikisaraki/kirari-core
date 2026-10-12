<script setup>
// 知识库设置：私人知识条目 + 远程知识源。
// 与桌宠版「知识库」页等价 —— 同一份 knowledge.json，在哪边加另一边同步生效。
//
// 本地条目：写下来让它记住的事实（同步关键词检索）
// 远程源：检索时实时抓取的地址（维基 / 博客 / RSS），不落本地副本
import { ref, onMounted } from "vue";
import { api, getToken } from "../../api.js";

const emit = defineEmits(["saved"]);

const items = ref([]);
const loading = ref(false);
const errorMsg = ref("");
const notice = ref("");

// 两个编辑态：本地条目 / 远程源
const editing = ref(null); // { id: "new"|number, type: "local", title, content, category, tags }
const editingRemote = ref(null); // { id: "new"|number, type: "remote", name, url, sourceType, enabled, priority }
const testing = ref(false);
const testResult = ref("");

const SOURCE_TYPES = [
    { value: "mediawiki", label: "MediaWiki（维基类 API）" },
    { value: "markdown", label: "Markdown 页面" },
    { value: "html", label: "普通网页" },
    { value: "rss", label: "RSS / Atom 订阅" },
];

const localItems = () => items.value.filter((e) => e.type !== "remote");
const remoteItems = () => items.value.filter((e) => e.type === "remote");

async function load() {
    loading.value = true;
    errorMsg.value = "";
    try {
        const d = await api.listKb();
        items.value = d.items || [];
    } catch (e) {
        errorMsg.value = e.authFailed ? "口令不对，请重新进入" : e.message || "读取失败";
    } finally {
        loading.value = false;
    }
}

function startAddLocal() {
    editing.value = { id: "new", type: "local", title: "", content: "", category: "", tags: [] };
    editingRemote.value = null;
    notice.value = "";
}

function startEditLocal(e) {
    editing.value = JSON.parse(JSON.stringify({ ...e, tags: e.tags || [] }));
    editingRemote.value = null;
    notice.value = "";
}

function startAddRemote() {
    editingRemote.value = {
        id: "new",
        type: "remote",
        name: "",
        url: "",
        sourceType: "mediawiki",
        enabled: true,
        priority: 6,
    };
    editing.value = null;
    notice.value = "";
}

function startEditRemote(e) {
    editingRemote.value = JSON.parse(JSON.stringify({ ...e }));
    editing.value = null;
    notice.value = "";
}

function cancelEdit() {
    editing.value = null;
    editingRemote.value = null;
    testResult.value = "";
}

async function saveLocal() {
    const f = editing.value;
    if (!f.title.trim() || !f.content.trim()) {
        errorMsg.value = "标题和内容都要填";
        return;
    }
    errorMsg.value = "";
    try {
        const payload = {
            type: "local",
            title: f.title,
            content: f.content,
            category: f.category,
            tags: f.tags,
        };
        if (f.id === "new") await api.addKb(payload);
        else await api.updateKb(f.id, payload);
        notice.value = "已保存";
        await load();
        emit("saved");
        editing.value = null;
    } catch (e) {
        errorMsg.value = e.authFailed ? "口令不对，请重新进入" : e.message || "保存失败";
    }
}

async function saveRemote() {
    const f = editingRemote.value;
    if (!f.name.trim() || !f.url.trim()) {
        errorMsg.value = "名字和地址都要填";
        return;
    }
    errorMsg.value = "";
    try {
        const payload = {
            type: "remote",
            name: f.name,
            url: f.url,
            sourceType: f.sourceType,
            enabled: f.enabled,
            priority: f.priority,
        };
        if (f.id === "new") await api.addKb(payload);
        else await api.updateKb(f.id, payload);
        notice.value = "已保存";
        await load();
        emit("saved");
        editingRemote.value = null;
    } catch (e) {
        errorMsg.value = e.authFailed ? "口令不对，请重新进入" : e.message || "保存失败";
    }
}

async function remove(e) {
    const label = e.type === "remote" ? `远程源「${e.name}」` : `知识「${e.title}」`;
    if (!confirm(`删掉${label}？删了就找不回来了。`)) return;
    try {
        await api.deleteKb(e.id);
        notice.value = "已删除";
        await load();
    } catch (err) {
        errorMsg.value = err.authFailed ? "口令不对，请重新进入" : err.message || "删除失败";
    }
}

/** 试抓远程源：填了地址就能立刻知道通不通，不用等聊天时才发现。 */
async function testRemote() {
    const f = editingRemote.value;
    if (!f.url.trim()) {
        testResult.value = "先填地址";
        return;
    }
    testing.value = true;
    testResult.value = "";
    try {
        const res = await fetch("/api/kb/probe", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Admin-Token": getToken(),
            },
            body: JSON.stringify({ url: f.url, sourceType: f.sourceType }),
        });
        const j = await res.json();
        if (j.ok) testResult.value = `连通正常，抓到了 ${j.count ?? 0} 条`;
        else testResult.value = `连不上：${j.message || "未知原因"}`;
    } catch {
        testResult.value = "测试请求失败";
    } finally {
        testing.value = false;
    }
}

onMounted(load);
</script>

<template>
  <section class="card wide">
    <h2>知识库</h2>
    <p class="card-desc">
      告诉它一些事实，聊天时它会参考。<b>本地知识</b>写下来就生效；<b>远程源</b>是检索时实时去抓的地址。
      和桌宠版共用同一份知识库。
    </p>

    <div class="section-head">
      <h3>本地知识</h3>
      <button class="mini primary" @click="startAddLocal">＋ 添加知识</button>
    </div>

    <div v-if="localItems().length === 0" class="dim">还没有本地知识。</div>
    <div v-for="e in localItems()" :key="e.id" class="list-item">
      <div class="list-main">
        <div class="list-title">
          <strong>{{ e.title }}</strong>
          <span v-if="e.category" class="pill">{{ e.category }}</span>
        </div>
        <div class="list-desc clamp">{{ e.content }}</div>
        <div v-if="e.tags?.length" class="tags">
          <span v-for="t in e.tags" :key="t" class="tag">#{{ t }}</span>
        </div>
      </div>
      <div class="list-ops">
        <button class="mini" @click="startEditLocal(e)">编辑</button>
        <button class="mini danger" @click="remove(e)">删除</button>
      </div>
    </div>

    <div class="section-head">
      <h3>远程源</h3>
      <button class="mini primary" @click="startAddRemote">＋ 添加远程源</button>
    </div>

    <div v-if="remoteItems().length === 0" class="dim">还没有远程源。</div>
    <div v-for="e in remoteItems()" :key="e.id" class="list-item">
      <div class="list-main">
        <div class="list-title">
          <strong>{{ e.name }}</strong>
          <span class="pill">{{ e.enabled ? "已启用" : "已停用" }}</span>
        </div>
        <div class="list-desc dim">{{ e.url }}</div>
      </div>
      <div class="list-ops">
        <button class="mini" @click="startEditRemote(e)">编辑</button>
        <button class="mini danger" @click="remove(e)">删除</button>
      </div>
    </div>

    <p v-if="notice" class="notice">{{ notice }}</p>
    <p v-if="errorMsg" class="error">{{ errorMsg }}</p>

    <!-- 本地条目编辑 -->
    <div v-if="editing" class="edit-box">
      <h3>{{ editing.id === "new" ? "添加知识" : "编辑知识" }}</h3>
      <label class="field-label">标题</label>
      <input v-model="editing.title" maxlength="120" placeholder="例如：英梨梨的正确出处" />
      <label class="field-label">内容</label>
      <textarea
        v-model="editing.content"
        class="text-area"
        rows="5"
        maxlength="20000"
        placeholder="你要让它记住的事实，例如：英梨梨是《路人女主的养成方法》里的泽村·斯宾塞·英梨梨。"
      ></textarea>
      <label class="field-label">分类（可选）</label>
      <input v-model="editing.category" maxlength="40" placeholder="例如：ACGN / 化学 / 历史" />
      <label class="field-label">标签（可选，逗号分隔）</label>
      <input
        :value="(editing.tags || []).join(', ')"
        placeholder="例如：角色, 动漫"
        @input="editing.tags = $event.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean)"
      />
      <div class="edit-ops">
        <button class="primary" @click="saveLocal">保存</button>
        <button class="ghost" @click="cancelEdit">取消</button>
      </div>
    </div>

    <!-- 远程源编辑 -->
    <div v-if="editingRemote" class="edit-box">
      <h3>{{ editingRemote.id === "new" ? "添加远程源" : "编辑远程源" }}</h3>
      <label class="field-label">名字</label>
      <input v-model="editingRemote.name" maxlength="60" placeholder="我的博客" />
      <label class="field-label">地址</label>
      <input v-model="editingRemote.url" placeholder="https://my.wiki.com/api.php" />
      <label class="field-label">类型</label>
      <select v-model="editingRemote.sourceType">
        <option v-for="t in SOURCE_TYPES" :key="t.value" :value="t.value">{{ t.label }}</option>
      </select>
      <label class="field-label">优先级（数字越小越靠前）</label>
      <input v-model.number="editingRemote.priority" type="number" min="1" max="99" placeholder="6" />
      <label class="checkbox-row">
        <input type="checkbox" v-model="editingRemote.enabled" />
        <span>启用这个远程源</span>
      </label>
      <p v-if="testResult" class="notice">{{ testResult }}</p>
      <div class="edit-ops">
        <button class="primary" @click="saveRemote">保存</button>
        <button class="ghost" :disabled="testing" @click="testRemote">
          {{ testing ? "测试中…" : "测试连通" }}
        </button>
        <button class="ghost" @click="cancelEdit">取消</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 18px 0 8px;
}
.section-head h3 {
    margin: 0;
    font-size: 14px;
}
.clamp {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
}
.tags {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-top: 4px;
}
.tag {
    font-size: 11px;
    color: var(--dim);
    background: var(--bg);
    border-radius: 5px;
    padding: 1px 6px;
}
.tools-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 14px;
}
.tool-row {
    display: grid;
    grid-template-columns: 1fr 1fr auto;
    gap: 8px;
    margin-bottom: 8px;
}
</style>
