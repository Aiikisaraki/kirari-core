<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useChatSocket } from '../../composables/useChatSocket'
import { usePetStore } from '../../stores/pet'
import { useAvatarStore } from '../../stores/avatar'
import type { AvatarState } from '../../pet/avatar/types'
import PetAvatar from './PetAvatar.vue'
import PetBubble from './PetBubble.vue'
import PetQuickMenu from './PetQuickMenu.vue'
type DesktopPetChannel =
  | 'desktop-pet:drag-start'
  | 'desktop-pet:drag-move'
  | 'desktop-pet:drag-end'
  | 'desktop-pet:open-chat'
  | 'desktop-pet:show-context-menu'

type DesktopPetIpc = {
  send(channel: DesktopPetChannel): void
  on(channel: string, listener: (...args: unknown[]) => void): void
}

declare global {
  interface Window {
    require?: (module: 'electron') => { ipcRenderer: DesktopPetIpc }
  }
}

const petStore = usePetStore()
const avatarStore = useAvatarStore()
const { isVisible, message, setMessage } = petStore
const { bubbleMessage, bubbleInteractive, messages, unreadCount } = useChatSocket()
const ipcRenderer = window.require?.('electron').ipcRenderer

/* ===================== 状态机调度器 ===================== */
// 优先级：说话 > 高兴 > 招手 > 瞌睡 > 眨眼 > 待机。
// 低优先级状态不能打断高优先级（豆包互斥规则）；瞌睡的打断走专门的 markActivity/wakeUp。
const PRIORITY: Record<AvatarState, number> = {
  idle: 0,
  blink: 10,
  sleepy: 20,
  wave: 40,
  happy: 60,
  speak: 100,
}

// durations 由 PetAvatar 加载 frames.json 后回填；此处给一次性动画一个兜底估计。
const FALLBACK_DUR: Partial<Record<AvatarState, number>> = {
  blink: 11000,
  wave: 5200,
  happy: 5200,
}
function durationOf(s: AvatarState): number {
  return avatarStore.durations[s] ?? FALLBACK_DUR[s] ?? 0
}

// 当前动画（一次性）播完回 idle 的统一计时器；loop 状态（speak/sleepy/idle）不自动回 idle。
let actionTimer: ReturnType<typeof setTimeout> | null = null

// 请求切换状态，遵守优先级互斥。返回是否成功接管。
function requestState(s: AvatarState): boolean {
  const cur = avatarStore.currentState
  if (PRIORITY[s] < PRIORITY[cur]) return false
  if (actionTimer) {
    clearTimeout(actionTimer)
    actionTimer = null
  }
  avatarStore.setState(s)
  const d = durationOf(s)
  if (d > 0) {
    actionTimer = setTimeout(() => {
      if (avatarStore.currentState === s) avatarStore.setState('idle')
      actionTimer = null
    }, d)
  }
  return true
}

/* ===================== 说话 / 情绪优先 ===================== */
// 收到 pet 新回复即触发：带 emotion 先播情绪动画再说话；否则直接说话。
// 触发源为「messages 新增 pet 消息」，与对话框是否打开无关——
// 旧逻辑依赖 unreadCount（只在对话框关闭时累加），导致开着对话框聊天不播动画。
let speakTimer: ReturnType<typeof setTimeout> | null = null
let primed = false // 跳过首帧历史回灌，避免加载历史消息时误播动画

function playSpeak() {
  requestState('speak') // speak 优先级最高，可打断瞌睡/招手/高兴
  if (speakTimer) clearTimeout(speakTimer)
  speakTimer = setTimeout(() => {
    if (avatarStore.currentState === 'speak') avatarStore.setState('idle')
    maybeHappy(0.12) // 一轮对话结束小概率高兴
  }, 2500)
}

function playEmotionThenSpeak(emo: 'happy' | 'wave') {
  requestState(emo)
  if (speakTimer) clearTimeout(speakTimer)
  if (actionTimer) {
    clearTimeout(actionTimer)
    actionTimer = null
  }
  const d = durationOf(emo) || 1500
  // 情绪动画播完后衔接说话
  actionTimer = setTimeout(() => playSpeak(), d)
}

