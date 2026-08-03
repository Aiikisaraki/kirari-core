<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = defineProps<{
    sections: { id: string; label: string; emoji: string }[];
    activeId?: string;
}>();
const emit = defineEmits<{
    "update:activeId": [id: string];
}>();

const active = ref(props.activeId ?? props.sections[0]?.id ?? "");
let observer: IntersectionObserver | null = null;
let emitTimer: ReturnType<typeof setTimeout> | null = null;
let userScrollingTimer: ReturnType<typeof setTimeout> | null = null;
let userScrolling = false;

/**
 * 计算点击跳转的目标 scrollTop。
 * 关键修复：不调用 el.scrollIntoView()，避免它在嵌套滚动场景下
 * 把外层 window 一起滚（会把 WindowChrome 顶出视口）。
 * 改用 .settings-main.scrollTo()，并显式把目标 section 顶到 sticky 头下方。
 */
function go(id: string) {
    const container = document.querySelector(".settings-main") as HTMLElement | null;
    const target = document.getElementById(id);
    if (!container || !target) return;
    // 目标 section 相对 scroll 容器的偏移（容器的 border 内边距外）
    const top = target.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    // 顶部 sticky 头（.settings-top）高度，用 scroll-margin 补偿
    const header = document.querySelector(".settings-top") as HTMLElement | null;
    const offset = header ? header.offsetHeight + 12 : 12;
    // 用户主动点击 nav 时，先暂停 IntersectionObserver 一小段时间，
    // 避免滚动过程中误把别的 section 当成 active。
    userScrolling = true;
    if (userScrollingTimer) clearTimeout(userScrollingTimer);
    container.scrollTo({ top: Math.max(0, top - offset), behavior: "smooth" });
    active.value = id;
    emit("update:activeId", id);
    userScrollingTimer = setTimeout(() => {
        userScrolling = false;
    }, 450);
}

function emitActive(id: string) {
    if (emitTimer) clearTimeout(emitTimer);
    emitTimer = setTimeout(() => {
        if (userScrolling) return; // 主动点击时由 go() 直接 emit
        emit("update:activeId", id);
    }, 80);
}

onMounted(() => {
    const container = document.querySelector(".settings-main") as HTMLElement | null;
    if (!container) return;
    observer = new IntersectionObserver(
        (entries) => {
            if (userScrolling) return;
            const visible = entries
                .filter((e) => e.isIntersecting)
                .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
            if (visible[0]) {
                const id = visible[0].target.id;
                if (id !== active.value) {
                    active.value = id;
                    emitActive(id);
                }
            }
        },
        {
            root: container as unknown as Element,
            threshold: [0.2, 0.5, 0.8],
            // 顶部按 sticky 头 + 12px 边距收缩，底部保留少量 buffer
            rootMargin: "-80px 0px -40% 0px",
        },
    );
    props.sections.forEach((s) => {
        const el = document.getElementById(s.id);
        if (el) observer!.observe(el);
    });
});

watch(active, (v) => {
    // go() 已直接 emit；这里只在 active 真正变化时 emit，避免循环
    if (v) emit("update:activeId", v);
});
watch(() => props.activeId, (v) => {
    if (v && v !== active.value) active.value = v;
});

onBeforeUnmount(() => {
    observer?.disconnect();
    if (emitTimer) clearTimeout(emitTimer);
    if (userScrollingTimer) clearTimeout(userScrollingTimer);
});
</script>

<template>
    <nav class="settings-nav" aria-label="设置分区导航">
        <button
            v-for="s in sections"
            :key="s.id"
            type="button"
            class="settings-nav__item"
            :class="{ 'is-active': active === s.id }"
            :title="s.label"
            :aria-label="s.label"
            :aria-current="active === s.id ? 'true' : undefined"
            @click="go(s.id)"
        >
            <span class="nav-emoji" aria-hidden="true">{{ s.emoji }}</span>
            <span class="visually-hidden">{{ s.label }}</span>
        </button>
    </nav>
</template>
