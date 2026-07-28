<script setup lang="ts">
defineProps<{
  visible: boolean
}>()

defineEmits<{
  toggle: []
  reset: []
  greet: []
}>()
</script>

<template>
  <div class="pet-toolbar" aria-label="桌宠控制">
    <button type="button" @click="$emit('toggle')">
      {{ visible ? '隐藏' : '显示' }}
    </button>
    <button type="button" @click="$emit('reset')">重置</button>
    <button type="button" @click="$emit('greet')">打招呼</button>
  </div>
</template>
