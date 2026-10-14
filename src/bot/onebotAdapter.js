// src/bot/onebotAdapter.js
// OneBot 正向 WS 适配器（NapCat / LLOneBot）—— 从桌宠版 electron/adapter/onebot-adapter.ts
// 移植为**纯 Node 版**（用户拍板：机器人搬进核心版）。
//
// 与桌宠版逐条对齐的行为（避免两端表现不一致）：
//   收：post_type=message → 解析 CQ 码/数组段 → 统一 incoming { senderId, conversationKey,
//        replyGroupId, text, images, isGroup }
//   过滤：群消息两层闸门 —— 先 groupReplyMode（off/mention/all），再 groupFilter
//         （whitelist/blacklist）。默认 off + 白名单，绝不无差别骚扰群聊。
//   发：send_msg action；图片走 base64:// 直传（不落盘）
//   断线：5 秒后自动重连
//
// 与桌宠版的差异只有两处：ws 库用 npm 的 `ws`（Node 服务没有浏览器全局 WebSocket），
// 以及 get_image 回调 map 同一套逻辑。
const fs = require('fs');
const WebSocket = require('ws');

const RECONNECT_DELAY = 5000;

class OneBotAdapter {
    /**
     * @param {Object} cfg 适配器配置 { id, name, enabled, config: { wsUrl, token?, ... } }
     * @param {(incoming: Object) => void} onMessage 收到合规消息的回调
     */
    constructor(cfg, onMessage) {
        this.id = cfg.id;
        this.name = cfg.name || cfg.id;
        this.config = cfg.config || {};
        this.onMessage = onMessage;
        this.ws = null;
        this.reconnectTimer = null;
        this.echoSeq = 0;
        this.selfQQ = '';
        this.pendingImages = new Map(); // echo -> { resolve, timer }
        this.connected = false;
        this.lastError = '';
        this.disposed = false;
        // 主人账号（协议端 QQ 号）：botManager.setOwner 实时同步，与桌宠版 BotAdapter.setOwner 同语义
        this.ownerAccount = '';
    }

    setError(msg) {
        this.lastError = msg || '';
    }

    /** 设/取消主人（空 = 取消）。只影响路由，不重连。 */
    setOwner(accountKey) {
        this.ownerAccount = String(accountKey || '').trim() || '';
    }

    connect() {
        if (this.disposed || this.ws) return;
        const cfg = this.config;
        const wsUrl = String(cfg.wsUrl || '').trim();
        if (!wsUrl) {
            this.setError('缺少 WS 地址');
            return;
        }
        let url = wsUrl;
        if (cfg.token) {
            try {
                const u = new URL(wsUrl);
                if (!u.searchParams.has('access_token')) {
                    u.searchParams.set('access_token', cfg.token);
                    url = u.toString();
                }
            } catch {
                /* 地址不合法也照样试，让 ws 库报错 */
            }
        }
        this.setError('');
        let ws;
        try {
            ws = new WebSocket(url);
        } catch (e) {
            this.setError(e?.message || '连接失败');
            this.scheduleReconnect();
            return;
        }
        this.ws = ws;
        ws.on('open', () => {
            this.connected = true;
            this.setError('');
            console.log(`[onebot] 已连接 ${this.name}`);
            this.fetchLoginInfo();
        });
        ws.on('message', (raw) => this.handleFrame(String(raw)));
        ws.on('close', () => {
            this.connected = false;
            this.ws = null;
            this.scheduleReconnect();
        });
        ws.on('error', (e) => {
            this.connected = false;
            this.setError(e?.message || '连接出错');
        });
    }

    scheduleReconnect() {
        if (this.disposed || this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, RECONNECT_DELAY);
    }

