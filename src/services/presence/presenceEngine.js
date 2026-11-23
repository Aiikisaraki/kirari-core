// src/services/presence/presenceEngine.js
// 「在场感内核」核心版（CommonJS）。与桌面端 electron/ai/presence/*.ts 语义逐字对齐：
// 改任何一侧的公式/阈值，必须同步另一侧 —— 这是两个仓库的既有约定（对话内核双实现）。
//
// 与桌面端的分工差异：
//   · 桌面端按"本机会话"门控（isOwnerLocalSession）；
//   · 核心端跑在服务器上，面对的是机器人会话（bot-<adapter>-user:<qq>），
//     会话归属由 ownerIdentity.samePerson 判，**只有主人本人的私聊**才写状态。
//
// 纯逻辑：无 I/O、无随机源（rng 注入）、无 Date.now()（now 注入）。

const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

const NEED_KEYS = ['connect', 'care', 'play', 'learn', 'share', 'create', 'rest'];

const DRIVE_DEFAULTS = { connect: 0.45, care: 0.3, play: 0.35, learn: 0.3, share: 0.35, create: 0.25, rest: 0.3 };
const DRIVE_HALF_LIFE_MS = 8 * 3600000;

/** 情绪 → 动作标签（核心端没有动画，但 emotion 会进 pet_response 给前端播）。 */
const EMOTION_TO_LABEL = {
  content: null,
  lonely: 'sad',
  curious: 'head_tilt',
  worried: 'sad',
  excited: 'excited',
  amused: 'happy',
  bored: 'stretch',
  proud: 'happy',
  affectionate: 'shy',
  tired: 'stretch',
  envious: 'sad',
};

const NEED_WORDS = {
  connect: ['想你', '陪我', '在一起', '孤单', '寂寞', '一个人', '无聊', '抱抱', '在吗', '理我', '聊天', '说说话'],
  care: ['累', '困', '加班', '考试', '面试', '生病', '头疼', '头痛', '痛', '难受', '不舒服', '胃疼', '压力', '下雨', '降温', '感冒', '熬夜', '记得吃', '睡好'],
  play: ['玩', '游戏', '联机', '攻略', '追番', '看番', '电影', '新番', '手游', '上分', '逛'],
  learn: ['为什么', '原理', '教程', '怎么', '学习', '研究', '解析', '代码', 'bug', '报错', '实现'],
  share: ['笑死', '离谱', '好看', '可爱', '震惊', '哈哈', '刚看到', '发现', '好好听', '绝了'],
  create: ['写', '画', '剪', '做个', '设计', '主题', '脚本', '视频', '封面', '企划'],
  rest: ['睡', '休息', '晚安', '困了', '眯一会', '打盹', '起不来', '好累'],
};

// 极性词表刻意不收裸「好」：中文里「好累」「好烦」「好难」是负面（桌面端单测钉住的教训）。
const POSITIVE_WORDS = ['太好了', '好棒', '喜欢', '开心', '可以', '一起', '哈哈', '谢谢', '可爱', '厉害', '不错', '想试试'];
const NEGATIVE_WORDS = ['不要', '没空', '不想', '算了', '烦', '难过', '生气', '滚', '别', '累', '加班', '崩溃', '讨厌', '疼', '痛', '难受', '压力'];

function sentimentOf(text) {
  const src = String(text || '');
  if (!src) return 0;
  let score = 0;
  for (const w of POSITIVE_WORDS) if (src.includes(w)) score += 1;
  for (const w of NEGATIVE_WORDS) if (src.includes(w)) score -= 1;
  return score > 0 ? 1 : score < 0 ? -1 : 0;
}

function needAffinity(text) {
  const src = String(text || '');
  const out = {};
  if (!src) return out;
  for (const key of NEED_KEYS) {
    let hits = 0;
    for (const word of NEED_WORDS[key]) if (src.includes(word)) hits += 1;
    if (hits > 0) out[key] = clamp01(0.45 + 0.25 * (hits - 1));
  }
  return out;
}

function arousalOf(text) {
  const src = String(text || '');
  if (!src) return 0;
  let score = 0;
  if (/!+|！+/.test(src)) score += 0.3;
  if (/\?|？+/.test(src)) score += 0.1;
  if (/(.)\1{2,}/.test(src)) score += 0.2;
  return clamp01(score);
}

