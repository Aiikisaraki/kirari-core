<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useChatSocket } from "../../composables/useChatSocket";
import { marked } from "marked";
import DOMPurify from "dompurify";
import WindowChrome from "../common/WindowChrome.vue";
import type { ChatMessage } from "../../stores/chat";

marked.setOptions({ gfm: true, breaks: true });

function renderMarkdown(text: string): string {
    const rawHtml = marked.parse(text, { async: false }) as string;
    return DOMPurify.sanitize(rawHtml);
}


const { connected, messages, lastError, waitingForReply, requestState, sendMessage } =
    useChatSocket();

const draft = ref("");
const threadRef = ref<HTMLElement | null>(null);

/* ===== 时间分隔标记 ===== */
const TIME_SEP_THRESHOLD = 5 * 60 * 1000; // 5 分钟

interface ThreadItem {
    type: "message" | "timestamp";
    key: string;
    message?: ChatMessage;
    timestamp?: number;
}

/** 将消息列表展开为 [消息/时间标记] 混合数组 */
const threadItems = computed<ThreadItem[]>(() => {
    const items: ThreadItem[] = [];
    const msgs = messages.value;
    for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i];
        // 与上一条对比，间隔超过阈值则插入时间标记
        if (i > 0) {
            const diff = msg.timestamp - msgs[i - 1].timestamp;
            if (diff >= TIME_SEP_THRESHOLD) {
                items.push({
                    type: "timestamp",
                    key: `ts-${msg.id}`,
                    timestamp: msg.timestamp,
                });
            }
        }
        items.push({ type: "message", key: msg.id, message: msg });
    }
    return items;
});

/** 格式化时间戳为 HH:mm */
function formatTime(ts: number): string {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
}

onMounted(() => {
    void requestState();
});

async function scrollToLatest() {
    await nextTick();
    threadRef.value?.scrollTo({
        top: threadRef.value.scrollHeight,
        behavior: "smooth",
    });
}

function sendMessageLocal() {
    const text = draft.value.trim();
    if (!text) return;
    draft.value = "";
    sendMessage(text);
}

watch(
    () => messages.value.length,
    async () => {
        await scrollToLatest();
    },
);

function getConnectionLabel() {
    if (connected.value) {
        return "在线";
    }
    if (lastError.value) {
        return "连接异常";
    }
    return "连接中";
}

function getConnectionClass() {
    if (connected.value) {
        return "is-online";
    }
    if (lastError.value) {
        return "is-offline";
    }
    return "is-connecting";
}
</script>

<template>
    <div class="app-shell">
        <WindowChrome title="和 Aki 聊天" />
        <main class="chat-window" aria-label="和 Aki 聊天">
            <header class="chat-header">
                <div>
                    <p class="chat-kicker">Aki Kirari</p>
                    <h1>对话框</h1>
                </div>
                <span class="chat-status" :class="getConnectionClass()">{{
                    getConnectionLabel()
                }}</span>
            </header>

            <section ref="threadRef" class="chat-thread" aria-live="polite">
                <template v-for="item in threadItems" :key="item.key">
                    <!-- 时间分隔标记 -->
                    <div v-if="item.type === 'timestamp'" class="chat-time-sep">
                        <span class="chat-time-sep__pill">{{ formatTime(item.timestamp!) }}</span>
                    </div>
                    <!-- 消息气泡 -->
                    <article
                        v-else
                        class="chat-message"
                        :class="`is-${item.message!.author}`"
                    >
                        <div class="markdown-body" v-html="renderMarkdown(item.message!.text)"></div>
                    </article>
                </template>

                <div v-if="waitingForReply" class="chat-waiting" role="status" aria-live="polite">
                    <span class="chat-waiting-dot" aria-hidden="true"></span>
                    <span>Aki 正在思考...</span>
                </div>
            </section>

            <form class="chat-composer" @submit.prevent="sendMessageLocal">
                <input
                    v-model="draft"
                    type="text"
                    placeholder="输入消息"
                    autocomplete="off"
                />
                <button type="submit" :disabled="!connected || waitingForReply || !draft.trim()">
                    发送
                </button>
            </form>
        </main>
    </div>
</template>