    disconnect() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        for (const pend of this.pendingImages.values()) clearTimeout(pend.timer);
        this.pendingImages.clear();
        if (this.ws) {
            try {
                this.ws.close();
            } catch {
                /* 已断开 */
            }
            this.ws = null;
        }
        this.connected = false;
    }

    dispose() {
        this.disposed = true;
        this.disconnect();
    }

    /**
     * 运行中更新连接配置（控制台保存设置时由 botManager 调用）。
     * 与桌宠版 adapter-manager update() 同语义：配置有变化就断开重连，
     * 没变化就不动（避免误伤正常连接）。群设置等非连接字段也在 config 里，
     * 桌宠版同样是任何 config 变化都重连，保持一致。
     */
    updateConfig(nextConfig) {
        const before = JSON.stringify(this.config);
        this.config = nextConfig || {};
        if (JSON.stringify(this.config) !== before) {
            this.disconnect();
            this.connect();
        }
    }

    async handleFrame(raw) {
        let frame;
        try {
            frame = JSON.parse(raw);
        } catch {
            return;
        }
        // action 回包（带 echo）：get_login_info 或 get_image
        if (frame && frame.echo) {
            if (typeof frame.echo === 'string' && frame.echo.startsWith('kirari-login-')) {
                const d = frame.data || {};
                if (d.user_id) this.selfQQ = String(d.user_id);
                return;
            }
            if (this.pendingImages.has(frame.echo)) {
                const pend = this.pendingImages.get(frame.echo);
                clearTimeout(pend.timer);
                this.pendingImages.delete(frame.echo);
                pend.resolve(normalizeGetImageResult(frame.data || {}));
                return;
            }
        }
        if (!frame || frame.post_type !== 'message') return;
        await this.handleMessage(frame);
    }

    async handleMessage(frame) {
        const msgType = frame.message_type || (frame.group_id ? 'group' : 'private');
        const userId = String(frame.user_id ?? frame.sender?.user_id ?? '');
        const groupId = frame.group_id ? String(frame.group_id) : '';

        // 事件帧自带的 self_id 比 get_login_info 更可靠（且能立刻用于 @ 判断）—— 与桌宠版同行为
        if (frame.self_id) this.selfQQ = String(frame.self_id);

        // 群消息两层闸门（与桌宠版同语义）
        if (msgType === 'group') {
            const mode = this.config.groupReplyMode || 'off';
            if (mode === 'off') return;
            if (mode === 'mention' && !this.messageMentionsSelf(frame.message)) return;
            const filter = this.config.groupFilter || 'whitelist';
            if (filter === 'whitelist') {
                const allow = (this.config.groupAllowlist || []).map(String).filter(Boolean);
                if (!groupId || !allow.includes(groupId)) return;
            } else {
                const block = (this.config.groupBlocklist || []).map(String).filter(Boolean);
                if (groupId && block.includes(groupId)) return;
            }
        }

        const { text, images: rawImages } = parseMessage(frame.message);
        const images = (await Promise.all(rawImages.map((r) => this.resolveImage(r)))).filter(
            (x) => typeof x === 'string' && x.length > 0,
        );

        let finalText = text;
        if (msgType === 'group' && this.selfQQ) {
            finalText = finalText.replace(new RegExp(`@${this.selfQQ}\\s*`, 'g'), '').trim();
        }
        finalText = finalText.replace(/@all\s*/g, '').trim();
        // 纯精准 @（无文本无图）补一句招呼，别让机器人沉默
        if (msgType === 'group' && !finalText && images.length === 0 && this.messageMentionsSelf(frame.message)) {
            finalText = '在吗？';
        }
        if (!finalText && images.length === 0) return;

        const conversationKey = msgType === 'group' && groupId ? `group:${groupId}:${userId}` : `private:${userId}`;
        this.onMessage({
            adapterId: this.id,
            senderId: userId,
            conversationKey,
            replyGroupId: groupId,
            text: finalText,
            images,
            isGroup: msgType === 'group',
        });
    }

    fetchLoginInfo() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        const echo = `kirari-login-${++this.echoSeq}`;
        try {
            this.ws.send(JSON.stringify({ action: 'get_login_info', params: {}, echo }));
        } catch {
            /* 忽略，重连后会再拿 */
        }
    }

    extractMentionQQs(message) {
        const qqs = new Set();
        const visit = (seg) => {
            if (!seg) return;
            if (typeof seg === 'string') {
                const re = /\[CQ:at,[^\]]*?qq=([0-9]+|all)/g;
                let m;
                while ((m = re.exec(seg)) !== null) qqs.add(m[1]);
            } else if (typeof seg === 'object') {
                if (seg.type === 'at') qqs.add(String(seg.data?.qq ?? ''));
                else if (Array.isArray(seg.message)) seg.message.forEach(visit);
            }
        };
        if (typeof message === 'string') visit(message);
        else if (Array.isArray(message)) message.forEach(visit);
        else if (message && typeof message === 'object') visit(message);
        return qqs;
    }

    messageMentionsSelf(message) {
        if (!this.selfQQ) return false;
        return this.extractMentionQQs(message).has(this.selfQQ);
    }

    async resolveImage(raw) {
        if (!raw) return null;
        const s = String(raw).trim();
        if (s.startsWith('base64://')) return `data:image/jpeg;base64,${s.slice('base64://'.length)}`;
        if (s.startsWith('base64:')) {
            const rest = s.slice('base64:'.length);
            return rest.startsWith('data:image/') ? rest : `data:image/jpeg;base64,${rest}`;
        }
        if (s.startsWith('data:image/')) {
            const comma = s.indexOf(',');
            if (comma === -1) return null;
            const payload = s.slice(comma + 1).trim();
            if (/^https?:\/\//i.test(payload)) return payload;
            return s;
        }
        if (/^https?:\/\//i.test(s)) return s;
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
                const b64 = await this.getImage(s);
                if (!b64) return null;
                if (/^https?:\/\//i.test(b64)) return b64;
                return `data:image/jpeg;base64,${b64}`;
            } catch {
                return null;
            }
        }
        return null;
    }

    getImage(file) {
        return new Promise((resolve) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return resolve(null);
            const echo = `kirari-getimg-${++this.echoSeq}`;
            const timer = setTimeout(() => {
                this.pendingImages.delete(echo);
                resolve(null);
            }, 8000);
            this.pendingImages.set(echo, { resolve, timer });
            try {
                this.ws.send(JSON.stringify({ action: 'get_image', params: { file }, echo }));
            } catch {
                clearTimeout(timer);
                this.pendingImages.delete(echo);
                resolve(null);
            }
        });
    }

    async sendMessage(target, outgoing) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error('OneBot 未连接');
        }
        const segs = [];
        if (outgoing.text) segs.push({ type: 'text', data: { text: outgoing.text } });
        for (const img of outgoing.images || []) {
            const m = /^data:image\/[a-zA-Z+]+;base64,(.+)$/.exec(img);
            segs.push({ type: 'image', data: { file: m ? `base64://${m[1]}` : img } });
        }
        const params = { message: segs };
        if (target.isGroup && target.replyGroupId) params.group_id = target.replyGroupId;
        else params.user_id = target.senderId;
        this.ws.send(JSON.stringify({ action: 'send_msg', params, echo: `kirari-${++this.echoSeq}` }));
    }

    status() {
        return {
            id: this.id,
            name: this.name,
            type: 'onebot',
            connected: this.connected,
            lastError: this.lastError,
            selfQQ: this.selfQQ,
        };
    }
}