function energyAt(hour) {
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  if (h >= 2 && h < 6) return 0.15;
  if (h < 9) return 0.45;
  if (h < 12) return 0.8;
  if (h < 15) return 0.6;
  if (h < 19) return 0.85;
  if (h < 23) return 0.6;
  return 0.3;
}

function daypartName(hour) {
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  if (h < 5) return '深夜';
  if (h < 8) return '清早';
  if (h < 11) return '上午';
  if (h < 13) return '中午';
  if (h < 17) return '下午';
  if (h < 19) return '傍晚';
  if (h < 23) return '晚上';
  return '深夜';
}

function decayDrives(drives, from, to, defaults = DRIVE_DEFAULTS) {
  const span = Math.max(0, to - from);
  const remain = Math.pow(0.5, span / DRIVE_HALF_LIFE_MS);
  const out = { ...defaults };
  for (const key of NEED_KEYS) {
    const base = defaults[key];
    out[key] = clamp01(base + ((drives[key] ?? base) - base) * remain);
  }
  return out;
}

/** 有效驱动 = 衰减基线 + 「多久没见你」加成 + 体力反向推高「休息」。只读，永不落盘。 */
function effectiveDrives(state, now) {
  const d = decayDrives(state.drives, state.drivesAt, now);
  const gapHours = Math.max(0, now - state.lastUserAt) / 3600000;
  d.connect = clamp01(Math.max(d.connect, 0.35) + Math.min(0.45, (gapHours / 24) * 0.45));
  const hour = new Date(now).getHours();
  d.rest = clamp01(d.rest + (1 - energyAt(hour)) * 0.25);
  return d;
}

function appraise(input) {
  const { material = null, needs = {}, sinceUserMs, hour, affinity } = input;
  const gapHours = sinceUserMs / 3600000;
  const energy = energyAt(hour);
  const afford = (base) => clamp01(base + affinity * 0.1);
  const sentiment = material ? (material.sentiment ?? 0) : 0;
  const arousal = material ? (material.arousal ?? 0) : 0;
  let strongestNeed = null;
  for (const key of NEED_KEYS) {
    if (!needs[key]) continue;
    if (!strongestNeed || needs[key] > (needs[strongestNeed] ?? 0)) strongestNeed = key;
  }

  if (!material) {
    if (energy <= 0.2) return { emotion: 'tired', intensity: afford(0.6), reason: '深夜，体力见底' };
    if (gapHours >= 8) return { emotion: 'bored', intensity: afford(0.45), reason: '主人已经 ' + Math.round(gapHours) + ' 小时没出现' };
    return { emotion: 'content', intensity: 0.2, reason: '什么都没有发生' };
  }
  if (material.selfRef && gapHours >= 6 && (strongestNeed === 'connect' || strongestNeed === 'learn')) {
    return { emotion: 'lonely', intensity: afford(0.55 + Math.min(0.25, gapHours / 48)), reason: '关于我自己的事 + 主人很久没出现' };
  }
  if (strongestNeed === 'care' && sentiment < 0) {
    return { emotion: 'worried', intensity: afford(0.6 + arousal * 0.2), reason: '主人在说累/难的事' };
  }
  if (strongestNeed === 'connect' && sentiment > 0) {
    return { emotion: 'affectionate', intensity: afford(0.45 + arousal * 0.2), reason: '主人在说陪我/在一起这类事' };
  }
  if ((strongestNeed === 'play' || strongestNeed === 'share') && sentiment > 0 && arousal >= 0.3) {
    return { emotion: 'excited', intensity: afford(0.55 + arousal * 0.3), reason: '好玩 + 高唤醒' };
  }
  if (strongestNeed === 'share' && sentiment > 0) return { emotion: 'amused', intensity: afford(0.45), reason: '有好笑/好看的东西' };
  if (strongestNeed === 'create' && sentiment > 0) return { emotion: 'proud', intensity: afford(0.5), reason: '自己做的作品被夸' };
  if ((strongestNeed === 'learn' || strongestNeed === 'create') && sentiment === 0) {
    return { emotion: 'curious', intensity: afford(0.5 + arousal * 0.2), reason: '遇到想弄明白/想试的事' };
  }
  if (energy <= 0.2) return { emotion: 'tired', intensity: afford(0.5), reason: '深夜，体力见底' };
  if (gapHours >= 8) return { emotion: 'bored', intensity: afford(0.4), reason: '主人很久没出现，素材也没意思' };
  return { emotion: 'content', intensity: 0.25, reason: '没什么特别的' };
}

