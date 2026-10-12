// src/knowledge/userKnowledge.js
// 私人知识库（本地条目 + 远程源），与桌宠版 src/knowledge/localKnowledge.ts **同一份
// knowledge.json、同一种检索语义**。
//
// 为什么核心版也要自己存一份：用户拍板「核心版自动接管桌宠版数据」。
// 桌宠版把私人库存在 userData/knowledge.json，核心版读同一个文件，
// 于是桌宠里加的知识，核心版控制台直接能搜到，反之亦然。
//
// 检索策略与桌宠版一致（保持行为可预期）：
//   本地条目 = 同步关键词匹配（所有词都要命中 title/content/tags 之一）；
//   远程源   = 检索时实时抓取（不落本地副本），每源最多 2 条。
const fs = require('fs');
const path = require('path');
const { readJson, writeJsonMerged } = require('../settings/localSettings');

const KB_FILE = 'knowledge.json';
const KNOWN_KEYS = ['entries', 'nextId'];

function load() {
    const raw = readJson(KB_FILE);
    if (!raw || !Array.isArray(raw.entries)) return { entries: [], nextId: 1 };
    return { entries: raw.entries, nextId: Number.isFinite(raw.nextId) ? raw.nextId : 1 };
}

function save(state) {
    return writeJsonMerged(KB_FILE, { entries: state.entries, nextId: state.nextId }, KNOWN_KEYS);
}

function listEntries() {
    return load().entries.map((e) => ({ ...e }));
}

function addEntry(entry) {
    const state = load();
    const id = state.nextId;
    const created = {
        id,
        type: 'local',
        title: String(entry.title || '').trim().slice(0, 120),
        content: String(entry.content || '').trim().slice(0, 20000),
        category: String(entry.category || '').trim().slice(0, 40),
        tags: Array.isArray(entry.tags)
            ? entry.tags.map((t) => String(t).trim().slice(0, 20)).filter(Boolean).slice(0, 10)
            : [],
        source: String(entry.source || '').trim().slice(0, 500),
        createdAt: Date.now(),
    };
    state.entries.push(created);
    state.nextId = id + 1;
    save(state);
    return created;
}

function updateEntry(id, patch) {
    const state = load();
    const idx = state.entries.findIndex((e) => e.id === id && e.type === 'local');
    if (idx < 0) return null;
    const cur = state.entries[idx];
    const next = { ...cur };
    if (patch.title !== undefined) next.title = String(patch.title).trim().slice(0, 120);
    if (patch.content !== undefined) next.content = String(patch.content).trim().slice(0, 20000);
    if (patch.category !== undefined) next.category = String(patch.category).trim().slice(0, 40);
    if (patch.tags !== undefined) {
        next.tags = Array.isArray(patch.tags)
            ? patch.tags.map((t) => String(t).trim().slice(0, 20)).filter(Boolean).slice(0, 10)
            : [];
    }
    if (patch.source !== undefined) next.source = String(patch.source).trim().slice(0, 500);
    state.entries[idx] = next;
    save(state);
    return next;
}

function deleteEntry(id) {
    const state = load();
    const before = state.entries.length;
    state.entries = state.entries.filter((e) => !(e.id === id && e.type === 'local'));
    if (state.entries.length === before) return false;
    save(state);
    return true;
}

// ── 远程源 ────────────────────────────────────────────────────────────

function listRemoteSources() {
    return load().entries.filter((e) => e.type === 'remote');
}

function addRemoteSource(src) {
    const state = load();
    const id = state.nextId;
    const created = {
        id,
        type: 'remote',
        name: String(src.name || '').trim().slice(0, 60),
        url: String(src.url || '').trim().slice(0, 500),
        sourceType: ['mediawiki', 'markdown', 'html', 'rss'].includes(src.sourceType) ? src.sourceType : 'html',
        enabled: src.enabled !== false,
        priority: Number.isFinite(Number(src.priority)) ? Number(src.priority) : 6,
        createdAt: Date.now(),
    };
    state.entries.push(created);
    state.nextId = id + 1;
    save(state);
    return created;
}

function updateRemoteSource(id, patch) {
    const state = load();
    const idx = state.entries.findIndex((e) => e.id === id && e.type === 'remote');
    if (idx < 0) return null;
    const next = { ...state.entries[idx] };
    if (patch.name !== undefined) next.name = String(patch.name).trim().slice(0, 60);
    if (patch.url !== undefined) next.url = String(patch.url).trim().slice(0, 500);
    if (patch.sourceType !== undefined && ['mediawiki', 'markdown', 'html', 'rss'].includes(patch.sourceType)) {
        next.sourceType = patch.sourceType;
    }
    if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
    if (patch.priority !== undefined && Number.isFinite(Number(patch.priority))) next.priority = Number(patch.priority);
    state.entries[idx] = next;
    save(state);
    return next;
}

function deleteRemoteSource(id) {
    const state = load();
    const before = state.entries.length;
    state.entries = state.entries.filter((e) => !(e.id === id && e.type === 'remote'));
    if (state.entries.length === before) return false;
    save(state);
    return true;
}

// ── 检索（与桌宠版 localKnowledge.search 同语义）─────────────────────

/** 关键词全部命中才返回；score 按排名递减。 */
function searchLocal(query, limit = 5) {
    const q = String(query || '').trim();
    if (!q) return [];
    const terms = q.split(/\s+/).map((t) => t.trim()).filter(Boolean).slice(0, 8);
    if (!terms.length) return [];
    const matched = load()
        .entries.filter((e) => e.type === 'local')
        .filter((e) =>
            terms.every(
                (t) =>
                    (e.title || '').includes(t) ||
                    (e.content || '').includes(t) ||
                    (Array.isArray(e.tags) && e.tags.some((tag) => tag.includes(t))),
            ),
        );
    return matched.slice(0, limit).map((r, i) => ({
        text: `【${r.title}】${r.content}`,
        source: '我的私人知识库',
        score: 1 / (i + 1),
        tier: 'A',
        priority: 5,
        url: r.source || undefined,
    }));
}

/** 远程源并发抓取（每源最多 2 条，3 秒超时；失败不阻塞）。 */
async function searchRemote(query, limit = 5) {
    const q = String(query || '').trim();
    if (!q) return [];
    const sources = load().entries.filter((e) => e.type === 'remote' && e.enabled);
    if (!sources.length) return [];
    const { fetchRemoteKnowledge } = require('./remoteFetchers');
    const perSource = await Promise.all(
        sources.map(async (s) => {
            try {
                const results = await fetchRemoteKnowledge(s.url, s.sourceType, q, 2, 3000);
                return results.map((r, i) => ({
                    text: r.text || '',
                    source: s.name || '远程知识源',
                    score: (r.score || 1) * (1 / (i + 1)),
                    tier: 'A',
                    priority: Number.isFinite(s.priority) ? s.priority : 6,
                    url: r.url || s.url,
                }));
            } catch {
                return [];
            }
        }),
    );
    return perSource.flat().slice(0, limit);
}

/** 统一入口：本地 + 远程合并（本地优先，与桌宠版一致）。 */
async function search(query, limit = 5) {
    const local = searchLocal(query, limit);
    const remote = await searchRemote(query, Math.max(0, limit - local.length));
    return [...local, ...remote].slice(0, limit);
}

module.exports = {
    listEntries,
    addEntry,
    updateEntry,
    deleteEntry,
    listRemoteSources,
    addRemoteSource,
    updateRemoteSource,
    deleteRemoteSource,
    searchLocal,
    searchRemote,
    search,
    filePath: () => path.join(require('../dataDir').dataDir, KB_FILE),
};
