<script setup lang="ts">
import { THEMES, useThemeStore } from "../../stores/theme";

const themeStore = useThemeStore();
</script>

<template>
    <section id="appearance" class="settings-card">
        <h3 class="settings-card__title">
            <span class="title-emoji">🎨</span>
            <span>外观主题</span>
        </h3>
        <p class="settings-card__desc">
            对话框与设置界面的视觉风格，切换即时生效并自动保存。
        </p>
        <div class="theme-grid">
            <button
                v-for="t in THEMES"
                :key="t.id"
                type="button"
                class="theme-card"
                :class="{ 'is-active': themeStore.current === t.id }"
                @click="themeStore.setTheme(t.id)"
            >
                <span class="theme-swatch" :class="'swatch-' + t.id" aria-hidden="true" />
                <span class="theme-card__text">
                    <span class="theme-card__label">{{ t.label }}</span>
                    <span class="theme-card__sub">{{ t.sub }}</span>
                </span>
                <span v-if="themeStore.current === t.id" class="theme-card__check" aria-hidden="true">✓</span>
            </button>
        </div>
    </section>
</template>