function localDateKey(now) {
  const d = new Date(now);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

const TOPIC_FILLER = /^(早|早上好|早安|你好|喂|那个|嗯|啊|哦|今天|刚刚|就是|对了)+/;

/** 主题：书名号优先 → 切句挑最贴合主导需求那句 → 剥填充词/悬空虚词 → 12 字。 */
function extractTopic(text) {
  const src = String(text || '').trim();
  if (!src) return '';
  const quoted = /[《「"]([^》」"]{1,24})[》」"]/.exec(src);
  if (quoted) return quoted[1].trim();
  const dominant = (() => {
    const needs = needAffinity(src);
    let best = null;
    for (const key of NEED_KEYS) {
      if (!needs[key]) continue;
      if (!best || needs[key] > (needs[best] ?? 0)) best = key;
    }
    return best;
  })();
  const clauses = src.split(/[，,。！？!?；;、\s]+/u).map((s) => s.trim()).filter(Boolean);
  if (!clauses.length) return '';
  let best = clauses[0];
  let bestScore = -1;
  for (const clause of clauses) {
    const needs = needAffinity(clause);
    const hit = dominant ? (needs[dominant] ?? 0) : 0;
    const total = NEED_KEYS.reduce((sum, key) => sum + (needs[key] ?? 0), 0);
    const score = hit * 2 + total * 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = clause;
    }
  }
  const stripped = best
    .replace(TOPIC_FILLER, '')
    .replace(/^(昨晚|昨天|前天|刚才|刚|现在)/, '')
    .replace(/(到|了|的|和|跟|在|是|有|也|都|还)$/, '')
    .trim();
  return (stripped || best).slice(0, 12);
}

function mineSeeds(materials, state, now, cfg) {
  const drives = effectiveDrives(state, now);
  const byKey = new Map();
  for (const material of materials) {
    const outOfWindow = now - material.at > cfg.materialWindowMs;
    if (outOfWindow && !material.pinned) continue;
    const needs = needAffinity(material.text);
    let dominant = null;
    for (const key of NEED_KEYS) {
      if (!needs[key]) continue;
      if (!dominant || needs[key] > (needs[dominant] ?? 0)) dominant = key;
    }
    if (!dominant) continue;
    const topic = extractTopic(material.text);
    if (!topic) continue;
    const key = dominant + '|' + topic;
    // 被拒绝过的话题一周内不再出现（拒绝记在观察账本上，不是当轮 goal 上）
    const seen = state.observations[key];
    if (seen && seen.negative >= 1 && seen.negative >= seen.positive && now - seen.lastAt < 7 * 86400000) continue;
    const obs = state.observations[key];
    const repeat = Math.min(1, (obs?.seen ?? 0) / 3);
    const freshness = 1 - repeat;
    const window = Math.max(1, cfg.materialWindowMs);
    const recency = Math.max(0, 1 - Math.max(0, now - material.at) / window);
    const score =
      (needs[dominant] ?? 0) * (0.35 + (drives[dominant] ?? 0.3)) +
      (material.selfRef ? 0.35 : 0) +
      (material.ownerRef ? 0.3 : 0) +
      Math.abs(material.sentiment ?? 0) * 0.15 +
      (material.arousal ?? 0) * 0.1 +
      (material.unresolved ? 0.2 : 0) +
      freshness * 0.2 +
      recency * 0.1 +
      (material.weight ?? 0.5) * 0.15;
    const seed = { material, needs, dominant, topic, key, score };
    const prev = byKey.get(key);
    if (!prev || seed.score > prev.score) byKey.set(key, seed);
  }
  return [...byKey.values()].sort((a, b) => b.score - a.score);
}

const SOURCE_TRUST = { chat: 0.9, memory: 0.7, brief: 0.55, schedule: 0.8, pending: 0.8, time: 0.5 };