// ── 消息解析（CQ 码字符串 + 数组段两种格式，与桌宠版一致）─────────────

function cqParam(body, key) {
    const m = body.match(new RegExp(`${key}=([^,\\]]+)`));
    return m ? m[1].trim() : '';
}

function parseMessage(message) {
    if (typeof message === 'string') {
        const images = [];
        let text = '';
        const parts = message.split('[CQ:');
        for (let i = 0; i < parts.length; i++) {
            if (i === 0) {
                text += parts[i];
                continue;
            }
            const end = parts[i].indexOf(']');
            const body = end >= 0 ? parts[i].slice(0, end) : parts[i];
            const segType = body.split(',')[0];
            if (segType === 'image') {
                const candidate = cqParam(body, 'file') || cqParam(body, 'url');
                if (candidate) images.push(candidate);
            } else if (segType === 'at') {
                text += `@${cqParam(body, 'qq') || '?'} `;
            } else if (segType === 'text') {
                text += cqParam(body, 'text') || '';
            }
            if (end >= 0) text += parts[i].slice(end + 1);
        }
        return { text: text.trim(), images };
    }
    if (Array.isArray(message)) {
        let text = '';
        const images = [];
        for (const seg of message) {
            if (seg?.type === 'text') text += seg.data?.text || '';
            else if (seg?.type === 'at') text += `@${seg.data?.qq === 'all' ? 'all' : seg.data?.qq || '?'} `;
            else if (seg?.type === 'image') {
                const candidate = seg.data?.file || seg.data?.url || '';
                if (candidate) images.push(candidate);
            }
        }
        return { text: text.trim(), images };
    }
    return { text: '', images: [] };
}

/** get_image 回包 → 可用图片串（base64 / url / null）。 */
function normalizeGetImageResult(d) {
    if (typeof d.base64 === 'string') {
        return d.base64.startsWith('base64://') ? d.base64.slice('base64://'.length) : d.base64;
    }
    if (typeof d.file === 'string' && d.file.startsWith('base64://')) return d.file.slice('base64://'.length);
    if (typeof d.url === 'string' && /^https?:\/\//i.test(d.url)) return d.url;
    // 本地文件路径（go-cqhttp/LLOneBot 拿不到外链时会返路径）：读盘转 base64，与桌宠版同行为
    if (typeof d.file === 'string' && (d.file.startsWith('/') || /^[A-Za-z]:[\\/]/.test(d.file) || d.file.startsWith('file://'))) {
        try {
            return fs.readFileSync(d.file.replace(/^file:\/\//, '')).toString('base64');
        } catch {
            return null;
        }
    }
    return null;
}

module.exports = { OneBotAdapter, parseMessage };