watch(
  () => messages.value.length,
  (next, prev) => {
    // 跳过首帧历史回灌
    if (!primed) {
      primed = true
      return
    }
    if (next <= prev) return
    // 仅当新增消息里包含 pet 发言才触发说话动画
    const added = messages.value.slice(prev)
    const lastPet = [...added].reverse().find((m) => m.author === 'pet')
    if (!lastPet) return
    const emo = lastPet.emotion
    if (emo === 'happy' || emo === 'wave') {
      playEmotionThenSpeak(emo)
    } else {
      playSpeak()
    }
  },
)

/* ===================== 高兴跳跃 ===================== */
// 触发条件：连续点击桌宠 3 次 / 对话结束小概率 / 唤醒熟睡彩蛋。冷却 3 分钟。
const HAPPY_COOLDOWN = 3 * 60 * 1000
let happyCooldownUntil = 0

function maybeHappy(prob: number) {
  if (Date.now() < happyCooldownUntil) return
  if (avatarStore.currentState === 'happy') return
  if (PRIORITY['happy'] < PRIORITY[avatarStore.currentState]) return // 被更高优先级占用
  if (Math.random() < prob) {
    requestState('happy')
    happyCooldownUntil = Date.now() + HAPPY_COOLDOWN
  }
}

// 连续轻点检测：2.5s 内累计 3 次点击（非拖拽）触发。
let tapCount = 0
let tapResetTimer: ReturnType<typeof setTimeout> | null = null
function handleTap() {
  tapCount += 1
  if (tapResetTimer) clearTimeout(tapResetTimer)
  tapResetTimer = setTimeout(() => {
    tapCount = 0
  }, 2500)
  if (tapCount >= 3) {
    tapCount = 0
    maybeHappy(1) // 必定尝试（仍受冷却限制）
  }
}

/* ===================== 招手 ===================== */
// 随机 40~90s 触发；鼠标悬浮 1s 触发；窗口聚焦触发。冷却 90s。睡醒后才随机。
const WAVE_COOLDOWN = 90 * 1000
let waveCooldownUntil = 0
let waveTimer: ReturnType<typeof setTimeout> | null = null
let hoverTimer: ReturnType<typeof setTimeout> | null = null

function maybeWave(force = false) {
  if (!force && Date.now() < waveCooldownUntil) return
  if (avatarStore.currentState === 'sleepy') return // 瞌睡中不主动招手
  if (PRIORITY['wave'] < PRIORITY[avatarStore.currentState]) return // 被占用
  if (requestState('wave')) {
    waveCooldownUntil = Date.now() + WAVE_COOLDOWN
  }
}

function scheduleWave() {
  const delay = 40000 + Math.random() * 50000
  waveTimer = setTimeout(() => {
    maybeWave()
    scheduleWave()
  }, delay)
}

/* ===================== 打瞌睡 ===================== */
// 闲置 3~5 分钟无交互进入；任意交互立即打断回 idle（并小概率惊喜跳跃）。
let sleepTimer: ReturnType<typeof setTimeout> | null = null
let lastActivity = Date.now()

function scheduleSleepy() {
  if (sleepTimer) clearTimeout(sleepTimer)
  const delay = (3 + Math.random() * 2) * 60 * 1000 // 3~5 分钟
  sleepTimer = setTimeout(() => {
    if (avatarStore.currentState === 'idle') {
      requestState('sleepy')
    } else {
      scheduleSleepy() // 当前忙，稍后重试
    }
  }, delay)
}

function markActivity() {
  lastActivity = Date.now()
  scheduleSleepy()
  if (avatarStore.currentState === 'sleepy') {
    avatarStore.setState('idle') // 惊醒
    maybeHappy(0.12) // 唤醒彩蛋
  }
}

/* ===================== 眨眼（随机） ===================== */
// 仅空闲时插入，不打断瞌睡/说话等（优先级保证）。
let blinkTimer: ReturnType<typeof setTimeout> | null = null
function scheduleBlink() {
  const delay = 3000 + Math.random() * 5000
  blinkTimer = setTimeout(() => {
    requestState('blink')
    scheduleBlink()
  }, delay)
}

