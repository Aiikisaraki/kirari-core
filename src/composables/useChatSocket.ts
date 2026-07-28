import { storeToRefs } from 'pinia'
import { useChatStore, type ChatStateSnapshot } from '../stores/chat'

type DesktopPetChannel =
  | 'chat:send-message'
  | 'desktop-pet:drag-start'
  | 'desktop-pet:drag-move'
  | 'desktop-pet:drag-end'
  | 'desktop-pet:open-chat'
  | 'desktop-pet:show-context-menu'
  | 'desktop-pet:reset-position'
type DesktopPetInvokeChannel = 'chat:get-state'
type DesktopPetEventChannel = 'chat:state' | 'chat:open-changed'

type DesktopPetIpc = {
  send(channel: DesktopPetChannel, payload?: string): void
  invoke(channel: DesktopPetInvokeChannel): Promise<ChatStateSnapshot>
  on(channel: DesktopPetEventChannel, listener: (...args: unknown[]) => void): void
}

declare global {
  interface Window {
    require?: (module: 'electron') => { ipcRenderer: DesktopPetIpc }
  }
}

const ipcRenderer = window.require?.('electron').ipcRenderer
let initialized = false

// 把主进程推送的状态桥接到 Pinia store；跨窗口的“对话框打开”也走这里。
function ensureInitialized() {
  if (initialized || !ipcRenderer) return

  const store = useChatStore()
  ipcRenderer.on('chat:state', (_event: unknown, nextState: ChatStateSnapshot) => {
    store.applyState(nextState)
  })
  ipcRenderer.on('chat:open-changed', (_event: unknown, open: unknown) => {
    store.setChatWindowOpen(open === true)
  })
  initialized = true
}

async function requestState() {
  const store = useChatStore()
  if (!ipcRenderer) {
    store.lastError = '桌宠 IPC 不可用'
    return
  }

  const nextState = await ipcRenderer.invoke('chat:get-state')
  store.applyState(nextState)
}

function sendMessage(content: string) {
  const text = content.trim()
  if (!text || !ipcRenderer) return

  ipcRenderer.send('chat:send-message', text)
}

function openChat() {
  ipcRenderer?.send('desktop-pet:open-chat')
}

export function useChatSocket() {
  const store = useChatStore()
  ensureInitialized()
  void requestState()

  // storeToRefs 仅解包 state，函数保持原样返回。
  const {
    connected,
    messages,
    lastError,
    waitingForReply,
    sessionId,
    bubbleMessage,
    bubbleInteractive,
    unreadCount,
    chatWindowOpen,
  } = storeToRefs(store)

  return {
    connected,
    messages,
    lastError,
    waitingForReply,
    sessionId,
    bubbleMessage,
    bubbleInteractive,
    unreadCount,
    chatWindowOpen,
    requestState,
    sendMessage,
    openChat,
  }
}
