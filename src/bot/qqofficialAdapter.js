// src/bot/qqofficialAdapter.js
// QQ 官方机器人「WebSocket 反向连接」适配器。
//
// 与 OneBotAdapter 同构（class (cfg,onMessage) / connect / disconnect / dispose /
// updateConfig / sendMessage / status / setOwner），botManager 侧只按 type 选类，
// 入站消息形状同桌宠：{ adapterId, senderId, conversationKey, replyGroupId,
// text, images, isGroup }，额外带 scene/msgId 供本适配器回发时选端点。
//
// 协议要点（官方文档）：
//   1. AccessToken: POST /app/getAppAccessToken {appId,clientSecret} → access_token +
//      expires_in（字符串），提前 60s 刷新；备用域名 bots.qq.com。
//   2. 网关: GET /gateway/bot，Header Authorization: QQBot <token> → {url}。
//   3. WS: op=10 Hello → op=2 Identify（intents/shard/properties）；定时 op=1 心跳
//      d=最后 s；op=0 事件按类型映射；op=9 会话失效 → 强制刷 token 重连。
//   4. 发消息: POST /v2/users|groups|channels/{id}/messages，msg_type:0 + msg_id。
//      第一版只发文本，图片（http URL）追加到正文末尾。
const WebSocket = require('ws');

const RECONNECT_DELAY = 5000;
const TOKEN_REFRESH_AHEAD_MS = 60 * 1000;
const DEDUP_LIMIT = 500;
const DEFAULT_EXPIRES_IN = 7200;
const API_BASE = 'https://api.bot.qq.com';
const TOKEN_ENDPOINTS = [
  `${API_BASE}/app/getAppAccessToken`,
  'https://bots.qq.com/app/getAppAccessToken',
];
const GATEWAY_URL = `${API_BASE}/gateway/bot`;

// intents: 私聊消息(1<<25) | 群聊 AT(1<<30) | 频道消息(1<<12) | 私信(1<<9)
const INTENTS = (1 << 25) | (1 << 30) | (1 << 12) | (1 << 9);

const KNOWN_EVENTS = new Set([
  'C2C_MESSAGE_CREATE',
  'GROUP_AT_MESSAGE_CREATE',
  'AT_MESSAGE_CREATE',
  'PUBLIC_MESSAGE_CREATE',
  'DIRECT_MESSAGE_CREATE',
]);

class QQOfficialAdapter {
  /**
   * @param {Object} cfg 适配器配置 { id, name, enabled, config: { appId, clientSecret, ... } }
   * @param {(incoming: Object) => void} onMessage 收到合规消息的回调
   */
  constructor(cfg, onMessage) {
    this.id = cfg.id;
    this.name = cfg.name || cfg.id;
    this.config = cfg.config || {};
    this.onMessage = onMessage;
    this.ws = null;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.connecting = false;
    this.generation = 0;
    this.connected = false;
    this.lastError = '';
    this.disposed = false;
    // 主人账号（对方 openid / member_openid）：botManager.setOwner 实时同步，语义同 OneBotAdapter
    this.ownerAccount = '';
    this.accessToken = '';
    this.tokenExpiresAt = 0;
    this.forceTokenRefresh = false;
    this.lastSeq = null;
    this.seen = new Map(); // dedup key -> timestamp，最多保留最近 500 条
  }

  setError(msg) {
    this.lastError = msg || '';
  }

  /** 设/取消主人（空 = 取消）。只影响路由，不重连。 */
  setOwner(accountKey) {
    this.ownerAccount = String(accountKey || '').trim() || '';
  }

  tokenEndpoints() {
    const custom = String(this.config.tokenEndpoint || '').trim();
    return custom ? [custom, ...TOKEN_ENDPOINTS] : TOKEN_ENDPOINTS;
  }

