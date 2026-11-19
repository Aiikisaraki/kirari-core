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
        // 通用 action 回调等待表（callAction 用）：echo -> { resolve, timer }
        this.pendingActions = new Map();
        this.connected = false;
        this.lastError = '';
        this.disposed = false;
        // notice / request 事件回调（由 botManager 注入，交给 social 服务落库）
        this.onNotice = null;
        // 连接就绪回调：用来做一次社交环境全量同步
        this.onReady = null;
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
            // 连上就把「我周围有什么」拉一遍：群列表、好友、群成员。
            // 不阻塞消息处理，失败也只是保留旧缓存。
            if (typeof this.onReady === 'function') {
                setTimeout(() => {
                    try {
                        this.onReady();
                    } catch (e) {
                        console.warn('[onebot] 社交环境同步失败（已忽略）:', e?.message || e);
                    }
                }, 1500);
            }
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
        for (const pend of this.pendingActions.values()) clearTimeout(pend.timer);
        this.pendingActions.clear();
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

    /**
     * 通用 OneBot action 调用：发一帧 {action, params, echo}，等回包。
     *
     * 之前只有 get_login_info / get_image 两个写死的分支，导致她能"用"的协议
     * 接口实际上只有这两个——get_group_list / get_friend_list / get_group_member_list
     * 这些明明就在协议端手里，她却一次都没调用过，于是「你在几个群里」只能答不知道。
     * 用户 2026-11-19：「我希望她能完整意识到自己的人际关系和周围的环境。」
     *
     * @param {string} action OneBot action 名，如 get_group_list
     * @param {Object} params action 参数
     * @param {number} timeoutMs 超时（协议端没实现该接口时不能一直挂着）
     * @returns {Promise<any>} retcode=0 时返回 data，否则 null
     */
    callAction(action, params = {}, timeoutMs = 8000) {
        return new Promise((resolve) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                resolve(null);
                return;
            }
            const echo = `kirari-act-${++this.echoSeq}`;
            const timer = setTimeout(() => {
                this.pendingActions.delete(echo);
                resolve(null);
            }, Math.max(500, timeoutMs));
            this.pendingActions.set(echo, { resolve, timer });
            try {
                this.ws.send(JSON.stringify({ action, params: params || {}, echo }));
            } catch {
                clearTimeout(timer);
                this.pendingActions.delete(echo);
                resolve(null);
            }
        });
    }

    async handleFrame(raw) {
        let frame;
        try {
            frame = JSON.parse(raw);
        } catch {
            return;
        }
        // action 回包（带 echo）：get_login_info / get_image / 通用 callAction
        if (frame && frame.echo) {
            if (typeof frame.echo === 'string' && frame.echo.startsWith('kirari-login-')) {
                const d = frame.data || {};
                if (d.user_id) this.selfQQ = String(d.user_id);
                return;
            }
            if (typeof frame.echo === 'string' && frame.echo.startsWith('kirari-act-')) {
                const pend = this.pendingActions.get(frame.echo);
                if (pend) {
                    clearTimeout(pend.timer);
                    this.pendingActions.delete(frame.echo);
                    // retcode 非 0（接口未实现/权限不足）也当失败，返回 null 让上层降级
                    const ok = frame.retcode === 0 || frame.retcode === undefined;
                    pend.resolve(ok ? frame.data ?? null : null);
                }
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

        // notice 帧：谁进群/退群、谁戳一戳、名片变了……
        // 这些原来被 post_type !== 'message' 整包丢弃，她对"身边发生了什么"完全无感。
        if (frame && frame.post_type === 'notice') {
            this.handleNotice(frame);
            return;
        }
        // 请求帧（加好友/加群邀请）：只记录，不自动同意——涉及身份决策必须交给人。
        if (frame && frame.post_type === 'request') {
            this.handleRequest(frame);
            return;
        }
        if (!frame || frame.post_type !== 'message') return;
        await this.handleMessage(frame);
    }

    /**
     * notice 事件 → 统一事件对象，交给上层（social 服务）落库。
     * OneBot v11 的 notice_type 有：group_increase / group_decrease / group_upload /
     * group_admin / group_ban / group_recall / friend_add / friend_recall / notify(poke)。
     */
    handleNotice(frame) {
        if (frame.self_id) this.selfQQ = String(frame.self_id);
        const noticeType = String(frame.notice_type || '');
        const subType = String(frame.sub_type || '');
        const groupId = frame.group_id ? String(frame.group_id) : null;
        const userId = frame.user_id != null ? String(frame.user_id) : null;
        const targetId = frame.target_id != null ? String(frame.target_id) : null;

        // notify 下面再分 poke（戳一戳）/ lucky_king 等，统一归成 notify:poke 这种形式
        const eventType = noticeType === 'notify' ? `notify:${subType || 'unknown'}` : `${noticeType}${subType ? `:${subType}` : ''}`;

        // 感兴趣的才记（其余事件噪声大，记了也没用）
        const INTERESTING = new Set([
            'group_increase:approve',
            'group_increase:invite',
            'group_decrease:leave',
            'group_decrease:kick',
            'group_decrease:kick_me',
            'group_admin:set',
            'group_admin:unset',
            'group_recall',
            'friend_add',
            'notify:poke',
            'group_ban:ban',
            'group_ban:lift_ban',
            'group_upload',
        ]);
        if (!INTERESTING.has(eventType)) return;

        let detail = '';
        switch (eventType.split(':')[0]) {
            case 'group_increase':
                detail = `${userId || '有人'} 加入了群${groupId ? ` ${groupId}` : ''}`;
                break;
            case 'group_decrease':
                detail = `${userId || '有人'} ${subType === 'kick' ? '被移出' : '离开了'}群${groupId ? ` ${groupId}` : ''}`;
                break;
            case 'group_admin':
                detail = `${userId || '有人'} ${subType === 'set' ? '成为' : '不再是'}管理员（群 ${groupId || ''}）`;
                break;
            case 'group_recall':
                detail = `${userId || '有人'} 撤回了一条消息${groupId ? `（群 ${groupId}）` : ''}`;
                break;
            case 'friend_add':
                detail = `${userId || '有人'} 加你为好友`;
                break;
            case 'notify':
                detail = subType === 'poke'
                    ? `${userId || '有人'} 戳了戳${targetId && targetId === this.selfQQ ? '你' : ` ${targetId || '某人'} `}`
                    : `通知：${subType}`;
                break;
            case 'group_ban':
                detail = `${userId || '有人'} 在群 ${groupId || ''} ${subType === 'ban' ? '被禁言' : '解除禁言'}`;
                break;
            case 'group_upload':
                detail = `${userId || '有人'} 在群 ${groupId || ''} 上传了文件`;
                break;
            default:
                detail = eventType;
        }

        if (typeof this.onNotice === 'function') {
            try {
                this.onNotice({
                    adapterId: this.id,
                    eventType,
                    groupId,
                    actorId: userId,
                    targetId,
                    detail,
                });
            } catch (e) {
                console.warn('[onebot] notice 回调失败:', e?.message || e);
            }
        }
    }

    /** 加好友/加群邀请：只上报，不自动同意（身份决策必须由人来做）。 */
    handleRequest(frame) {
        const subType = String(frame.sub_type || '');
        const userId = frame.user_id != null ? String(frame.user_id) : null;
        const groupId = frame.group_id ? String(frame.group_id) : null;
        const comment = String(frame.comment || '').trim();
        if (typeof this.onNotice === 'function') {
            try {
                this.onNotice({
                    adapterId: this.id,
                    eventType: `request:${subType || 'unknown'}`,
                    groupId,
                    actorId: userId,
                    targetId: null,
                    detail: subType === 'group'
                        ? `${userId || '有人'} 申请加入群 ${groupId || ''}${comment ? `（留言：${comment}）` : ''}`
                        : `${userId || '有人'} 申请加你为好友${comment ? `（留言：${comment}）` : ''}`,
                });
            } catch (e) {
                console.warn('[onebot] request 回调失败:', e?.message || e);
            }
        }
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
        // 场合细节：sender 里的昵称/群名片、role（owner/admin/member）、群名（部分实现会带）。
        // 这些原本被整包丢弃，导致模型不知道在跟谁说话、也不知道在群里——
        // 是"共享身份下决策僵化"的直接原因之一（2026-11-19 用户反馈）。
        const senderName = String(frame.sender?.card || frame.sender?.nickname || '').trim();
        const senderRole = String(frame.sender?.role || '').trim();
        this.onMessage({
            adapterId: this.id,
            senderId: userId,
            conversationKey,
            replyGroupId: groupId,
            text: finalText,
            images,
            isGroup: msgType === 'group',
            senderName,
            senderRole,
            groupName: String(frame.group_name || '').trim(),
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

    // ── 社交环境拉取（她所处真实世界的事实来源）─────────────────────────
    // 用户 2026-11-19：「我希望她能完整意识到自己的人际关系和周围的环境。」
    // 这几组接口协议端本来就有，之前一次都没调过，所以她对"我在几个群"是真不知道。

    /** 我加入了哪些群（含群名/人数）。 */
    async fetchGroupList() {
        const data = await this.callAction('get_group_list', {}, 10000);
        if (!Array.isArray(data)) return null;
        return data.map((g) => ({
            groupId: String(g.group_id ?? g.groupId ?? ''),
            groupName: String(g.group_name ?? g.groupName ?? '').trim(),
            memberCount: toNumOrNull(g.member_count ?? g.memberCount),
            maxMemberCount: toNumOrNull(g.max_member_count ?? g.maxMemberCount),
        })).filter((g) => g.groupId);
    }

    /** 我的好友列表。 */
    async fetchFriendList() {
        const data = await this.callAction('get_friend_list', {}, 10000);
        if (!Array.isArray(data)) return null;
        return data.map((f) => ({
            userId: String(f.user_id ?? f.userId ?? ''),
            nickname: String(f.nickname ?? f.remark ?? '').trim() || null,
            remark: String(f.remark ?? '').trim() || null,
        })).filter((f) => f.userId);
    }

    /** 某个群的成员列表（谁在里面）。 */
    async fetchGroupMemberList(groupId) {
        const gid = String(groupId || '').trim();
        if (!gid) return null;
        const data = await this.callAction('get_group_member_list', { group_id: gid, no_cache: true }, 15000);
        if (!Array.isArray(data)) return null;
        return data.map((m) => ({
            userId: String(m.user_id ?? m.userId ?? ''),
            nickname: String(m.nickname ?? '').trim() || null,
            card: String(m.card ?? '').trim() || null,
            role: String(m.role ?? '').trim() || null,
        })).filter((m) => m.userId);
    }

    /**
     * 一次性把「我周围的社交环境」全拉一遍。
     * 返回 null 表示协议端不支持（此时上层保留旧缓存，不清空）。
     */
    async syncSocial() {
        const [groups, friends] = await Promise.all([this.fetchGroupList(), this.fetchFriendList()]);
        // 群成员逐个拉：协议端没有批量接口，串行限流避免把 NapCat 打爆。
        const memberMap = {};
        if (Array.isArray(groups)) {
            for (const g of groups) {
                // 只拉成员数在合理范围的群；超大群（如几千人）拉一次很贵且意义不大
                if (typeof g.memberCount === 'number' && g.memberCount > 500) continue;
                const members = await this.fetchGroupMemberList(g.groupId);
                if (Array.isArray(members)) memberMap[g.groupId] = members;
            }
        }
        return { groups, friends, memberMap };
    }

    /** 只刷新某个群的成员（有人进群/退群时调用，比全量同步便宜）。 */
    async refreshGroupMembers(groupId) {
        const members = await this.fetchGroupMemberList(groupId);
        return Array.isArray(members) ? members : null;
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

/** 安全转数字：协议端有时给字符串，有时给 null/undefined。 */
function toNumOrNull(v) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : null;
}

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