<script setup>
// 个人设置：我的头像（聊天里代表你的那张图）。
//
// 与桌宠版严格同构：图片存在服务端 userData/user-avatar/avatar<ext>，
// pet-client.config.json 里只存一句 useravatar://avatar<ext> 的引用。
// 以前放在浏览器 localStorage 里 —— 换个浏览器就没了，桌宠版更是完全看不到；
// 现在桌宠端设的头像核心版控制台直接显示，反过来也一样。
import { ref, onMounted, onBeforeUnmount } from "vue";
import { api } from "../../api.js";

const emit = defineEmits(["saved"]);

const avatar = ref(""); // 预览用的 blob URL
const isPicking = ref(false);
const saving = ref(false);
const errorMsg = ref("");
let objectUrl = "";

function releaseUrl() {
    if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
        objectUrl = "";
    }
}

async function load() {
    try {
        releaseUrl();
        const url = await api.getAvatarBlobUrl();
        objectUrl = url || "";
        avatar.value = url || "";
    } catch {
        avatar.value = "";
    }
}

function handlePick() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
        const f = input.files?.[0];
        if (!f) return;
        if (!f.type.startsWith("image/")) {
            errorMsg.value = "只能选图片文件";
            return;
        }
        if (f.size > 5 * 1024 * 1024) {
            errorMsg.value = "图片太大了（5MB 以内）";
            return;
        }
        isPicking.value = true;
        const reader = new FileReader();
        reader.onload = async () => {
            isPicking.value = false;
            await upload(String(reader.result || ""));
        };
        reader.onerror = () => {
            isPicking.value = false;
            errorMsg.value = "读取图片失败，换一张试试";
        };
        reader.readAsDataURL(f);
    };
    input.click();
}

async function upload(dataUrl) {
    if (!dataUrl) return;
    saving.value = true;
    errorMsg.value = "";
    try {
        await api.saveAvatar(dataUrl);
        await load();
        emit("saved");
    } catch (e) {
        errorMsg.value = e.message || "保存失败，请重试";
    } finally {
        saving.value = false;
    }
}

async function remove() {
    saving.value = true;
    errorMsg.value = "";
    try {
        await api.clearAvatar();
        await load();
        emit("saved");
    } catch (e) {
        errorMsg.value = e.message || "移除失败，请重试";
    } finally {
        saving.value = false;
    }
}

onMounted(load);
onBeforeUnmount(releaseUrl);
</script>

<template>
  <section class="card">
    <h2>我的头像</h2>
    <p class="card-desc">
      聊天时代表你的头像。图片存在服务端数据目录的 user-avatar 文件夹里，和桌宠版是同一张。
    </p>

    <div class="profile-head">
      <div class="avatar-preview">
        <img v-if="avatar" :src="avatar" alt="我的头像" />
        <div v-else class="avatar-placeholder">你</div>
      </div>
      <div class="profile-actions">
        <button type="button" class="btn" :disabled="isPicking || saving" @click="handlePick">
          {{ isPicking ? "选择中…" : saving ? "保存中…" : avatar ? "更换图片" : "选择图片" }}
        </button>
        <button v-if="avatar" type="button" class="btn btn--ghost" :disabled="saving" @click="remove">移除</button>
      </div>
    </div>

    <p v-if="errorMsg" class="error">{{ errorMsg }}</p>
  </section>
</template>

<style scoped>
.profile-head {
    display: flex;
    align-items: center;
    gap: 20px;
    margin: 8px 0 4px;
}
.avatar-preview {
    width: 76px;
    height: 76px;
    border-radius: 50%;
    overflow: hidden;
    background: var(--bg);
    border: 1px solid var(--line);
    display: flex;
    align-items: center;
    justify-content: center;
    flex: none;
}
.avatar-preview img {
    width: 100%;
    height: 100%;
    object-fit: cover;
}
.avatar-placeholder {
    font-size: 26px;
    color: var(--dim);
}
.profile-actions {
    display: flex;
    gap: 10px;
}
</style>