function actionForNeed(need, owner, unresolved) {
  if (unresolved) return 'follow';
  switch (need) {
    case 'connect': return owner === 'self' ? 'confide' : 'invite';
    case 'care': return 'care';
    case 'play': return 'invite';
    case 'learn': return 'curiosity';
    case 'share': return 'share';
    case 'create': return 'share';
    case 'rest': return 'confide';
    default: return 'share';
  }
}

function riskFor(action, need) {
  if (action === 'ask') return 0.55;
  if (action === 'confide') return 0.15;
  if (need === 'rest') return 0.2;
  if (action === 'care') return 0.1;
  if (action === 'invite') return 0.1;
  return 0.05;
}

const INTENT_BY_ACTION = {
  share: (t) => '想跟主人说说「' + t + '」这件事',
  ask: (t) => '想问主人一件关于「' + t + '」的事',
  invite: (t) => '想拉主人一起做「' + t + '」',
  confide: (t) => '心里有点关于「' + t + '」的话想说',
  curiosity: (t) => '对「' + t + '」有点好奇，想弄明白',
  follow: (t) => '「' + t + '」上次还没说完，想接着问',
  care: (t) => '想问问主人「' + t + '」的事',
};

function formGoals(seeds, state, now, cfg) {
  const drives = effectiveDrives(state, now);
  const goals = [];
  for (const seed of seeds.slice(0, Math.max(1, cfg.maxGoals))) {
    const m = seed.material;
    const owner = m.ownerRef ? 'owner' : m.selfRef ? 'self' : 'media';
    const obs = state.observations[seed.key];
    const repeat = Math.min(1, (obs?.seen ?? 0) / 3);
    const drive = drives[seed.dominant] ?? 0.3;
    const confidence = clamp01(
      0.15 +
        (m.selfRef ? 0.22 : 0) +
        repeat * 0.2 +
        (m.unresolved ? 0.1 : 0) +
        (SOURCE_TRUST[m.source] ?? 0.5) * 0.1 +
        drive * 0.08,
    );
    const value = clamp01(0.3 + 0.35 * drive + (m.selfRef ? 0.2 : 0) + 0.15 * repeat);
    const urgency = clamp01(0.15 + (m.ownerRef ? 0.35 : 0) + (m.unresolved ? 0.2 : 0));
    const action = actionForNeed(seed.dominant, owner, Boolean(m.unresolved));
    goals.push({
      id: 'g-' + seed.key + '-' + Math.round(m.at),
      owner,
      need: seed.dominant,
      action,
      topic: seed.topic,
      intent: INTENT_BY_ACTION[action](seed.topic),
      confidence,
      value,
      urgency,
      risk: riskFor(action, seed.dominant),
      status: 'hypothesis',
      evidenceIds: [m.id],
      attempts: 0,
      createdAt: now,
    });
  }
  return goals;
}

function goalWeight(goal, state, drives, now) {
  let weight = 0.55 + goal.confidence * 0.7 + goal.value * 0.35 - goal.risk * 0.25;
  weight *= 0.65 + 0.55 * (drives[goal.need] ?? 0);
  const recent = state.recentNeeds ?? [];
  if (recent.length >= 2 && recent.slice(-2).every((n) => n === goal.need)) weight *= 0.65;
  else if (recent.length >= 1 && recent.slice(-3).includes(goal.need)) weight *= 0.72;
  if (goal.id === state.lastGoalId) weight *= 0.35;
  if (goal.lastActionAt && now - goal.lastActionAt < 12 * 3600000) weight *= 0.6;
  return Math.max(0, weight);
}

function pickGoal(goals, state, now, rng = Math.random) {
  const drives = effectiveDrives(state, now);
  const candidates = goals.filter((g) => g.status !== 'rejected' && g.status !== 'done' && g.status !== 'expired' && g.confidence >= 0.25);
  if (!candidates.length) return null;
  const weights = candidates.map((g) => goalWeight(g, state, drives, now));
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (total <= 0) return candidates[0];
  let roll = Math.abs(rng()) * total;
  for (let i = 0; i < candidates.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return candidates[i];
  }
  return candidates[candidates.length - 1];
}

function parseHHMM(value, fallback = '08:00') {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim()) || /^(\d{1,2}):(\d{2})$/.exec(fallback);
  if (!m) return 8 * 60;
  const hh = Math.max(0, Math.min(23, Number(m[1])));
  const mm = Math.max(0, Math.min(59, Number(m[2])));
  return hh * 60 + mm;
}

