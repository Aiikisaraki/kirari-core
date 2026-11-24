<script setup>
// 聊天面板。
//
// 会话：**本机会话**（/api/session 给的那个 id），和桌宠版是同一个 ——
// 所以桌宠里聊过的内容，控制台打开就能看到，反过来也一样。
// 以前这里是每次开页面现生成一个 `console-<uuid>`，还从不读历史，
// 表现就是「明明聊过，界面永远是空的」。
import { ref, computed, nextTick, onMounted, onUnmounted } from "vue";
import { api } from "../api.js";

const props = defineProps({ petName: { type: String, default: "Kirari" } });

const messages = ref([]); // { role: 'me' | 'pet', text, images? }
const input = ref("");
const pendingImages = ref([]); // 待发送的图（dataURL）
const sending = ref(false);
const streamingText = ref(""); // 正在流入的正文（逐字）；done 时被完整回复替换
const sessionId = ref("");
const errorMsg = ref("");
const loadingHistory = ref(false);
let currentStream = null;
const listEl = ref(null);

function scrollBottom() {
    nextTick(() => {
        if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight;
    });
}

/**
 * 库里的 content 可能是纯文本，也可能是 [text, image_url] 多模态数组
 * （发图时存的就是数组）。这里统一拆成「文字 + 图片」给界面用。
 */
function splitContent(content) {
    if (typeof content === "string") return { text: content, images: [] };
    if (!Array.isArray(content)) return { text: "", images: [] };
    let text = "";
    const images = [];
    for (const part of content) {
        if (!part || typeof part !== "object") continue;
        if (part.type === "text" && typeof part.text === "string") text += part.text;
        else if (part.type === "image_url" && part.image_url?.url) images.push(part.image_url.url);
    }
    return { text, images };
}

/** 库里的原始记录 → 界面用的消息对象。loadHistory / refreshHistory 共用。 */
function mapItems(items) {
    return (items || [])
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => {
            const { text, images } = splitContent(m.content);
            return {
                role: m.role === "assistant" ? "pet" : "me",
                text,
                // 库里的 images 字段是额外的附图（桌宠版存进来的），合并展示
                images: [...images, ...(Array.isArray(m.images) ? m.images : [])],
                // 时间戳：历史接口本来就返回，之前被丢掉了 —— 没有它跨天记录分不清
                timestamp: Number(m.timestamp) || 0,
            };
        });
}

// ── 时间显示 ────────────────────────────────────────────────────────────
const TIME_SEP_THRESHOLD = 5 * 60 * 1000; // 5 分钟

function isSameDay(a, b) {
    const da = new Date(a);
    const db = new Date(b);
    return (
        da.getFullYear() === db.getFullYear() &&
        da.getMonth() === db.getMonth() &&
        da.getDate() === db.getDate()
    );
}

/**
 * 时间文案三档：今天 HH:mm / 今年 M月d日 HH:mm / 往年 yyyy年M月d日 HH:mm。
 * 气泡内也带日期：跨天翻历史时只靠分隔条不够，滚动快了注意不到。
 */
function formatChatTime(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const time = `${hh}:${mm}`;
    const now = new Date();
    if (isSameDay(ts, now.getTime())) return time;
    const md = `${d.getMonth() + 1}月${d.getDate()}日`;
    if (d.getFullYear() === now.getFullYear()) return `${md} ${time}`;
    return `${d.getFullYear()}年${md} ${time}`;
}

/**
 * 把消息列表展开成 [分隔条/消息] 混合数组。
 * 插分隔条的两个条件（满足其一）：间隔超过 5 分钟；跨了自然日。
 */
const threadItems = computed(() => {
    const out = [];
    const msgs = messages.value;
    for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        if (i > 0) {
            const prev = msgs[i - 1];
            const gap = (m.timestamp || 0) - (prev.timestamp || 0);
            const dayChanged =
                m.timestamp && prev.timestamp && !isSameDay(m.timestamp, prev.timestamp);
            if (gap >= TIME_SEP_THRESHOLD || dayChanged) {
                out.push({ type: "sep", key: "sep-" + i, timestamp: m.timestamp });
            }
        }
        out.push({ type: "msg", key: m.id || String(i), message: m });
    }
    return out;
});

async function loadHistory() {
    loadingHistory.value = true;
    try {
        const s = await api.getSession();
        sessionId.value = s.sessionId || "";
        const r = await api.getHistory(sessionId.value, 200);
        messages.value = mapItems(r.items);
        scrollBottom();
    } catch (e) {
        // 历史读不出来不该挡住发消息，提示一下就行
        errorMsg.value = e.message || "聊天记录读取失败";
    } finally {
        loadingHistory.value = false;
    }
}

/**
 * 定时拉一次历史：QQ 那边发来的消息（主人并进主对话的那些）不用手动刷新就能看到。
 *
 * 两条约束：
 *   · 正在发送/流式生成时跳过 —— 否则会把正在流入的那条冲掉；
 *   · 用户往上翻看历史时不抢滚动条，只有本来就在底部才自动跟到底。
 */
async function refreshHistory() {
    if (sending.value || streamingText.value || !sessionId.value) return;
    try {
        const r = await api.getHistory(sessionId.value, 200);
        const next = mapItems(r.items);
        if (JSON.stringify(next) === JSON.stringify(messages.value)) return;
        const el = listEl.value;
        const atBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        messages.value = next;
        if (atBottom) scrollBottom();
    } catch {
        /* 轮询失败静默，下一次再来 */
    }
}

function pickImages(files) {
    for (const f of files) {
        if (!f.type.startsWith("image/")) continue;
        if (pendingImages.value.length >= 9) break;
        const reader = new FileReader();
        reader.onload = () => pendingImages.value.push(reader.result);
        reader.readAsDataURL(f);
    }
}

