import fs from "fs/promises";
import path from "path";

export type ChatAuthor = "user" | "pet" | "system";

// 对话回答可携带的情绪标签：用于前端"情绪优先"播放（先播情绪动画再播说话）。
// 由后端 LLM 在 pet_response 中返回；本仓库只消费，不负责生成。
export type PetEmotion = "happy" | "wave";

export type ChatMessage = {
    id: string;
    author: ChatAuthor;
    text: string;
    timestamp: number;
    // 可选情绪标签（仅 pet 消息可能携带）。无则省略，前端退化为直接说话。
    emotion?: PetEmotion | null;
    // 关联图片（用户发送的图片、或 AI 返回的图片），URL 或 base64 data URL。
    images?: string[];
};

export type ChatStateSnapshot = {
    sessionId: string;
    connected: boolean;
    lastError: string;
    waitingForReply: boolean;
    messages: ChatMessage[];
    bubbleMessage: string;
    bubbleInteractive: boolean;
};

type PersistedChatState = {
    sessionId: string;
    messages: ChatMessage[];
    bubbleMessage: string;
    bubbleInteractive: boolean;
};

type ChatSessionOptions = {
    backendUrl: string;
    userid: number;
    emitState: (state: ChatStateSnapshot) => void;
    // 会话令牌：在 WS 握手阶段通过 query(?token=) 带上，由后端校验。
    // 缺失时若 requireToken 为 true，后端会拒绝连接。
    token?: string;
    requireToken?: boolean;
};

const WELCOME_MESSAGE = "今天也一起加油吧。";
const LONG_REPLY_PROMPT = "回复较长，点我看详情";

export class ChatSessionService {
    private readonly backendUrl: string;
    private readonly userid: number;
    private readonly emitState: (state: ChatStateSnapshot) => void;
    private readonly token: string;
    private readonly requireToken: boolean;
    private storagePath = "";
    private socket: any = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private persistenceQueue: Promise<void> = Promise.resolve();
    private initialized = false;
    private disposed = false;
    private state: ChatStateSnapshot = {
        sessionId: crypto.randomUUID(),
        connected: false,
        lastError: "",
        waitingForReply: false,
        messages: [this.createMessage("pet", WELCOME_MESSAGE)],
        bubbleMessage: WELCOME_MESSAGE,
        bubbleInteractive: false,
    };

    constructor(options: ChatSessionOptions) {
        this.backendUrl = options.backendUrl;
        this.userid = options.userid;
        this.emitState = options.emitState;
        this.token = options.token ?? "";
        this.requireToken = options.requireToken !== false;
    }

    async init(storagePath: string) {
        if (this.initialized) {
            return;
        }

        this.initialized = true;
        this.storagePath = storagePath;
        await this.loadFromDisk();
        this.ensureBubbleState();
        this.emit();
        this.connect();
    }

    getSnapshot() {
        return this.cloneState();
    }

    async sendMessage(payload: { text: string; images?: string[] }) {
        const text = (payload.text || "").trim();
        const images = Array.isArray(payload.images)
            ? payload.images.filter((x) => typeof x === "string" && x.trim())
            : [];
        if (!text && images.length === 0) {
            return false;
        }

        if (!this.isSocketOpen()) {
            this.setConnectionError("连接未就绪");
            return false;
        }

        const msgPayload = JSON.stringify({
            userid: this.userid,
            content: text,
            images,
            session_id: this.state.sessionId,
        });

        try {
            this.socket.send(msgPayload);
        } catch {
            this.setConnectionError("发送失败");
            return false;
        }

        this.state.waitingForReply = true;
        this.state.lastError = "";
        this.state.messages.push(this.createMessage("user", text, undefined, images));
        this.persist();
        this.emit();
        return true;
    }

    dispose() {
        this.disposed = true;
        this.clearReconnectTimer();
        if (this.socket) {
            try {
                this.socket.close();
            } catch {
                // ignore
            }
        }
        this.socket = null;
    }

    private connect() {
        if (this.disposed || this.isSocketConnectingOrOpen()) {
            return;
        }

        this.clearReconnectTimer();
        this.state.connected = false;
        this.state.lastError = "";
        this.emit();

        const WebSocketCtor = (globalThis as any).WebSocket;
        if (!WebSocketCtor) {
            this.setConnectionError("WebSocket 不可用");
            return;
        }

        const socket = new WebSocketCtor(this.buildWsUrl());
        this.socket = socket;

        socket.onopen = () => {
            if (this.socket !== socket) {
                return;
            }
            this.state.connected = true;
            this.state.lastError = "";
            this.clearReconnectTimer();
            this.emit();
        };

        socket.onmessage = (event: { data: string }) => {
            if (this.socket !== socket) {
                return;
            }
            this.handleMessage(event.data);
        };

        socket.onerror = (event: any) => {
            if (this.socket !== socket) {
                return;
            }
            // 后端在握手阶段以 4401 拒绝（令牌无效/缺失）：ws 库错误信息含 "4401"，
            // 据此给出精准的“认证失败”提示，区别于普通连接错误。
            const msg = (event && (event.message || event.error?.message)) || "";
            this.setConnectionError(/4401|未授权|unauthorized/i.test(msg) ? "认证失败：会话令牌无效" : "连接出错");
        };

        socket.onclose = (eventOrCode: any) => {
            if (this.socket !== socket) {
                return;
            }
            // ws 库以 (code, reason) 调用，浏览器以 (event) 调用，统一取 code。
            const code = typeof eventOrCode === "number" ? eventOrCode : eventOrCode?.code;
            this.setConnectionError(code === 4401 ? "认证失败：会话令牌无效" : "连接已断开");
        };
    }