  /** 取（或提前刷新）AccessToken。失败时依次尝试备用域名。 */
  async ensureToken(force = false) {
    if (!force && this.accessToken && Date.now() < this.tokenExpiresAt - TOKEN_REFRESH_AHEAD_MS) {
      return this.accessToken;
    }
    const appId = String(
      this.config.appId || this.config.appid || this.config.clientId || '',
    ).trim();
    const clientSecret = String(
      this.config.clientSecret || this.config.client_secret || this.config.secret || '',
    ).trim();
    if (!appId || !clientSecret) {
      throw new Error('缺少 AppId 或 ClientSecret');
    }
    let lastErr = null;
    for (const endpoint of this.tokenEndpoints()) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ appId, clientSecret }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok && !body) throw new Error(`获取 AccessToken 失败（HTTP ${res.status}）`);
        if (body && body.code !== undefined && Number(body.code) !== 0) {
          throw new Error(
            `获取 AccessToken 失败（code=${body.code}）${body.message || body.msg || ''}`.trim(),
          );
        }
        const token = body && typeof body.access_token === 'string' ? body.access_token.trim() : '';
        if (!token) throw new Error(`获取 AccessToken 失败（HTTP ${res.status}）`);
        const expiresIn = Number(body.expires_in);
        this.accessToken = token;
        this.tokenExpiresAt =
          Date.now() +
          (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : DEFAULT_EXPIRES_IN) * 1000;
        this.forceTokenRefresh = false;
        this.setError('');
        return token;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('获取 AccessToken 失败');
  }

  /** 取 WSS 网关地址；鉴权失败时打上强制刷 token 标记。 */
  async getGatewayUrl(token) {
    const res = await fetch(GATEWAY_URL, {
      headers: { Authorization: `QQBot ${token}` },
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 || (body && Number(body.code) === 100016)) {
      this.forceTokenRefresh = true;
    }
    if (body && body.code !== undefined && Number(body.code) !== 0) {
      throw new Error(`获取网关失败（code=${body.code}）${body.message || body.msg || ''}`.trim());
    }
    const url = body && typeof body.url === 'string' ? body.url.trim() : '';
    if (!url) throw new Error(`获取网关失败（HTTP ${res.status}）`);
    return url;
  }

  async connect() {
    if (this.disposed || this.ws || this.connecting) return;
    const gen = this.generation;
    this.connecting = true;
    try {
      const token = await this.ensureToken(this.forceTokenRefresh);
      if (this.disposed || gen !== this.generation) return;
      const url = await this.getGatewayUrl(token);
      if (this.disposed || gen !== this.generation) return;
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
        if (gen !== this.generation) return;
        this.connected = true;
        this.setError('');
        console.log(`[qqofficial] 已连接 ${this.name}`);
      });
      ws.on('message', (raw) => this.handleFrame(String(raw)));
      ws.on('close', () => {
        if (this.ws !== ws) return;
        this.clearHeartbeat();
        this.ws = null;
        this.connected = false;
        if (!this.disposed) this.scheduleReconnect();
      });
      ws.on('error', (e) => {
        if (this.ws !== ws) return;
        this.connected = false;
        this.setError(e?.message || '连接出错');
      });
    } catch (e) {
      this.setError(e?.message || '连接失败');
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  scheduleReconnect() {
    if (this.disposed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_DELAY);
  }

  /** 关闭 WS 并清理心跳，但不碰重连定时器（由调用方决定是否 scheduleReconnect）。 */
  dropWs() {
    this.clearHeartbeat();
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

  clearHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  startHeartbeat(interval) {
    this.clearHeartbeat();
    const ms = Number(interval);
    const delay = Number.isFinite(ms) && ms > 0 ? ms : 30000;
    this.heartbeatTimer = setInterval(() => {
      this.sendFrame({ op: 1, d: this.lastSeq });
    }, delay);
    this.heartbeatTimer.unref?.();
  }

  sendFrame(frame) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  /** token 失效 / op=9 / openapi 401 / code 100016：强制刷 token 后重连。 */
  handleAuthFailure(reason) {
    this.setError(reason);
    this.forceTokenRefresh = true;
    this.dropWs();
    this.scheduleReconnect();
  }

  disconnect() {
    this.generation++;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.dropWs();
    this.accessToken = '';
    this.tokenExpiresAt = 0;
    this.forceTokenRefresh = false;
    this.lastSeq = null;
  }

  dispose() {
    this.disposed = true;
    this.disconnect();
  }

  /**
   * 运行中更新连接配置（控制台保存设置时由 botManager 调用）。
   * 与 OneBotAdapter.updateConfig 同语义：配置有变化就断开重连，没变化就不动。
   */
  updateConfig(nextConfig) {
    const before = JSON.stringify(this.config);
    this.config = nextConfig || {};
    if (JSON.stringify(this.config) !== before) {
      this.disconnect();
      this.connect();
    }
  }

  handleFrame(raw) {
    let frame;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (!frame || typeof frame !== 'object') return;

    if (frame.op === 10) {
      this.startHeartbeat(frame.d?.heartbeat_interval);
      this.sendFrame({
        op: 2,
        d: {
          token: `QQBot ${this.accessToken}`,
          intents: INTENTS,
          shard: [0, 1],
          properties: { $os: 'linux', $browser: 'pet-api', $device: 'server' },
        },
      });
      return;
    }
    if (frame.op === 11) return; // Heartbeat ACK
    if (frame.op === 9) {
      this.handleAuthFailure('会话失效（op=9），正在刷新 Token 重连');
      return;
    }
    if (frame.op !== 0) return;
    if (typeof frame.s === 'number') this.lastSeq = frame.s;
    else if (frame.s !== undefined && frame.s !== null && Number.isFinite(Number(frame.s))) {
      this.lastSeq = Number(frame.s);
    }
    if (!KNOWN_EVENTS.has(frame.t)) return;
    const incoming = this.mapIncoming(frame.t, frame.d || {});
    if (incoming && typeof this.onMessage === 'function') this.onMessage(incoming);
  }

  /** op=0 事件 → 与桌宠/OneBot 同形状的 incoming；附带 scene/msgId 供回发。 */
  mapIncoming(eventType, d) {
    const id = String(d.id ?? '');
    const msgSeq = d.msg_seq;
    const dedupKey = id ? `${id}|${msgSeq ?? ''}` : '';
    if (dedupKey) {
      if (this.seen.has(dedupKey)) return null;
      this.seen.set(dedupKey, Date.now());
      if (this.seen.size > DEDUP_LIMIT) {
        this.seen.delete(this.seen.keys().next().value);
      }
    }

    const memberOpenid = String(d.author?.member_openid || d.member_openid || '');
    const userOpenid = String(d.user_openid || d.author?.user_openid || memberOpenid || '');
    const groupId = String(d.group_openid || '');
    const channelId = String(d.channel_id || '');
    const guildId = String(d.guild_id || '');

    let senderId = '';
    let conversationKey = '';
    let replyGroupId = '';
    let isGroup = false;
    let scene = 'c2c';

    if (eventType === 'C2C_MESSAGE_CREATE') {
      senderId = userOpenid;
      conversationKey = `private:${senderId}`;
      scene = 'c2c';
    } else if (eventType === 'GROUP_AT_MESSAGE_CREATE') {
      senderId = memberOpenid || userOpenid;
      conversationKey = `group:${groupId}:${senderId}`;
      replyGroupId = groupId;
      isGroup = true;
      scene = 'group';
    } else if (eventType === 'AT_MESSAGE_CREATE' || eventType === 'PUBLIC_MESSAGE_CREATE') {
      senderId = memberOpenid || userOpenid;
      conversationKey = `channel:${channelId}:${senderId}`;
      replyGroupId = channelId;
      isGroup = true;
      scene = 'channel';
    } else if (eventType === 'DIRECT_MESSAGE_CREATE') {
      senderId = memberOpenid || userOpenid;
      conversationKey = `dm:${guildId || channelId}:${senderId}`;
      scene = 'dm';
    }
    if (!senderId) return null;

    const text = String(d.content ?? '').trim();
    const images = [];
    if (Array.isArray(d.attachments)) {
      for (const att of d.attachments) {
        const url = typeof att === 'string' ? att : att?.url || att?.URL || '';
        if (typeof url === 'string' && /^https?:\/\//i.test(url.trim())) images.push(url.trim());
      }
    }
    if (!text && images.length === 0) return null;

    return {
      adapterId: this.id,
      senderId,
      conversationKey,
      replyGroupId,
      text,
      images,
      isGroup,
      // 场合细节：官方事件里作者只有 openid，没有昵称——留空即可，
      // 至少让模型知道"这是群聊/频道，还有别人在看"（隐私边界靠这个判断）。
      senderName: '',
      senderRole: '',
      groupName: '',
      // 本适配器回发用；handleIncoming 不读这几个字段，互不干扰
      scene,
      msgId: id,
    };
  }

  async sendMessage(target, outgoing) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('QQ 官方机器人未连接');
    }
    const text = typeof outgoing?.text === 'string' ? outgoing.text.trim() : '';
    const urls = (Array.isArray(outgoing?.images) ? outgoing.images : [])
      .map((x) => String(x).trim())
      .filter((x) => /^https?:\/\//i.test(x));
    const content = [text, ...urls].filter(Boolean).join('\n');
    if (!content) return;

    const scene = target?.scene || (target?.isGroup ? 'channel' : 'c2c');
    let endpoint;
    if (scene === 'group' && target?.replyGroupId) {
      endpoint = `${API_BASE}/v2/groups/${encodeURIComponent(target.replyGroupId)}/messages`;
    } else if (scene === 'channel' && target?.replyGroupId) {
      endpoint = `${API_BASE}/v2/channels/${encodeURIComponent(target.replyGroupId)}/messages`;
    } else {
      endpoint = `${API_BASE}/v2/users/${encodeURIComponent(target?.senderId || '')}/messages`;
    }

    const token = await this.ensureToken();
    const body = { msg_type: 0, content };
    if (target?.msgId) body.msg_id = target.msgId;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `QQBot ${token}`,
      },
      body: JSON.stringify(body),
    });
    const resp = await res.json().catch(() => ({}));
    if (res.status === 401 || (resp && Number(resp.code) === 100016)) {
      this.handleAuthFailure('AccessToken 失效（发消息 401/100016），正在刷新重连');
      throw new Error('AccessToken 失效，正在重连');
    }
    if (!res.ok || (resp && resp.code !== undefined && Number(resp.code) !== 0)) {
      throw new Error(
        `发送消息失败（HTTP ${res.status}, code=${resp?.code ?? '-'}）${resp?.message || resp?.msg || ''}`.trim(),
      );
    }
  }

  status() {
    return {
      id: this.id,
      name: this.name,
      type: 'qqofficial',
      connected: this.connected,
      lastError: this.lastError,
    };
  }
}

module.exports = { QQOfficialAdapter };
