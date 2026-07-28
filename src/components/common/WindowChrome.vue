<script setup lang="ts">
defineProps<{
    title?: string;
}>();

type WindowAction = "minimize" | "close" | "toggle-maximize";

function control(action: WindowAction) {
    const w = window as unknown as {
        windowApi?: Partial<Record<WindowAction, () => void>>;
        require?: (mod: string) => {
            ipcRenderer: { send: (channel: string, ...args: unknown[]) => void };
        };
    };

    // 优先：preload 通过 contextBridge 注入的 API（contextIsolation:true 的窗口，如设置界面）
    if (w.windowApi && typeof w.windowApi[action] === "function") {
        w.windowApi[action]!();
        return;
    }

    // 兜底：直接走 electron 的 ipcRenderer（nodeIntegration:true 的窗口，如对话框）。
    // 对话框窗口开启 nodeIntegration，useChatSocket 也是用同样方式收发消息，这里保持一致。
    try {
        const electronMod = w.require?.("electron");
        electronMod?.ipcRenderer.send("window:control", action);
    } catch (err) {
        console.error("[WindowChrome] 窗口控件不可用:", err);
    }
}
</script>

<template>
    <header class="window-chrome">
        <span class="window-title">{{ title }}</span>
        <div class="window-actions">
            <button
                type="button"
                class="chrome-btn"
                aria-label="最小化"
                title="最小化"
                @click="control('minimize')"
            >
                <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                    <line x1="2.5" y1="6" x2="9.5" y2="6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                </svg>
            </button>
            <button
                type="button"
                class="chrome-btn"
                aria-label="最大化或还原"
                title="最大化"
                @click="control('toggle-maximize')"
            >
                <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                    <rect x="2.5" y="2.5" width="7" height="7" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.6" />
                </svg>
            </button>
            <button
                type="button"
                class="chrome-btn chrome-close"
                aria-label="关闭"
                title="关闭"
                @click="control('close')"
            >
                <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                    <line x1="3.2" y1="3.2" x2="8.8" y2="8.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                    <line x1="8.8" y1="3.2" x2="3.2" y2="8.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                </svg>
            </button>
        </div>
    </header>
</template>

<style scoped>
.window-chrome {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 42px;
    padding: 0 8px 0 14px;
    -webkit-app-region: drag;
    user-select: none;
    background: var(--pet-chrome-bg);
    backdrop-filter: blur(14px) saturate(140%);
    -webkit-backdrop-filter: blur(14px) saturate(140%);
    border-bottom: 1px solid var(--pet-chrome-border);
}

.window-title {
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--pet-ink);
    opacity: 0.82;
}

.window-actions {
    display: flex;
    gap: 4px;
    -webkit-app-region: no-drag;
}

.chrome-btn {
    width: 32px;
    height: 32px;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: 9px;
    background: transparent;
    color: var(--pet-ink);
    cursor: pointer;
    transition: background 140ms ease, color 140ms ease;
}

.chrome-btn:hover {
    background: rgba(104, 93, 122, 0.16);
}

.chrome-close:hover {
  background: var(--pet-danger);
  color: #ffffff;
}

.chrome-btn:focus-visible {
    outline: 2px solid var(--pet-accent);
    outline-offset: 2px;
}
</style>