    // 把会话令牌拼到握手 URL 的 query（?token=），兼容已带 query 与 ws/wss 协议。
    private buildWsUrl(): string {
        if (!this.requireToken || !this.token) {
            return this.backendUrl;
        }
        try {
            const url = new URL(this.backendUrl);
            if (url.searchParams.has("token")) {
                return this.backendUrl;
            }
            url.searchParams.set("token", this.token);
            return url.toString();
        } catch {
            return this.backendUrl;
        }
    }

    // 去重缓存：记录上一条 pet 消息的文本，防止后端因重连/重试推送相同消息导致刷屏。
    private lastPetSpeech = "";

    private handleMessage(rawData: string) {
        try {
            const payload = JSON.parse(rawData);

            if (payload.type === "pet_response" && typeof payload.speech === "string") {
                const speech = payload.speech.trim();
                // 连续相同消息去重：后端可能在 WS 重连时重复发送欢迎/问候消息
                if (speech === this.lastPetSpeech) {
                    return;
                }
                this.lastPetSpeech = speech;
                // 情绪标签：仅接受白名单值，避免脏数据破坏前端状态机
                const rawEmotion = payload.emotion;
                const emotion: PetEmotion | null | undefined =
                    rawEmotion === "happy" || rawEmotion === "wave" ? rawEmotion : undefined;
                const images = Array.isArray(payload.images)
                    ? payload.images.filter((x) => typeof x === "string" && x.trim())
                    : [];
                this.state.messages.push(this.createMessage("pet", speech, emotion, images));
                this.state.waitingForReply = false;
                this.state.bubbleMessage = speech.length <= 10 ? speech : LONG_REPLY_PROMPT;
                this.state.bubbleInteractive = speech.length > 10;
                this.persist();
                this.emit();
                return;
            }

            if (payload.type === "error" && typeof payload.message === "string") {
                this.state.waitingForReply = false;
                this.state.lastError = payload.message;
                this.emit();
            }
        } catch {
            this.state.waitingForReply = false;
            this.state.lastError = "消息解析失败";
            this.emit();
        }
    }

    private ensureBubbleState() {
        if (!this.state.messages.length) {
            this.state.messages.push(this.createMessage("pet", WELCOME_MESSAGE));
            this.state.bubbleMessage = WELCOME_MESSAGE;
            this.state.bubbleInteractive = false;
            this.persist();
            return;
        }

        if (!this.state.bubbleMessage) {
            const lastPetMessage = [...this.state.messages].reverse().find((message) => message.author === "pet");
            if (lastPetMessage) {
                const shortReply = lastPetMessage.text.trim().length <= 10;
                this.state.bubbleMessage = shortReply ? lastPetMessage.text.trim() : LONG_REPLY_PROMPT;
                this.state.bubbleInteractive = !shortReply;
            } else {
                this.state.bubbleMessage = WELCOME_MESSAGE;
                this.state.bubbleInteractive = false;
            }
        }
    }

    private setConnectionError(message: string) {
        this.state.connected = false;
        this.state.lastError = message;
        this.emit();
        this.scheduleReconnect();
    }

    private scheduleReconnect() {
        if (this.disposed) {
            return;
        }

        this.clearReconnectTimer();
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, 3000);
    }

    private clearReconnectTimer() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    private isSocketOpen() {
        return !!this.socket && this.socket.readyState === 1;
    }

    private isSocketConnectingOrOpen() {
        return !!this.socket && (this.socket.readyState === 0 || this.socket.readyState === 1);
    }

    private createMessage(author: ChatAuthor, text: string, emotion?: PetEmotion | null, images?: string[]): ChatMessage {
        return {
            id: crypto.randomUUID(),
            author,
            text,
            timestamp: Date.now(),
            emotion: emotion ?? null,
            images: images && images.length ? images : undefined,
        };
    }

    private snapshotForDisk(): PersistedChatState {
        return {
            sessionId: this.state.sessionId,
            messages: this.state.messages.map((message) => ({ ...message })),
            bubbleMessage: this.state.bubbleMessage,
            bubbleInteractive: this.state.bubbleInteractive,
        };
    }

    private cloneState(): ChatStateSnapshot {
        return {
            sessionId: this.state.sessionId,
            connected: this.state.connected,
            lastError: this.state.lastError,
            waitingForReply: this.state.waitingForReply,
            messages: this.state.messages.map((message) => ({ ...message })),
            bubbleMessage: this.state.bubbleMessage,
            bubbleInteractive: this.state.bubbleInteractive,
        };
    }

    private emit() {
        this.emitState(this.cloneState());
    }

    private persist() {
        if (!this.storagePath) {
            return;
        }

        const payload = `${JSON.stringify(this.snapshotForDisk(), null, 2)}\n`;
        this.persistenceQueue = this.persistenceQueue
            .then(() => fs.mkdir(path.dirname(this.storagePath), { recursive: true }))
            .then(() => fs.writeFile(this.storagePath, payload, "utf-8"))
            .catch((error) => {
                console.error("❌ 保存聊天会话失败:", error);
            });
    }

    private async loadFromDisk() {
        try {
            const fileText = await fs.readFile(this.storagePath, "utf-8");
            const persisted = JSON.parse(fileText) as PersistedChatState;
            if (persisted.sessionId) {
                this.state.sessionId = persisted.sessionId;
            }
            if (Array.isArray(persisted.messages) && persisted.messages.length > 0) {
                this.state.messages = persisted.messages.map((message) => ({ ...message }));
            }
            if (typeof persisted.bubbleMessage === "string") {
                this.state.bubbleMessage = persisted.bubbleMessage;
            }
            if (typeof persisted.bubbleInteractive === "boolean") {
                this.state.bubbleInteractive = persisted.bubbleInteractive;
            }
        } catch {
            this.persist();
        }
    }
}
