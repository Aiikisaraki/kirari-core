// src/session/eventStore.js
// EventStore 适配器：把 kirari-agent 的纯契约接到核心版已有的 better-sqlite3 连接上。
//
// 为什么用惰性 require 拿 db：dbStorage.js 的存储层挂钩会 require eventRecorder，
// eventRecorder 又 require 本文件；若这里在顶层 require dbStorage，就会形成
// 「dbStorage 还没导出完 → getDb 是 undefined」的循环。运行时按需取就没这个问题。

const {
    SESSION_EVENTS_TABLE,
    SCHEMA_VERSION,
    DEFAULT_EVENT_QUERY_LIMIT,
    MAX_EVENT_QUERY_LIMIT,
} = require("kirari-agent");

function getDb() {
    return require("../db/dbStorage").getDb();
}

function parsePayload(raw) {
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch (e) {
        // 显式告警，不静默吞：坏 payload 会让投影结果不完整，必须能被发现。
        console.warn("[events] 事件 payload 不是合法 JSON，按空对象处理：", e?.message || e);
        return {};
    }
}

function toAgentEvent(row) {
    return {
        schemaVersion: row.schema_ver,
        origin: row.origin,
        eventId: row.event_id,
        sessionId: row.session_id,
        turnId: row.turn_id,
        seq: row.seq,
        ts: row.ts,
        type: row.type,
        payload: parsePayload(row.payload),
    };
}

const eventStore = {
    // INSERT OR IGNORE 配合 UNIQUE(origin, event_id)：批量 flush 重试不会重复落事件。
    append(events) {
        if (!events || events.length === 0) return;
        const stmt = getDb().prepare(`
            INSERT OR IGNORE INTO ${SESSION_EVENTS_TABLE}
                (origin, event_id, session_id, turn_id, ts, schema_ver, type, payload)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const e of events) {
            stmt.run(
                e.origin,
                e.eventId,
                e.sessionId,
                e.turnId,
                e.ts,
                e.schemaVersion ?? SCHEMA_VERSION,
                e.type,
                JSON.stringify(e.payload ?? {}),
            );
        }
    },

    query(q) {
        const where = ["session_id = ?"];
        const args = [q.sessionId];
        if (q.fromSeq !== undefined) { where.push("seq > ?"); args.push(q.fromSeq); }
        if (q.toSeq !== undefined) { where.push("seq <= ?"); args.push(q.toSeq); }
        if (q.turnId) { where.push("turn_id = ?"); args.push(q.turnId); }
        if (q.types && q.types.length > 0) {
            where.push(`type IN (${q.types.map(() => "?").join(", ")})`);
            args.push(...q.types);
        }
        const n = Math.min(MAX_EVENT_QUERY_LIMIT, Math.max(1, q.limit ?? DEFAULT_EVENT_QUERY_LIMIT));
        args.push(n);
        const rows = getDb().prepare(
            `SELECT seq, origin, event_id, session_id, turn_id, ts, schema_ver, type, payload
             FROM ${SESSION_EVENTS_TABLE}
             WHERE ${where.join(" AND ")} ORDER BY seq ASC LIMIT ?`,
        ).all(...args);
        return rows.map(toAgentEvent);
    },

    maxSeq(sessionId) {
        const db = getDb();
        const row = sessionId
            ? db.prepare(`SELECT MAX(seq) AS m FROM ${SESSION_EVENTS_TABLE} WHERE session_id = ?`).get(sessionId)
            : db.prepare(`SELECT MAX(seq) AS m FROM ${SESSION_EVENTS_TABLE}`).get();
        return row?.m ?? 0;
    },
};

module.exports = { eventStore };
