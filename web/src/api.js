// 控制台接口封装：所有请求都带管理口令（X-Admin-Token）。
// 口令由用户在首次进入时输入，存 localStorage（浏览器本地，不上传别处）。
const KEY = "kirari-admin-token";

export function getToken() {
    return localStorage.getItem(KEY) || "";
}

export function setToken(t) {
    localStorage.setItem(KEY, t);
}

export function clearToken() {
    localStorage.removeItem(KEY);
}

async function request(path, options = {}) {
    const res = await fetch(path, {
        ...options,
        headers: {
            "Content-Type": "application/json",
            "X-Admin-Token": getToken(),
            ...(options.headers || {}),
        },
    });
    // 后端用 401 提示口令不对；让调用方知道该重新输口令
    if (res.status === 401) {
        const err = new Error("口令不对");
        err.authFailed = true;
        throw err;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error(data.message || `请求失败（${res.status}）`);
        err.status = res.status;
        err.payload = data;
        throw err;
    }
    return data;
}

export const api = {
    status: () => request("/api/status"),
    getSettings: () => request("/api/settings"),
    saveSettings: (patch) => request("/api/settings", { method: "PUT", body: JSON.stringify(patch) }),
    chatStream,
    // 多模型
    listModels: () => request("/api/models"),
    addModel: (p) => request("/api/models", { method: "POST", body: JSON.stringify(p) }),
    updateModel: (id, p) => request(`/api/models/${id}`, { method: "PUT", body: JSON.stringify(p) }),
    deleteModel: (id) => request(`/api/models/${id}`, { method: "DELETE" }),
    setActiveModel: (id) => request("/api/models/active", { method: "PUT", body: JSON.stringify({ id }) }),
    // 控制台外观（配色 + 明暗）。只管网页控制台这一边，和桌宠版的主题互不影响。
    getAppearance: () => request("/api/appearance"),
    saveAppearance: (p) => request("/api/appearance", { method: "PUT", body: JSON.stringify(p) }),
    // 备注名（与桌宠版共用 pet-client.config.json 的 petName）
    getPetName: () => request("/api/pet-name"),
    savePetName: (petName) => request("/api/pet-name", { method: "PUT", body: JSON.stringify({ petName }) }),
    // 我的头像：文件在服务端 userData/user-avatar/，配置里只存引用。
    // 接口带管理口令，所以不能直接 <img src="...">，得取回 blob 再转成本地 URL。
    getAvatarBlobUrl: async () => {
        const res = await fetch("/api/avatar/user", { headers: { "X-Admin-Token": getToken() } });
        if (res.status === 404) return "";
        if (!res.ok) throw new Error(`读取头像失败（${res.status}）`);
        return URL.createObjectURL(await res.blob());
    },
    saveAvatar: (dataUrl) => request("/api/avatar/user", { method: "POST", body: JSON.stringify({ dataUrl }) }),
    clearAvatar: () => request("/api/avatar/user", { method: "DELETE" }),
    // 人格（与桌宠版共用 config.json 的 basePersona）
    getPersona: () => request("/api/persona"),
    savePersona: (basePersona) => request("/api/persona", { method: "PUT", body: JSON.stringify({ basePersona }) }),
    // 技能
    listSkills: () => request("/api/skills"),
    addSkill: (p) => request("/api/skills", { method: "POST", body: JSON.stringify(p) }),
    updateSkill: (id, p) => request(`/api/skills/${id}`, { method: "PUT", body: JSON.stringify(p) }),
    deleteSkill: (id) => request(`/api/skills/${id}`, { method: "DELETE" }),
    // MCP 外部工具服务
    listMcp: () => request("/api/mcp"),
    addMcp: (p) => request("/api/mcp", { method: "POST", body: JSON.stringify(p) }),
    updateMcp: (id, p) => request(`/api/mcp/${id}`, { method: "PUT", body: JSON.stringify(p) }),
    deleteMcp: (id) => request(`/api/mcp/${id}`, { method: "DELETE" }),
    probeMcp: (p) => request("/api/mcp/probe", { method: "POST", body: JSON.stringify(p) }),
    // 私人知识库
    listKb: () => request("/api/kb"),
    addKb: (p) => request("/api/kb", { method: "POST", body: JSON.stringify(p) }),
    updateKb: (id, p) => request(`/api/kb/${id}`, { method: "PUT", body: JSON.stringify(p) }),
    deleteKb: (id) => request(`/api/kb/${id}`, { method: "DELETE" }),
    // 机器人适配器
    listBot: () => request("/api/bot"),
    addBot: (p) => request("/api/bot", { method: "POST", body: JSON.stringify(p) }),
    updateBot: (id, p) => request(`/api/bot/${id}`, { method: "PUT", body: JSON.stringify(p) }),
    deleteBot: (id) => request(`/api/bot/${id}`, { method: "DELETE" }),
    // 设/取消主人：account 为空 = 取消。主人的消息会并进主对话（与桌宠版同一功能）
    setBotOwner: (id, account) =>
        request(`/api/bot/${id}/owner`, { method: "POST", body: JSON.stringify({ account }) }),
    // 聊天记录（与桌宠版同源，默认就是本机会话）
    // 本机会话 id：控制台和桌宠版共用的那一个，开页面时先问一次
    getSession: () => request("/api/session"),
    getHistory: (sessionId, limit = 100) =>
        request(`/api/history?sessionId=${encodeURIComponent(sessionId)}&limit=${limit}`),
    // 不传 sessionId = 清本机会话（桌宠版那边也会一起清，本来就是同一段对话）
    clearHistory: (sessionId) =>
        request(sessionId ? `/api/history?sessionId=${encodeURIComponent(sessionId)}` : "/api/history", {
            method: "DELETE",
        }),
    // 组网（与桌宠版 electron/net/ipc.ts 的入口一一对应）
    netState: () => request("/api/net/state"),
    netAddresses: () => request("/api/net/addresses"),
    netCanStart: () => request("/api/net/can-start"),
    netStartHost: (expiry) => request("/api/net/host", { method: "POST", body: JSON.stringify({ expiry }) }),
    netIssuePairing: (expiry) => request("/api/net/pairing", { method: "POST", body: JSON.stringify({ expiry }) }),
    netJoin: (code) => request("/api/net/join", { method: "POST", body: JSON.stringify({ code }) }),
    netResume: () => request("/api/net/resume", { method: "POST" }),
    netStop: () => request("/api/net/stop", { method: "POST" }),
    netRevokePairing: (id) => request(`/api/net/pairing/${encodeURIComponent(id)}/revoke`, { method: "POST" }),
    netPrunePairings: () => request("/api/net/pairing/prune", { method: "POST" }),
    netRemoveDevice: (id) => request(`/api/net/device/${encodeURIComponent(id)}/remove`, { method: "POST" }),
    netLeave: () => request("/api/net/leave", { method: "POST" }),
    netRenameSelf: (name) => request("/api/net/name", { method: "PUT", body: JSON.stringify({ name }) }),
    netFlush: () => request("/api/net/flush", { method: "POST" }),
    netSyncWhitelist: () => request("/api/net/sync"),
    netSetSyncWhitelist: (fields) => request("/api/net/sync", { method: "PUT", body: JSON.stringify({ fields }) }),
    netRelayStats: () => request("/api/net/relay-stats"),
    // 数据目录信息（设置页显示读的是哪份数据）
    dataInfo: () => request("/api/data-info"),
};