function inQuietHours(cfg, now) {
  const start = parseHHMM(cfg.quietStart, '23:30');
  const end = parseHHMM(cfg.quietEnd, '08:00');
  if (start === end) return false;
  const d = new Date(now);
  const minutes = d.getHours() * 60 + d.getMinutes();
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

function quietEndAfter(cfg, now) {
  const end = parseHHMM(cfg.quietEnd, '08:00');
  const d = new Date(now);
  d.setHours(Math.floor(end / 60), end % 60, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function scheduleNext(now, cfg, rng) {
  const min = Math.max(1000, cfg.gapMinMs);
  const max = Math.max(min, cfg.gapMaxMs);
  const at = now + min + Math.abs(rng()) * (max - min);
  if (!inQuietHours(cfg, at)) return at;
  return quietEndAfter(cfg, at) + Math.abs(rng()) * 20 * 60000;
}

const DEFAULT_PRESENCE_CONFIG = {
  enabled: true,
  focus: false,
  gapMinMs: 2.5 * 3600000,
  gapMaxMs: 5 * 3600000,
  initialDelayMs: 20 * 60000,
  dailyMax: 4,
  quietStart: '23:30',
  quietEnd: '08:00',
  idleThresholdMs: 30 * 60000,
  materialWindowMs: 72 * 3600000,
  minMaterials: 1,
  maxGoals: 5,
  retryMs: 15 * 60000,
  maxAttempts: 3,
  pendingTtlDays: 14,
  historyLimit: 40,
};

function planOutreach(input) {
  const { cfg, now } = input;
  const rng = input.rng || Math.random;
  const state = { ...input.state, observations: { ...input.state.observations } };
  const seeds = mineSeeds(input.materials, state, now, cfg);
  const base = { seeds, goal: null, goals: [], state };

  const hold = (reason, nextAt) => ({ ...base, fire: false, reason, nextAt });

  if (!cfg.enabled) return hold('开关关着', state.nextFireAt);
  if (cfg.focus) return hold('专注模式（不主动打扰）', state.nextFireAt);
  if (inQuietHours(cfg, now)) return hold('安静时段', state.nextFireAt);

  const today = localDateKey(now);
  if (state.outreachDate !== today) {
    state.outreachDate = today;
    state.outreachToday = 0;
  }
  if (cfg.dailyMax > 0 && state.outreachToday >= cfg.dailyMax) {
    return hold('今天已经主动说过 ' + state.outreachToday + ' 次', state.nextFireAt);
  }
  if (now - state.lastUserAt < cfg.idleThresholdMs) return hold('主人刚说过话，不插嘴', state.nextFireAt);
  if (now < state.nextFireAt) {
    const mins = Math.round((state.nextFireAt - now) / 60000);
    return hold('还没到点（还有 ' + mins + ' 分钟）', state.nextFireAt);
  }

  for (const seed of seeds) {
    const obs = state.observations[seed.key];
    state.observations[seed.key] =
      obs && now - obs.lastAt < 3600000
        ? { ...obs, lastAt: now }
        : {
            key: seed.key,
            topic: seed.topic,
            seen: (obs?.seen ?? 0) + 1,
            positive: obs?.positive ?? 0,
            negative: obs?.negative ?? 0,
            lastAt: now,
          };
  }

  const realMaterials = seeds.filter((s) => s.material.source !== 'time').length;
  const goals = formGoals(seeds, state, now, cfg);
  const pendingSeeds = state.pending.length;
  if (realMaterials < cfg.minMaterials && pendingSeeds === 0 && goals.length === 0) {
    return hold('手里没有值得一提的事，不硬找话', now + cfg.gapMinMs);
  }
  const goal = pickGoal(goals, state, now, rng);
  if (!goal) return hold('有素材但没有成型的目标', now + cfg.gapMinMs);
  return { fire: true, reason: goal.intent, goal, goals, seeds, nextAt: scheduleNext(now, cfg, rng), state };
}

/** 落盘只写衰减基线（不写带浮动加成的读数），防止驱动棘轮漂移。 */
function commitOutreach(state, input) {
  const { goal, now, kind, cfg } = input;
  const rng = input.rng || Math.random;
  const next = { ...state, goals: state.goals.slice(), observations: { ...state.observations } };
  const drives = decayDrives(state.drives, state.drivesAt, now);
  const today = localDateKey(now);
  if (next.outreachDate !== today) {
    next.outreachDate = today;
    next.outreachToday = 0;
  }

  if (kind === 'sent') {
    next.outreachToday += 1;
    next.lastOutreachAt = now;
    next.lastSelfAt = now;
    if (goal) {
      drives[goal.need] = clamp01(drives[goal.need] * (goal.action === 'confide' ? 0.45 : 0.55));
      next.lastGoalId = goal.id;
      next.recentNeeds = [...(next.recentNeeds ?? []), goal.need].slice(-3);
      const idx = next.goals.findIndex((g) => g.id === goal.id);
      const updated = { ...goal, attempts: goal.attempts + 1, lastActionAt: now, status: 'active' };
      if (idx >= 0) next.goals[idx] = updated;
      else next.goals.push(updated);
    }
    next.drives = drives;
    next.drivesAt = now;
    next.mood = { emotion: 'content', intensity: 0.3, at: now, reason: '刚跟主人说过话' };
    next.nextFireAt = scheduleNext(now, cfg, rng);
    return next;
  }

  if (kind === 'silent') {
    if (goal) {
      drives[goal.need] = clamp01(drives[goal.need] * 0.85);
      const idx = next.goals.findIndex((g) => g.id === goal.id);
      if (idx >= 0) next.goals[idx] = { ...next.goals[idx], attempts: next.goals[idx].attempts + 1 };
    }
    next.drives = drives;
    next.drivesAt = now;
    next.nextFireAt = scheduleNext(now, cfg, rng);
    return next;
  }

  const attempts = goal ? goal.attempts + 1 : 1;
  if (goal) {
    const idx = next.goals.findIndex((g) => g.id === goal.id);
    if (idx >= 0) next.goals[idx] = { ...next.goals[idx], attempts };
  }
  next.nextFireAt = attempts >= cfg.maxAttempts ? scheduleNext(now, cfg, rng) : now + cfg.retryMs;
  return next;
}

function reconcileReplies(state, goalId, replyText, now) {
  const next = { ...state, goals: state.goals.slice(), observations: { ...state.observations } };
  const idx = next.goals.findIndex((g) => g.id === goalId);
  if (idx < 0) return next;
  const goal = { ...next.goals[idx] };
  const sentiment = sentimentOf(replyText);
  if (sentiment > 0) {
    goal.status = 'confirmed';
    goal.confidence = clamp01(goal.confidence + 0.15);
  } else if (sentiment < 0) {
    goal.status = 'rejected';
    goal.confidence = clamp01(goal.confidence - 0.25);
  } else {
    goal.confidence = clamp01(goal.confidence + 0.02);
  }
  next.goals[idx] = goal;
  const key = goal.need + '|' + goal.topic;
  const obs = next.observations[key] ?? { key, topic: goal.topic, seen: 1, positive: 0, negative: 0, lastAt: now };
  next.observations[key] = {
    ...obs,
    positive: obs.positive + (sentiment > 0 ? 1 : 0),
    negative: obs.negative + (sentiment < 0 ? 1 : 0),
    lastAt: now,
  };
  return next;
}

function bumpForNeeds(drives, needs, gain) {
  const out = { ...drives };
  for (const key of NEED_KEYS) {
    const amount = needs[key];
    if (!amount) continue;
    out[key] = clamp01(out[key] + amount * gain);
  }
  return out;
}

/** 主人说了一句话 → 更新状态（驱动/间隔/心情）。 */
function recordUserTurn(state, text, now) {
  const needs = needAffinity(text);
  const base = decayDrives(state.drives, state.drivesAt, now);
  const drives = bumpForNeeds(base, needs, 0.22);
  const affinity = clamp01(state.affinity + 0.01);
  const material = {
    id: 'chat-' + now,
    source: 'chat',
    text,
    at: now,
    ownerRef: true,
    sentiment: sentimentOf(text),
    arousal: Math.min(1, (String(text).match(/[!！]/g)?.length ?? 0) * 0.2),
  };
  const appraisal = appraise({
    material,
    needs,
    sinceUserMs: now - state.lastUserAt,
    hour: new Date(now).getHours(),
    affinity,
  });
  return {
    ...state,
    drives,
    drivesAt: now,
    affinity,
    lastUserAt: now,
    mood: { emotion: appraisal.emotion, intensity: appraisal.intensity, at: now, reason: appraisal.reason },
  };
}

/** 她自己回了一句话 → 只更新 mood（情绪有惯性的最小实现）。 */
function appraiseReply(state, speech, emotionLabel, now) {
  const labelMap = {
    happy: 'excited', excited: 'excited', wave: 'excited',
    shy: 'affectionate', sad: 'lonely', angry: 'worried',
    nod: 'content', bow: 'content', surprised: 'curious',
    thinking: 'curious', head_tilt: 'curious', attention: 'content', stretch: 'content',
  };
  const emotion = labelMap[emotionLabel] ?? null;
  const arousal = Math.min(1, (String(speech).match(/[!！]/g)?.length ?? 0) * 0.2 + (emotionLabel === 'excited' ? 0.3 : 0));
  return {
    ...state,
    mood: {
      emotion: emotion ?? 'content',
      intensity: Math.min(1, 0.35 + arousal * 0.3),
      at: now,
      reason: emotionLabel ? '刚才的回复带了「' + emotionLabel + '」' : '刚才那段话的语气',
    },
  };
}

const NEED_LABEL = {
  connect: '想有人陪', care: '想关心你', play: '想玩点什么',
  learn: '想弄明白点什么', share: '想分享点什么', create: '想动手做点什么', rest: '想歇一会儿',
};

function clockText(now) {
  const d = new Date(now);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function gapText(ms) {
  const min = Math.round(ms / 60000);
  if (min < 2) return '刚刚还在说话';
  if (min < 60) return min + ' 分钟';
  const h = Math.round(min / 60);
  if (h < 24) return h + ' 小时';
  return Math.round(h / 24) + ' 天';
}

/** 注入 system 的「此刻的你」。 */
function buildPresenceBlock(state, now) {
  if (!state || state.version !== 1) return '';
  const drives = effectiveDrives(state, now);
  const hour = new Date(now).getHours();
  const energy = energyAt(hour);
  const sinceUser = Math.max(0, now - state.lastUserAt);
  const sinceSelf = Math.max(0, now - state.lastSelfAt);

  const top = NEED_KEYS.map((key) => ({ key, v: drives[key] ?? 0 }))
    .sort((a, b) => b.v - a.v)
    .filter((x) => x.v >= 0.5)
    .slice(0, 2)
    .map((x) => NEED_LABEL[x.key] + '（' + Math.round(x.v * 100) + '）');

  const lines = [];
  lines.push('【此刻的你】');
  lines.push('· 现在 ' + clockText(now) + '，' + daypartName(hour) + '。' + (energy <= 0.25 ? '你已经很困了，说话比平时更短、更慢。' : ''));
  lines.push('· 上次和对方说话是 ' + gapText(sinceUser) + '前' + (sinceSelf < sinceUser ? '；你上次主动开口是' + gapText(sinceSelf) + '前。' : '。'));
  if (state.mood) lines.push('· 你现在的心情：' + state.mood.emotion + '（' + state.mood.reason + '），强度 ' + Math.round(state.mood.intensity * 100) + '%。');
  if (top.length) lines.push('· 此刻最想要的是：' + top.join('、') + '。');
  if (state.pending.length) lines.push('· 心里还惦记着：' + state.pending.slice(0, 3).map((p) => '「' + p.text + '」').join('、') + '。');
  lines.push('· 这些只是你此刻的状态，**不要**把它们念出来，也不要提「状态」「心情值」「驱动」这类词；它只应该体现在：你挑什么话题、句子长短、语气松紧、以及要不要主动问一句。');
  return lines.join('\n');
}

/** 说话节奏约束：深夜/低落 → 硬上限 40 字 + 短回许可；正常 → 软上限。 */
function buildPaceBlock(state, now) {
  if (!state || state.version !== 1) return '';
  const hour = new Date(now).getHours();
  const energy = energyAt(hour);
  const mood = state.mood?.emotion ?? 'content';
  const sad = mood === 'lonely' || mood === 'tired' || mood === 'worried';
  if (energy <= 0.3 || sad) {
    return [
      '【此刻的说话节奏】',
      energy <= 0.3 ? '· 现在是深夜/清晨，你很困：回复不超过 40 字，语气可以懒一点、慢一点。' : '· 你现在心情不高：回复不超过 40 字，话少一点是正常的，不用强行轻松。',
      '· 一两个字也完全可以：嗯。/ 好。/ 在听。/ 困了… 这都是合法回复。',
      '· 不要反问，不要为了把话接下去而硬找话题。',
    ].join('\n');
  }
  return '【此刻的说话节奏】正常聊天时也请克制：多数回复控制在两三句以内；有实质内容（解释/步骤/列表）才可以长。';
}

function summarizePresence(state, now) {
  if (!state) return '还没有状态';
  const drives = effectiveDrives(state, now);
  const top = NEED_KEYS.map((key) => ({ key, v: drives[key] ?? 0 })).sort((a, b) => b.v - a.v)[0];
  const mood = state.mood ? state.mood.emotion : 'content';
  return '心情 ' + mood + ' · 最想要 ' + NEED_LABEL[top.key] + ' ' + Math.round(top.v * 100) + '% · 今天主动说过 ' + state.outreachToday + ' 次';
}

/** 主动搭话提示词：给候选方向，允许 SKIP。 */
function buildOutreachPrompt(input) {
  const { goal, goals, state, now, cfg } = input;
  const drives = effectiveDrives(state, now);
  const top = NEED_KEYS.map((key) => ({ key, v: drives[key] ?? 0 }))
    .sort((a, b) => b.v - a.v)
    .slice(0, 2)
    .map((x) => x.key + ' ' + Math.round(x.v * 100) + '%')
    .join(' / ');
  const gapMin = Math.round((now - state.lastUserAt) / 60000);
  const gapText2 = gapMin < 60 ? gapMin + ' 分钟' : Math.round(gapMin / 60) + ' 小时';
  const d = new Date(now);
  const clock = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  const pending = state.pending.slice(0, 3).map((p) => '「' + p.text + '」').join('、');

  const candidates = goals
    .filter((g) => g.status !== 'rejected' && g.status !== 'done')
    .slice(0, Math.max(1, cfg.maxGoals))
    .map((g, i) => (i + 1) + '. ' + g.intent + '（置信度 ' + Math.round(g.confidence * 100) + '%，' + (g.action === 'ask' ? '只能问，别替主人决定' : '可以直接说') + '）')
    .join('\n');

  const lines = [
    '【主动找主人说一句话】现在是 ' + clock + '，你已经 ' + gapText2 + ' 没和主人说话了。',
    '你此刻的状态：情绪 ' + (state.mood?.emotion ?? 'content') + '（' + (state.mood?.reason ?? '没什么特别的') + '）；最想要的是 ' + top + '。',
  ];
  if (pending) lines.push('心里还惦记着：' + pending + '。');
  lines.push('这次可以先冒出来的念头：', '→ ' + (goal ? goal.intent : '随你，想说什么都行'));
  if (candidates) lines.push('备选方向（可以改写、可以换、也可以都不用）：', candidates);
  lines.push(
    '要求：',
    '· 用你自己的口吻，1~2 句就够，像随口说的，不要小作文；',
    '· 结合你此刻的状态，但**不要把状态念出来**，也不要提「定时」「机制」「状态」「驱动」这类词；',
    '· 不要重复你最近说过的话；不要问「你在吗」这种空问题，要具体；',
    '· 如果实在没话说，只输出一行：SKIP（这比硬找话好）；',
    '· 直接输出你要说的那句话，不要 JSON、不要引号、不要解释。',
  );
  return lines.join('\n');
}

module.exports = {
  clamp01, NEED_KEYS, DEFAULT_PRESENCE_CONFIG,
  energyAt, daypartName, decayDrives, effectiveDrives, appraise,
  needAffinity, sentimentOf, arousalOf, extractTopic,
  mineSeeds, formGoals, goalWeight, pickGoal,
  inQuietHours, quietEndAfter, scheduleNext,
  planOutreach, commitOutreach, reconcileReplies,
  recordUserTurn, appraiseReply,
  buildPresenceBlock, buildPaceBlock, summarizePresence, buildOutreachPrompt,
  EMOTION_TO_LABEL,
};
