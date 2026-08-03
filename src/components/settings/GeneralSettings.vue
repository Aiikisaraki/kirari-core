<script setup lang="ts">
import { onMounted, ref } from "vue";

const autoLaunch = ref(false);
const autoLaunchBusy = ref(false);
const petName = ref("Kirari");
const petNameSaving = ref(false);

type WindowApi = {
    getAutoLaunch?: () => Promise<boolean>;
    setAutoLaunch?: (e: boolean) => Promise<void>;
    getPetName?: () => Promise<string>;
    setPetName?: (n: string) => Promise<void>;
    onPetNameChanged?: (cb: (name: string) => void) => void;
};

function api(): WindowApi | undefined {
    return (window as unknown as { windowApi?: WindowApi }).windowApi;
}

async function loadAutoLaunch() {
    try {
        const a = api();
        if (a?.getAutoLaunch) autoLaunch.value = await a.getAutoLaunch();
    } catch {
        /* 读取失败则不勾选 */
    }
}

async function loadPetName() {
    try {
        const a = api();
        if (a?.getPetName) petName.value = (await a.getPetName()) || "Kirari";
        a?.onPetNameChanged?.((name) => {
            petName.value = name || "Kirari";
        });
    } catch {
        /* 忽略 */
    }
}

async function handlePetNameChange() {
    const name = petName.value.trim() || "Kirari";
    petName.value = name;
    const a = api();
    if (!a?.setPetName) return;
    petNameSaving.value = true;
    try {
        await a.setPetName(name);
    } catch {
        /* 保存失败时界面已回写 */
    } finally {
        petNameSaving.value = false;
    }
}

async function handleAutoLaunchChange() {
    autoLaunchBusy.value = true;
    try {
        await api()?.setAutoLaunch?.(autoLaunch.value);
    } catch {
        /* 忽略 */
    } finally {
        autoLaunchBusy.value = false;
    }
}

onMounted(() => {
    loadAutoLaunch();
    loadPetName();
});
</script>

<template>
    <section id="general" class="settings-card">
        <h3 class="settings-card__title">
            <span class="title-emoji">✨</span>
            <span>通用</span>
        </h3>

        <div class="field">
            <label class="field-label" for="petName">桌宠备注名</label>
            <input
                id="petName"
                v-model="petName"
                class="text-input"
                type="text"
                autocomplete="off"
                placeholder="例如：绮莉、Kirari、小K…"
                maxlength="16"
                :disabled="petNameSaving"
                @change="handlePetNameChange"
                @keyup.enter="handlePetNameChange"
            />
            <p class="settings-hint">
                设置后，聊天窗口顶部会显示这个名字（默认 Kirari）。
            </p>
        </div>

        <div class="divider"></div>

        <label class="checkbox-row">
            <input
                type="checkbox"
                v-model="autoLaunch"
                :disabled="autoLaunchBusy"
                @change="handleAutoLaunchChange"
            />
            <span>开机自动启动</span>
        </label>
        <p class="settings-hint">勾选后，系统登录时会自动启动 Kirari绮莉。</p>
    </section>
</template>