/**
 * 聊天（SSE 事件流）。
 * 事件：start{sessionId} / done{speech,emotion,model} / error{message}
 * 返回 { abort } —— 点停止时中断连接。
 */
function chatStream({ content, images, sessionId, onEvent }) {
    const ctrl = new AbortController();
    fetch("/api/chat", {
        method: "POST",
        signal: ctrl.signal,
        headers: {
            "Content-Type": "application/json",
            "X-Admin-Token": getToken(),
        },
        body: JSON.stringify({ content, images, sessionId }),
    })
        .then(async (res) => {
            if (!res.ok || !res.body) {
                let msg = `请求失败（${res.status}）`;
                try {
                    const j = await res.json();
                    msg = j.message || msg;
                } catch {}
                if (res.status === 401) {
                    const err = new Error("口令不对");
                    err.authFailed = true;
                    throw err;
                }
                throw new Error(msg);
            }
            // 解析 SSE：按空行分帧，每帧 event: xxx / data: {...}
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buf = "";
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                let idx;
                while ((idx = buf.indexOf("\n\n")) >= 0) {
                    const frame = buf.slice(0, idx);
                    buf = buf.slice(idx + 2);
                    let event = "message";
                    let data = "";
                    for (const line of frame.split("\n")) {
                        if (line.startsWith("event: ")) event = line.slice(7).trim();
                        else if (line.startsWith("data: ")) data += line.slice(6);
                    }
                    if (data) {
                        try {
                            onEvent(event, JSON.parse(data));
                        } catch {}
                    }
                }
            }
        })
        .catch((e) => {
            if (e.name === "AbortError") return;
            onEvent("error", { message: e?.message || "连接断了" , authFailed: e.authFailed });
        });
    return { abort: () => ctrl.abort() };
}
