<script setup>
// 大脑设置：多套模型 + 搜索渠道。
// 与桌宠版「模型」设置页完全等价 —— 同一份 config.json，在哪边改另一边同步。
import { ref, onMounted } from "vue";
import { api } from "../../api.js";

const props = defineProps({ brainReady: { type: Boolean, default: null } });
const emit = defineEmits(["saved"]);

// 每套模型 = 名字 + 服务地址 + 型号 + 密钥。列表里选一套当前使用，聊天就走那套。
const models = ref([]);
const activeId = ref(null);
const modelsLoading = ref(false);
// 编辑中：null = 没在编辑；"new" = 新增；数字 = 编辑那一套的 id
const editing = ref(null);
const modelsError = ref("");
const modelsNotice = ref("");

async function loadModels() {
    modelsLoading.value = true;
    modelsError.value = "";
    try {
        const d = await api.listModels();
        models.value = d.items || [];
        activeId.value = d.activeId ?? null;
    } catch (e) {
        modelsError.value = e.authFailed ? "口令不对" : e.message || "读取失败";
    } finally {
        modelsLoading.value = false;
    }
}

function startAdd() {
    editing.value = { id: "new", name: "", endpoint: "", model: "", key: "" };
    modelsNotice.value = "";
}

function startEdit(m) {
    // 密钥不回填明文，留空 = 不改
    editing.value = { id: m.id, name: m.name, endpoint: m.endpoint, model: m.model, key: "" };
    modelsNotice.value = "";
}

function cancelEdit() {
    editing.value = null;
}

async function saveEdit() {
    if (!editing.value) return;
    modelsError.value = "";
    const f = editing.value;
    const payload = { name: f.name, endpoint: f.endpoint, model: f.model };
    try {
        if (f.id === "new") {
            payload.key = f.key;
            const r = await api.addModel(payload);
            modelsNotice.value = "已添加";
            await loadModels();
            // 第一套自动成为当前使用；之后加的不动当前选择
            if (activeId.value == null && r.id) {
                await api.setActiveModel(r.id);
                await loadModels();
            }
        } else {
            if (f.key.trim()) payload.key = f.key.trim();
            await api.updateModel(f.id, payload);
            modelsNotice.value = "已保存，下一条消息就生效";
            await loadModels();
        }
        emit("saved");
        editing.value = null;
    } catch (e) {
        modelsError.value = e.authFailed ? "口令不对" : e.message || "保存失败";
    }
}

async function setActive(m) {
    modelsError.value = "";
    try {
        await api.setActiveModel(m.id);
        modelsNotice.value = `已切换到「${m.name}」，下一条消息就生效`;
        await loadModels();
        emit("saved");
    } catch (e) {
        modelsError.value = e.authFailed ? "口令不对" : e.message || "切换失败";
    }
}

async function removeModel(m) {
    if (!confirm(`删掉「${m.name}」？删了就找不回来了。`)) return;
    modelsError.value = "";
    try {
        await api.deleteModel(m.id);
        modelsNotice.value = "已删除";
        await loadModels();
    } catch (e) {
        modelsError.value = e.authFailed ? "口令不对" : e.message || "删除失败";
    }
}

// ── 搜索（渠道配置，不跟着模型套走）──
const searchForm = ref({ searchProvider: "", searchEndpoint: "", searchKey: "" });
const searchMasked = ref({ searchKeyMasked: "", hasSearchKey: false });
const savingSearch = ref(false);
const searchNotice = ref("");
const searchError = ref("");

async function loadSearch() {
    try {
        const s = await api.getSettings();
        searchForm.value.searchProvider = s.searchProvider || "";
        searchForm.value.searchEndpoint = s.searchEndpoint || "";
        searchMasked.value = {
            searchKeyMasked: s.searchKeyMasked || "",
            hasSearchKey: Boolean(s.hasSearchKey),
        };
    } catch {
        /* 搜索配置读不到不挡模型区 */
    }
}

async function saveSearch() {
    savingSearch.value = true;
    searchNotice.value = "";
    searchError.value = "";
    try {
        const patch = { searchProvider: searchForm.value.searchProvider };
        if (searchForm.value.searchEndpoint) patch.searchEndpoint = searchForm.value.searchEndpoint;
        if (searchForm.value.searchKey.trim()) patch.searchKey = searchForm.value.searchKey.trim();
        await api.saveSettings(patch);
        searchForm.value.searchKey = "";
        searchNotice.value = "已保存";
        await loadSearch();
        emit("saved");
    } catch (e) {
        searchError.value = e.authFailed ? "口令不对" : e.message || "保存失败";
    } finally {
        savingSearch.value = false;
    }
}