/* ===================== 生命周期 ===================== */
const isDragging = ref(false)
const isBubbleDismissed = ref(false)
const displayMessage = computed(() => (isDragging.value ? message.value : bubbleMessage.value || message.value))
const displayInteractive = computed(() => !isDragging.value && bubbleInteractive.value)
const shouldShowBubble = computed(
  () => isVisible.value && (isDragging.value || (!isBubbleDismissed.value && unreadCount.value > 0)),
)

watch(
  () => messages.value.length,
  (nextLength, previousLength) => {
    if (nextLength > previousLength) {
      isBubbleDismissed.value = false
    }
  },
)

function onFocus() {
  markActivity()
  maybeWave(true) // 窗口切到前台主动招手
}

onMounted(() => {
  avatarStore.init()
  scheduleBlink()
  scheduleWave()
  scheduleSleepy()
  window.addEventListener('focus', onFocus)
})

onBeforeUnmount(() => {
  if (actionTimer) clearTimeout(actionTimer)
  if (speakTimer) clearTimeout(speakTimer)
  if (waveTimer) clearTimeout(waveTimer)
  if (hoverTimer) clearTimeout(hoverTimer)
  if (sleepTimer) clearTimeout(sleepTimer)
  if (blinkTimer) clearTimeout(blinkTimer)
  if (tapResetTimer) clearTimeout(tapResetTimer)
  window.removeEventListener('focus', onFocus)
})

/* ===================== 拖拽 / 点击 ===================== */
let pointerMoved = false

function startDrag(event: PointerEvent) {
  if (event.pointerType === 'mouse' && event.button !== 0) return

  isDragging.value = true
  pointerMoved = false
  if (event.currentTarget instanceof HTMLElement) {
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  ipcRenderer?.send('desktop-pet:drag-start')
  setMessage('跟着你移动中。')
  markActivity()
  window.addEventListener('pointermove', drag)
  window.addEventListener('pointerup', stopDrag)
  window.addEventListener('pointercancel', stopDrag)
  window.addEventListener('blur', stopDrag)
}

function drag() {
  if (!isDragging.value) return
  pointerMoved = true
  ipcRenderer?.send('desktop-pet:drag-move')
}

function stopDrag() {
  if (!isDragging.value) return

  isDragging.value = false
  ipcRenderer?.send('desktop-pet:drag-end')
  setMessage('这里看起来不错。')
  if (!pointerMoved) handleTap() // 没有拖动 = 一次轻点
  window.removeEventListener('pointermove', drag)
  window.removeEventListener('pointerup', stopDrag)
  window.removeEventListener('pointercancel', stopDrag)
  window.removeEventListener('blur', stopDrag)
}

const hovering = ref(false)
watch(hovering, (now) => {
  if (now) {
    markActivity()
    if (hoverTimer) clearTimeout(hoverTimer)
    hoverTimer = setTimeout(() => maybeWave(), 1000) // 悬浮 1s 招手
  } else if (hoverTimer) {
    clearTimeout(hoverTimer)
  }
})

function dismissBubble() {
  isBubbleDismissed.value = true
}

function openChat() {
  isBubbleDismissed.value = true
  ipcRenderer?.send('desktop-pet:open-chat')
}

function openSettings() {
  ipcRenderer?.send('desktop-pet:open-settings')
}

function hidePet() {
  ipcRenderer?.send('desktop-pet:hide')
}

function resetPosition() {
  ipcRenderer?.send('desktop-pet:reset-position')
}

function showContextMenu() {
  ipcRenderer?.send('desktop-pet:show-context-menu')
}
</script>

<template>
  <section
    class="pet-stage"
    :class="{ 'is-dragging': isDragging }"
    @pointerenter="hovering = true"
    @pointerleave="hovering = false"
  >
    <PetBubble
      :message="displayMessage"
      :visible="shouldShowBubble"
      :interactive="displayInteractive"
      @open-chat="openChat"
      @dismiss="dismissBubble"
    />
    <div class="pet-body" @pointerdown="startDrag" @contextmenu.prevent="showContextMenu">
      <PetAvatar :visible="isVisible" />
    </div>
    <PetQuickMenu
      :hover="hovering"
      @open-chat="openChat"
      @open-settings="openSettings"
      @hide-pet="hidePet"
      @reset-position="resetPosition"
    />
  </section>
</template>