function onPaste(e) {
    const items = e.clipboardData?.items || [];
    for (const it of items) {
        if (it.type.startsWith("image/")) {
            pickImages([it.getAsFile()]);
            e.preventDefault();
        }
    }
}

function removeImage(i) {
    pendingImages.value.splice(i, 1);
}

async function send() {
    const text = input.value.trim();
    const images = [...pendingImages.value];
    if ((!text && images.length === 0) || sending.value) return;

    input.value = "";
    pendingImages.value = [];
    errorMsg.value = "";
    streamingText.value = "";
    messages.value.push({ role: "me", text, images });
    sending.value = true;
    scrollBottom();

    currentStream = api.chatStream({
        content: text,
        images,
        sessionId: sessionId.value || undefined,
        onEvent: (event, data) => {
            if (event === "start") {
                sessionId.value = data.sessionId;
            } else if (event === "delta") {
                // 逐字流。reset = 之前的碎片作废（工具轮），清空重流
                if (data.reset) streamingText.value = "";
                else {
                    streamingText.value += data.text || "";
                    scrollBottom();
                }
            } else if (event === "done") {
                // 气泡拆分：后端已按句拆好，逐条渲染（真人聊天是连发短消息）。
                const bubbles = Array.isArray(data.bubbles) && data.bubbles.length
                    ? data.bubbles
                    : [data.speech];
                for (const b of bubbles) {
                    messages.value.push({
                        role: "pet",
                        text: b,
                        model: data.model,
                        timestamp: Date.now(),
                    });
                }
                streamingText.value = "";
                sending.value = false;
                currentStream = null;
                scrollBottom();
            } else if (event === "error") {
                errorMsg.value = data.message || "出错了";
                if (data.authFailed) errorMsg.value = "口令不对，请重新进入";
                streamingText.value = "";
                sending.value = false;
                currentStream = null;
                scrollBottom();
            }
        },
    });
}

function stop() {
    currentStream?.abort();
    currentStream = null;
    sending.value = false;
    streamingText.value = "";
}

async function clearAll() {
    if (!window.confirm(`清空和「${props.petName}」的所有聊天记录？桌宠版那边也会一起清掉（本来就同一段对话），清掉后无法恢复。`)) {
        return;
    }
    try {
        await api.clearHistory(sessionId.value || undefined);
        messages.value = [];
        errorMsg.value = "";
    } catch (e) {
        errorMsg.value = e.message || "清空失败";
    }
}

let pollTimer = null;

onMounted(async () => {
    await loadHistory();
    // 5 秒一次：QQ 端来的新消息能自己冒出来，不用手动刷新页面
    pollTimer = setInterval(refreshHistory, 5000);
});

onUnmounted(() => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
});
</script>

<template>
  <div class="chat">
    <div ref="listEl" class="list">
      <div v-if="loadingHistory" class="empty">正在读聊天记录…</div>
      <div v-else-if="messages.length === 0" class="empty">
        和{{ petName }}聊两句吧。这儿和桌宠版是同一段对话，在哪边聊都算数。
      </div>
      <template v-for="item in threadItems" :key="item.key">
        <div v-if="item.type === 'sep'" class="time-sep">
          <span class="time-sep__pill">{{ formatChatTime(item.timestamp) }}</span>
        </div>
        <div v-else class="row" :class="item.message.role">
          <div class="bubble">
            <div v-if="item.message.images?.length" class="imgs">
              <img v-for="(img, j) in item.message.images" :key="j" :src="img" alt="图片" />
            </div>
            <div v-if="item.message.text" class="text">{{ item.message.text }}</div>
            <div class="meta-row">
              <span v-if="item.message.model" class="meta">{{ item.message.model }}</span>
              <span v-if="item.message.timestamp" class="msg-time">{{ formatChatTime(item.message.timestamp) }}</span>
            </div>
          </div>
        </div>
      </template>
      <div v-if="sending" class="row pet">
        <div v-if="streamingText" class="bubble">
          <div class="text">{{ streamingText }}<span class="caret">▌</span></div>
        </div>
        <div v-else class="bubble thinking">正在想…</div>
      </div>
    </div>

    <p v-if="errorMsg" class="error">{{ errorMsg }}</p>

    <div class="composer">
      <div v-if="pendingImages.length" class="thumbs">
        <div v-for="(img, i) in pendingImages" :key="i" class="thumb">
          <img :src="img" alt="待发送" />
          <button class="x" @click="removeImage(i)">×</button>
        </div>
      </div>
      <div class="inputrow">
        <label class="attach" title="发图片">
          ＋
          <input type="file" accept="image/*" multiple hidden @change="pickImages($event.target.files)" />
        </label>
        <textarea
          v-model="input"
          rows="2"
          placeholder="输入消息，Ctrl+V 可以直接贴图"
          :disabled="sending"
          @paste="onPaste"
          @keydown.enter.exact.prevent="send"
        />
        <button v-if="sending" class="stop" @click="stop">停止</button>
        <button v-else :disabled="!input.trim() && pendingImages.length === 0" @click="send">发送</button>
      </div>
      <div v-if="messages.length" class="foot">
        <button type="button" class="link" @click="clearAll">清空聊天记录</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.foot {
    display: flex;
    justify-content: flex-end;
    margin-top: 6px;
}
.link {
    border: none;
    background: none;
    color: var(--dim);
    font-size: 12px;
    cursor: pointer;
    padding: 2px 4px;
}
.link:hover {
    color: var(--bad);
    text-decoration: underline;
}
</style>