onMounted(() => {
    loadModels();
    loadSearch();
});
</script>

<template>
  <div class="settings">
    <section class="card wide">
      <h2>
        大脑
        <span v-if="brainReady === true" class="pill ok">已连接</span>
        <span v-else-if="brainReady === false" class="pill bad">还没连上</span>
      </h2>
      <p class="hint">可以配好几套大脑（不同的服务地址、型号、钥匙），随时切换当前用哪套。打「●」的就是聊天正在用的。</p>

      <div v-if="modelsLoading && models.length === 0" class="dim">读取中…</div>
      <div v-else-if="models.length === 0 && !editing" class="dim">
        还没配过大脑。点下面的「添加一套」填上服务地址和钥匙就能聊。
      </div>
      <div v-for="m in models" :key="m.id" class="model-item" :class="{ active: m.id === activeId }">
        <div class="model-main">
          <div class="model-name">
            <span v-if="m.id === activeId" class="dot ok" title="当前使用" />
            {{ m.name }}
            <span v-if="m.id === activeId" class="pill ok">使用中</span>
          </div>
          <div class="model-meta">{{ m.model }} · {{ m.endpoint }}</div>
          <div class="model-meta dim">{{ m.hasKey ? `钥匙 ${m.keyMasked}` : "⚠ 还没填钥匙" }}</div>
        </div>
        <div class="model-ops">
          <button v-if="m.id !== activeId" class="mini primary" @click="setActive(m)">设为当前</button>
          <button class="mini" @click="startEdit(m)">编辑</button>
          <button class="mini danger" @click="removeModel(m)">删除</button>
        </div>
      </div>

      <p v-if="modelsNotice" class="notice">{{ modelsNotice }}</p>
      <p v-if="modelsError" class="error">{{ modelsError }}</p>

      <div v-if="editing" class="edit-box">
        <h3>{{ editing.id === "new" ? "添加一套大脑" : "编辑这套大脑" }}</h3>
        <label>名字</label>
        <input v-model="editing.name" maxlength="40" placeholder="自己起个好认的，例如「便宜快档」" />
        <label>服务地址</label>
        <input v-model="editing.endpoint" placeholder="例如 https://api.example.com/v1" />
        <label>型号</label>
        <input v-model="editing.model" placeholder="例如 gpt-5.4-mini" />
        <label>钥匙</label>
        <input
          v-model="editing.key"
          type="password"
          :placeholder="editing.id === 'new' ? '这家服务给你的钥匙' : '留空表示不改'"
        />
        <div class="edit-ops">
          <button class="primary" :disabled="modelsLoading" @click="saveEdit">保存</button>
          <button class="ghost" @click="cancelEdit">取消</button>
        </div>
      </div>

      <button v-else class="ghost add-btn" @click="startAdd">＋ 添加一套</button>
    </section>

    <section class="card">
      <h2>搜索</h2>
      <p class="hint">回答实时问题（天气、新闻之类）时用的查证渠道，可选。所有大脑共用这一套。</p>

      <label>搜索来源</label>
      <select v-model="searchForm.searchProvider">
        <option value="">不用</option>
        <option value="uapis">UAPIs</option>
        <option value="tavily">Tavily</option>
        <option value="searxng">自建聚合搜索</option>
      </select>

      <template v-if="searchForm.searchProvider === 'searxng'">
        <label>搜索服务地址</label>
        <input v-model="searchForm.searchEndpoint" placeholder="例如 http://192.168.57.x:8888" />
      </template>

      <template v-if="searchForm.searchProvider === 'tavily' || searchForm.searchProvider === 'uapis'">
        <label>搜索钥匙</label>
        <input
          v-model="searchForm.searchKey"
          type="password"
          :placeholder="searchMasked.hasSearchKey ? `已设置（${searchMasked.searchKeyMasked}），留空表示不改` : '还没设置'"
        />
      </template>

      <p v-if="searchNotice" class="notice">{{ searchNotice }}</p>
      <p v-if="searchError" class="error">{{ searchError }}</p>
      <button class="primary" :disabled="savingSearch" @click="saveSearch">
        {{ savingSearch ? "保存中…" : "保存搜索设置" }}
      </button>
    </section>
  </div>
</template>
