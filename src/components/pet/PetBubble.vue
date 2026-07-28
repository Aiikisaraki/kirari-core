<script setup lang="ts">
defineProps<{
    message: string;
    visible: boolean;
    interactive: boolean;
}>();

defineEmits<{
    openChat: [];
    dismiss: [];
}>();
</script>

<template>
    <button
        v-if="visible && interactive"
        type="button"
        class="pet-bubble is-actionable"
        @click="$emit('openChat')"
    >
        {{ message }}
    </button>
    <button
        v-else-if="visible"
        type="button"
        class="pet-bubble"
        @click="$emit('dismiss')"
    >
        {{ message }}
    </button>
</template>
