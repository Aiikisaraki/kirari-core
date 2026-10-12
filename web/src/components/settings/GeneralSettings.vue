<script setup>
// 通用设置：助手备注名。
// 排除项：开机自动启动（那是桌宠本体独有的，核心版是服务，交给系统服务/容器管）。
//
// 存哪儿：pet-client.config.json 的 petName —— 桌宠版读写的就是这一个键。
// 之前存在浏览器 localStorage 里，结果桌宠版改了名字核心版看不到、换台浏览器
// 又变回默认值；现在两边同一份文件，桌宠里改成什么，控制台打开就是什么。
import { ref, onMounted } from "vue";
import { api } from "../../api.js";

const props = defineProps({ modelValue: { type: String, default: "Kirari" } });
const emit = defineEmits(["update:modelValue", "saved"]);

const petName = ref(props.modelValue || "Kirari");
const saving = ref(false);
const errorMsg = ref("");

onMounted(async () => {
    try {
        const r = await api.getPetName();
        if (r?.petName) {
            petName.value = r.petName;
            emit("update:modelValue", r.petName);
        }
    } catch {
        /* 读不到就用父组件传来的值，不挡住编辑 */
    }
});

async function save() {
    const v = petName.value.trim();
    if (!v) {
        errorMsg.value = "备注名不能为空";
        return;
    }
    if (v.length > 16) {
        errorMsg.value = "备注名太长了（16 字以内）";
        return;
    }
    saving.value = true;
    errorMsg.value = "";
    try {
        const r = await api.savePetName(v);
        const saved = r?.petName || v;
        petName.value = saved;
        emit("update:modelValue", saved);
        emit("saved");
    } catch (e) {
        errorMsg.value = e.message || "保存失败，请重试";
    } finally {
        saving.value = false;
    }
}
</script>

<template>
  <section class="card">
    <h2>通用</h2>
    <p class="card-desc">助手备注名。聊天窗口顶部会显示这个名字；和桌宠版共用同一份设置。</p>

    <div class="row">
      <div class="row-text">
        <h3>备注名</h3>
        <p>聊天窗口顶部会显示这个名字；默认 Kirari。</p>
      </div>
      <div class="row-control">
        <input
          v-model="petName"
          class="text-input"
          type="text"
          maxlength="16"
          placeholder="例如：绮莉、Kirari、小K…"
          :disabled="saving"
          @keyup.enter="save"
        />
      </div>
    </div>

    <p v-if="errorMsg" class="error">{{ errorMsg }}</p>
    <div class="actions">
      <button class="btn" :disabled="saving" @click="save">{{ saving ? "保存中…" : "保存" }}</button>
    </div>
  </section>
</template>
