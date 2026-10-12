<script setup>
// 聊天面板。
//
// 会话：**本机会话**（/api/session 给的那个 id），和桌宠版是同一个 ——
// 所以桌宠里聊过的内容，控制台打开就能看到，反过来也一样。
// 以前这里是每次开页面现生成一个 `console-<uuid>`，还从不读历史，
// 表现就是「明明聊过，界面永远是空的」。
import { ref, nextTick, onMounted } from "vue";
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

async function loadHistory() {
    loadingHistory.value = true;
    try {
        const s = await api.getSession();
        sessionId.value = s.sessionId || "";
        const r = await api.getHistory(sessionId.value, 200);
        messages.value = (r.items || [])
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => {
                const { text, images } = splitContent(m.content);
                return {
                    role: m.role === "assistant" ? "pet" : "me",
                    text,
                    // 库里的 images 字段是额外的附图（桌宠版存进来的），合并展示
                    images: [...images, ...(Array.isArray(m.images) ? m.images : [])],
                };
            });
        scrollBottom();
    } catch (e) {
        // 历史读不出来不该挡住发消息，提示一下就行
        errorMsg.value = e.message || "聊天记录读取失败";
    } finally {
        loadingHistory.value = false;
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
                messages.value.push({ role: "pet", text: data.speech, model: data.model });
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

onMounted(loadHistory);
</script>

<template>
  <div class="chat">
    <div ref="listEl" class="list">
      <div v-if="loadingHistory" class="empty">正在读聊天记录…</div>
      <div v-else-if="messages.length === 0" class="empty">
        和{{ petName }}聊两句吧。这儿和桌宠版是同一段对话，在哪边聊都算数。
      </div>
      <div v-for="(m, i) in messages" :key="i" class="row" :class="m.role">
        <div class="bubble">
          <div v-if="m.images?.length" class="imgs">
            <img v-for="(img, j) in m.images" :key="j" :src="img" alt="图片" />
          </div>
          <div v-if="m.text" class="text">{{ m.text }}</div>
          <div v-if="m.model" class="meta">{{ m.model }}</div>
        </div>
      </div>
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
