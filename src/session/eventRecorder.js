// src/session/eventRecorder.js
// 核心版侧的事件记录器单例。共享包只放纯逻辑，这里负责接 EventStore、读开关、
// 维护「当前轮次」，以及进程退出兜底。

const { createRecorder } = require("kirari-agent");
const { eventStore } = require("./eventStore");

// 存储层挂钩发生在 getReply 之前（入口先存 user 消息），那时还没有轮次，
// 统一记为 "ui"。UI 消息事件不要求与 turn 严格对齐，投影按 sessionId + seq 走。
const NO_TURN = "ui";
let activeTurnId = null;

function newTurnId() {
    return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const recorder = createRecorder(eventStore, {
    // 红线：事件写失败只警告，绝不冒泡到用户。
    onWarn: (message, err) => console.warn(message, err?.message || err || ""),
});

function currentTurnId() {
    return activeTurnId || NO_TURN;
}

function beginTurn(turnId) {
    activeTurnId = turnId || newTurnId();
    return activeTurnId;
}

function endTurn() {
    activeTurnId = null;
}

/**
 * 开关来自 settings_kv.events_enabled（缺省启用），不新增 .env 字段。
 * 读失败时按启用处理并告警，不让「设置读不到」变成静默不记事件。
 */
function refreshEnabled() {
    try {
        const row = require("../db/dbStorage").getDb()
            .prepare("SELECT value FROM settings_kv WHERE key = 'events_enabled'").get();
        recorder.setEnabled(!row || row.value !== "0");
    } catch (e) {
        console.warn("[events] 读取事件开关失败，按启用处理：", e?.message || e);
        recorder.setEnabled(true);
    }
}

refreshEnabled();

// 进程退出兜底：把队列里剩余事件同步落库，避免丢最后几条。
process.on("beforeExit", () => recorder.flushSync());

module.exports = {
    recorder,
    beginTurn,
    endTurn,
    currentTurnId,
    newTurnId,
    refreshEnabled,
    NO_TURN,
};
