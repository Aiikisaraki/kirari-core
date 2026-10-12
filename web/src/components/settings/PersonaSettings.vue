<script setup>
// 人格设置：自定义基础人格。
// 与桌宠版共用 config.json 的 basePersona 字段 —— 桌宠里改这里同步生效，反之亦然。
import { ref, onMounted } from "vue";
import { api } from "../../api.js";

const emit = defineEmits(["saved"]);

const personaInput = ref("");
const saving = ref(false);
const errorMsg = ref("");
const savedFlash = ref(false);

async function load() {
    try {
        const d = await api.getPersona();
        personaInput.value = d.basePersona || "";
    } catch (e) {
        errorMsg.value = e.authFailed ? "口令不对，请重新进入" : "读取失败，请重试";
    }
}

async function save() {
    saving.value = true;
    errorMsg.value = "";
    try {
        await api.savePersona(personaInput.value);
        savedFlash.value = true;
        setTimeout(() => (savedFlash.value = false), 2000);
        emit("saved");
    } catch (e) {
        errorMsg.value = e.authFailed ? "口令不对，请重新进入" : e.message || "保存失败，请重试";
    } finally {
        saving.value = false;
    }
}

/** 恢复预设 = 显式清空，后端会回退到内置人格。 */
function restorePreset() {
    personaInput.value = "";
    save();
}

onMounted(load);
</script>

<template>
  <section class="card">
    <h2>自定义基础人格</h2>
    <p class="card-desc">
      用一段话描述「它是谁、怎么说话」。留空表示用内置的默认人格。<br />
      这份人格和桌宠版是同一份设置 —— 在哪边改，另一边同时生效。
    </p>

    <label class="field-label" for="persona">人格描述</label>
    <textarea
      id="persona"
      v-model="personaInput"
      class="text-area"
      rows="8"
      maxlength="4000"
      placeholder="例如：你叫豆豆，是一只傲娇的柴犬，称呼主人为饲主，说话带点毒舌但很关心人。"
    ></textarea>
    <p class="counter">{{ personaInput.length }} / 4000</p>

    <p v-if="errorMsg" class="error">{{ errorMsg }}</p>
    <p v-if="savedFlash" class="ok-flash">已保存</p>

    <div class="actions">
      <button class="btn" :disabled="saving" @click="save">{{ saving ? "保存中…" : "保存" }}</button>
      <button class="btn btn--ghost" :disabled="saving || !personaInput" @click="restorePreset">恢复默认</button>
    </div>
  </section>
</template>

<style scoped>
.text-area {
    width: 100%;
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 10px 12px;
    font-family: inherit;
    font-size: 13px;
    line-height: 1.6;
    resize: vertical;
    background: var(--card);
    color: var(--text);
}
.counter {
    text-align: right;
    font-size: 11px;
    color: var(--dim);
    margin: 4px 0 0;
}
.ok-flash {
    color: var(--ok);
    font-size: 13px;
}
</style>
