<script setup lang="ts">
import ChatWindow from './components/chat/ChatWindow.vue'
import PetStage from './components/pet/PetStage.vue'
import ApiTokenSettings from './components/settings/ApiTokenSettings.vue'

const windowType = new URLSearchParams(window.location.search).get('window')
const isChatWindow = windowType === 'chat'
const isSettingsWindow = windowType === 'settings'
</script>

<template>
  <ApiTokenSettings v-if="isSettingsWindow" />
  <ChatWindow v-else-if="isChatWindow" />
  <main v-else class="desktop-pet-app" aria-label="Kirari绮莉 桌宠">
    <PetStage />
  </main>
</template>
