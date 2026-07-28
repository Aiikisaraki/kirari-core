import { defineStore } from 'pinia'
import { ref } from 'vue'

// 桌宠自身状态（可见性、提示语）。原先散落在 usePetState 组合式里，
// 现集中为 Pinia store，便于同一渲染进程内的组件共享。
export const usePetStore = defineStore('pet', () => {
  const isVisible = ref(true)
  const message = ref('今天也一起加油吧。')

  function toggleVisible() {
    isVisible.value = !isVisible.value
    message.value = isVisible.value ? '我回来啦。' : '先躲一小会儿。'
  }

  function resetPosition() {
    message.value = '位置已经重置好了。'
  }

  function setMessage(next: string) {
    message.value = next
  }

  return { isVisible, message, toggleVisible, resetPosition, setMessage }
})
