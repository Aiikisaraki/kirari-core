// src/services/conversationService.js
// 对话主流程编排：意图预检 → 位置/工具处理 → 构建上下文与 system 提示 → LLM 多轮 tool-call loop。
// 纯编排层，具体的提示拼装、意图识别、流式调用、回复解析均已下沉到 ./reply/* 子模块。

const { parseModelReply, isValidImageUrl } = require('./reply/parser');
const {
  buildBasePrompt,
  buildSystemPrompts,
  getRequestTimeout,
  locationSetMessage,
  buildLocationSetRaw,
  LOCATION_ASK_MESSAGE,
  stripNonConversational,
} = require('./reply/promptBuilder');
const { preflightTools, detectCorrectionIntent } = require('./reply/intent');
const { streamChatCompletion, polishToolResult } = require('./reply/streaming');
const dailyBriefing = require('./dailyBriefingService');
const knowledgeRetrieval = require('../knowledge/retrievalService');
// 阶段 D：统一能力注册表（scope 隔离 + 超时 + 截断），SKILL.md 目录摘要。
const capabilities = require('../capabilities/registry');
const skillMd = require('../skills/skillMd');
const sessionManager = require('../session/sessionManager');
// 事件流：把「模型看到的东西」收归 append-only 事件流。
// 共享包只放纯逻辑，db 连接由 eventRecorder/eventStore 注入（不碰 native 模块）。
const {
  createInjector,
  buildSystemContent,
  AgentRunner,
  webSearchCapFor,
  computeLoopTimeout,
} = require('kirari-agent');
const { recorder, beginTurn, endTurn, newTurnId } = require('../session/eventRecorder');
const modelConfigFile = require('./modelConfigFile');
// 阶段 C 任务编排：plan / schedule_reminder 工具分派 + 未完成任务跨轮恢复。
const taskRuntime = require('./taskRuntime');

// 工具循环参数已从硬编码常量收进 config.json 的 agentProfile（阶段 B）。
// 数值逐字等于改造前的 MAX_ROUNDS=5 / max_tokens=1500 / 超时 60s+15s*轮-封顶120s。

// 兜底收尾：当模型在工具循环末尾只吐了 reasoning / 流被截断而 content 为空时，
// 用 tools:undefined + 一句强指令强制模型直接产出最终文本（不再调用任何工具）。
// 自带独立 AbortController（不与主请求共享），避免主超时已触发导致救回也一并被掐断。
async function salvageAsText(aiContext, messages, onDelta = null, profile = null) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 60000);
  try {
    // 若末尾是一条被截断的空 assistant 消息，先移除，避免部分供应商拒绝空 content。
    const cleaned = messages.filter(
      (m, i) =>
        !(i === messages.length - 1 && m.role === 'assistant' && (!m.content || !m.content.trim()) && (!m.tool_calls || m.tool_calls.length === 0)),
    );
    const FORCE = '\n\n[系统] 你必须现在直接给出最终回复，不要再调用任何工具。用你平时和主人说话的口吻回答即可。';
    const patched = cleaned.map((m) =>
      m.role === 'system' ? { ...m, content: (m.content || '') + FORCE } : m,
    );
    // 前面流出去的碎片已作废（主请求没产出可用 content），先让调用方清空
    if (onDelta) {
      try { onDelta(null); } catch {}
    }
    const completion = await streamChatCompletion(
      aiContext.openai,
      { model: aiContext.model, messages: patched, max_tokens: profile ? profile.maxTokens : 1500 },
      { signal: ctrl.signal, onDelta },
    );
    return completion.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(tid);
  }
}

async function getReply({ aiContext, content = '', images = [], sessionId, clientIp = '', locationScope = null, skillPrompts = [], persona = null, kbContext = null, ws = null, scopeId = null, onDelta = null } = {}) {
  // 阶段 D：能力作用域。优先用调用方显式传入；否则从 ws 派生（WS 链路）；再否则回退到 uid。
  // 这是 frontend 工具与技能执行器的隔离维度——A 连接注册的工具不会出现在 B 连接。
  const capScope = scopeId || (ws ? capabilities.scopeKey('ws', ws.__capScopeId || String(ws.authUid || 'anon')) : capabilities.scopeKey('local', String(aiContext.userid ?? 'anon')));
  // onDelta：正文逐字回调（上层做流式展示）。约定：
  //   onDelta(text)  —— 追加一段正文增量
  //   onDelta(null)  —— 前面流出的内容作废（工具轮碎片/换收尾路径），调用方应清空
  // 回调抛出的异常一律吞掉：流式展示是锦上添花，绝不能因为它打断生成。
  if (!aiContext || aiContext.closed || !aiContext.openai) {
    throw new Error('AI 连接上下文不可用');
  }

  const text = content.trim();
  const imgList = Array.isArray(images)
    ? images.filter((x) => typeof x === 'string' && x.trim() && isValidImageUrl(x))
    : [];

  // 人格基座：自定义人格优先，缺省回退预设。各分支 prompt 全部由此派生，
  // 因此无论选用哪个模型、走哪条分支，人格锚点都一致，不会漂移。
  const base = buildBasePrompt(persona);

  // ── 由 base（人格基座）派生各分支 system 提示 ──
  const sys = buildSystemPrompts(base);

  if (!text && imgList.length === 0) {
    throw new Error('消息不能为空');
  }

  // 本轮工具循环参数从 config.json 的 agentProfile 读（改配置立即生效，fs.watch 同步）。
  // 缺配置 / 坏值显式报错，不回退默认值——让配错可见。
  const profile = modelConfigFile.getAgentProfile();

  const controller = new AbortController();
  // 超时随"可能触发的工具轮次"放大：基线取消息复杂度超时，
  // 再按 profile 的轮数 × 每轮预留放大，封顶由 profile 决定（数值见 computeLoopTimeout）。
  const baseTimeout = getRequestTimeout(text || '[用户发送了图片]');
  const timeout = computeLoopTimeout(profile, baseTimeout);
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  aiContext.activeRequests.add(controller);
  const _t0 = Date.now();
  console.log(`[getReply] === 开始处理 "${text.slice(0, 40)}" @${_t0}`);

  // 一轮对话一个 turnId。8 个早退 return 全部经由下面的 finally 收口，
  // 所以 turn_start / turn_end 成对出现，不需要改任何 if 判断。
  const turnId = newTurnId();
  beginTurn(turnId);

  try {
    recorder.enqueue({
      origin: 'core',
      sessionId,
      turnId,
      type: 'turn_start',
      payload: { userid: aiContext.userid, model: aiContext.model, maxRounds: profile.maxRounds, sessionId },
    });
    // ── Step 1: 意图预检 ──
    //   时间/天气等 direct 工具 → 取回数据后交给 LLM 润色（见下方 direct 路径）
    //   搜索类非 direct 工具 → 收集结果用于后续注入 prompt
    //   位置相关：未存位置先追问一次；用户说"我在X/更新位置"则持久化
    console.log(`[getReply] Step1 preflightTools 调用前 @${Date.now()}`);
    const preflight = await preflightTools(text || '[用户发送了图片]', aiContext, clientIp, sessionId, locationScope);
    console.log(`[getReply] Step1 完成 needLocation=${preflight.needLocation} direct=${!!preflight.direct} 耗时=${Date.now() - _t0}ms`);

    // 需要位置但未获取：先问用户一次（不调工具、不调 LLM，直接返回追问语）
    if (preflight.needLocation) {
      console.log('[aiReply] location required but missing, asking user once');
      return {
        speech: LOCATION_ASK_MESSAGE,
        emotion: 'wave',
        action: 'idle',
        mood: 'curious',
        source: 'location_ask',
        model: aiContext.model,
        usage: null,
        sessionId,
        userid: aiContext.userid,
      };
    }

    // 位置设置确认：把"已记录的行政区划"交给 LLM，用桌宠口吻告诉主人"我记成了 X"，
    // 并友好请其确认/纠正（若记错，主人往往会补更精确的地址，便于后续查询）。
    // LLM 润色失败则回退到兜底提示语（locationSetMessage）。
    let confirmSpeech = null;
    if (preflight.setLocation) {
      const raw = buildLocationSetRaw(preflight.setLocation.location, preflight.setLocation.ambiguous);
      try {
        console.log('[aiReply] location set, polishing confirmation via LLM...');
        const c = await polishToolResult(raw, aiContext, sessionId, text, controller, sys.locationSet, onDelta);
        confirmSpeech = c.speech;
      } catch (e) {
        console.warn('[aiReply] 位置设置确认润色失败，回退到底层提示语：', e?.message || e);
        confirmSpeech = locationSetMessage(preflight.setLocation.location, preflight.setLocation.ambiguous);
      }
    }

    // direct 命中（时间/天气）：先取回工具原始数据，再交给 LLM 润色成符合人设的口语；
    // 若 LLM 调用失败 / 无有效回复，则回退到工具原始结果直接返回，保证永远有应答。
    // 若本轮同时进行了位置设置（合并句/追问回复式 设置+查询），把设置确认语拼接在正文之后。
    if (preflight.direct) {
      const rawText = preflight.direct.raw || preflight.direct.speech;
      const fallback = {
        speech: preflight.direct.speech,
        emotion: preflight.direct.emotion,
        action: 'idle',
        mood: 'curious',
        source: 'tool_direct',
        model: aiContext.model,
        usage: null,
        sessionId,
        userid: aiContext.userid,
      };
      try {
        console.log('[aiReply] direct tool hit, polishing via LLM...');
        const polishUserText = preflight.direct.userText || text;
        const polished = await polishToolResult(rawText, aiContext, sessionId, polishUserText, controller, sys.polish, onDelta);
        console.log('[aiReply] polished reply via LLM OK');
        if (confirmSpeech) {
          // 合并句：时间/天气答复 + 位置设置确认（两者均经 LLM 润色）
          return { ...polished, speech: `${polished.speech}\n${confirmSpeech}`, source: 'model' };
        }
        return polished;
      } catch (e) {
        console.warn('[aiReply] LLM 润色失败，回退到工具直接回复：', e?.message || e);
        if (confirmSpeech) {
          return { ...fallback, speech: `${fallback.speech}\n${confirmSpeech}` };
        }
        return fallback;
      }
    }

    // 仅有位置设置确认（无 direct 查询）：返回润色后的确认语
    if (confirmSpeech) {
      console.log('[aiReply] location set confirmation (no query), returning polished confirm');
      return {
        speech: confirmSpeech,
        emotion: 'happy',
        action: 'idle',
        mood: 'curious',
        source: 'location_set',
        model: aiContext.model,
        usage: null,
        sessionId,
        userid: aiContext.userid,
      };
    }

    // ── Step 2: 构建 messages 并调用 LLM ──
    const recentMessages = await sessionManager.getRecentMessages(sessionId, 6);

    // 主动感知：确保当日简报已就绪，并注入 system prompt，让回答基于"当日记忆"。
    // 当天首次会触发采集+压缩（失败静默降级，绝不阻塞主对话）。
    let dailyBlock = '';
    try {
      const brief = await dailyBriefing.ensureDailyBrief(aiContext);
      if (brief) {
        dailyBlock =
          `\n\n【今日背景 · 已自动了解，可作参考】\n日期：${dailyBriefing.todayStr()}\n` +
          `${brief}\n（以上为截止今日的已知信息；若你不确定具体实时事实，仍可使用工具核实。）`;
      }
    } catch (e) {
      console.warn('[aiReply] 简报注入失败（已忽略）:', e?.message || e);
    }

    // 知识库检索（Layer 2 推荐源：离线植入 > 免注册实时；Layer 1 私有库启用后自然优先）。
    // 在作答前检索并注入参考信息，让桌宠在基础问题上更有底。失败静默降级，绝不阻塞主对话。
    let kbBlock = '';
    try {
      kbBlock = await knowledgeRetrieval.retrieveForPrompt(aiContext, text || '[用户发送了图片]', { kbContext, ws });
    } catch (e) {
      console.warn('[aiReply] 知识库检索失败（已忽略）:', e?.message || e);
    }

    let systemPrompt = preflight.injected
      ? sys.withTools.replace('{{TOOL_RESULTS}}', preflight.injected.join('\n'))
      : sys.normal;
    // 阶段 C：把该会话尚未完成的任务拼进 system.base，让「新消息进来先恢复未完成任务」
    // 成立——进程重启后任务在库里，下一条消息自然恢复。注入段数不变（仍 4 段）。
    const taskResume = taskRuntime.resumeBlock(sessionId);
    if (taskResume) systemPrompt += taskResume;

    // 阶段 D：SKILL.md 渐进披露——system 里只放「name: description」目录摘要，
    // 模型需要时用 load_skill(name) 才加载正文（装十个技能也不再全量吃 token）。
    const skillCatalog = skillMd.catalogBlock();
    // 前端 WS 链路 register_skills 上报的行为模板仍保留（与 SKILL.md 是两类能力）。
    const skillBlock =
      (Array.isArray(skillPrompts) && skillPrompts.length
        ? '\n\n# 已启用的技能（请遵循以下设定）\n' + skillPrompts.join('\n\n')
        : '') + skillCatalog;

    // 历史消息 content 可能是字符串，或 [text, image_url] 多模态数组（JSON 序列化存储）；
    // 统一归一化为 OpenAI 消息格式，确保发送过的图片在上下文里不被丢弃。
    // 同时剔除启动问候语等系统噪声，避免污染 LLM 上下文。
    const normalizedRecent = stripNonConversational(recentMessages).map((m) => {
      const c = m.content;
      // 过滤历史中残留的非法图片条目（裸文件名 / base64:... 等），避免送进模型导致 500。
      const dropBadImage = (arr) =>
        Array.isArray(arr)
          ? arr.filter(
              (part) =>
                !(part && part.type === 'image_url' && !isValidImageUrl(part.image_url && part.image_url.url)),
            )
          : arr;
      if (Array.isArray(c)) return { role: m.role, content: dropBadImage(c) };
      if (typeof c === 'string') return { role: m.role, content: c };
      try {
        const parsed = JSON.parse(c);
        if (Array.isArray(parsed)) return { role: m.role, content: dropBadImage(parsed) };
      } catch {
        // 非 JSON，按纯文本处理
      }
      return { role: m.role, content: String(c) };
    });

    // 本轮用户消息：文本 + 图片（base64 data URL 或图片 URL）构成多模态 content 数组。
    const userParts = [];
    if (text) userParts.push({ type: 'text', text });
    for (const img of imgList) {
      userParts.push({ type: 'image_url', image_url: { url: img } });
    }
    const userContent =
      userParts.length > 1 || (userParts.length === 1 && userParts[0].type !== 'text')
        ? userParts
        : (text || '');

    // 显式注入：四段各自带 source 与 order，逐条落 context_inject 事件。
    // 过去是 systemPrompt + dailyBlock + kbBlock + skillBlock 直接相加，
    // 无法追溯「哪段是哪来的」；现在换成显式 inject，行为逐字等价
    // （buildSystemContent 用空串 join('')，段间不加任何字符）。
    const injector = createInjector({
      origin: 'core',
      sessionId,
      turnId,
      enqueue: (event) => recorder.enqueue(event),
    });
    injector.inject('system.base', systemPrompt, { preflightInjected: preflight.injected || [] });
    injector.inject('daily_brief', dailyBlock, { failed: dailyBlock === '' });
    injector.inject('knowledge', kbBlock, { failed: kbBlock === '' });
    injector.inject('skills', skillBlock, {
      skillCount: Array.isArray(skillPrompts) ? skillPrompts.length : 0,
    });

    const messages = [
      { role: 'system', content: buildSystemContent(injector.segments) },
      ...normalizedRecent,
      { role: 'user', content: userContent },
    ];

    const correctionMode = detectCorrectionIntent(text);
    // 阶段 D：工具集统一从能力注册表按 scope 列举（内置 + 全局 MCP/技能 + 本连接前端工具）。
    // builtin 能力文件已含 plan / schedule_reminder / load_skill，不再额外 withTaskTools。
    const allTools = capabilities.listTools(capScope);
    // 纠正场景【放开搜索、但有限度】：主人指出"你说错了/她没说过"时，宠物的正确反应是
    // 去搜索找出真正的正确答案，而不是盲信自己或硬抗。所以 web_search 仍可用。
    // 但搜索必须"有限度"——用 webSearchCap 兜底：纠正模式限 2 次、普通模式限 4 次，
    // 达到上限即强制后续轮次纯文本收尾，避免无节制搜索把后端拖垮（原 45s 超时崩因）。
    const tools = allTools;
    const toolChoice = tools.length ? 'auto' : undefined;
    const webSearchCap = webSearchCapFor(profile, correctionMode);
    if (correctionMode) console.log(`[aiReply] 纠正意图命中，允许有限搜索（webSearchCap=${webSearchCap}）后强制收尾`);

    // tool-call loop：模型可多次调用工具，直到产出最终文本。
    // 循环控制（何时收尾 / 熔断上限）交给共享包 AgentRunner，停止条件语义化：
    // 有工具欠账就继续，maxRounds 只作熔断上限。IO 仍在本回调内（模型/工具/事件），
    // runner 只做纯逻辑决策，符合「包只放纯逻辑」红线。
    let toolsDisabled = false; // 部分端点/模型（如 ModelScope 推理接口）不支持 function calling，
                               // 请求带 tools 会直接 400；此时降级为纯文本重试一次。
    // 退化循环保护：模型反复用近重复 query 调 web_search（搜了又搜、自证式空转）时，
    // 强制后续轮次不再带工具，逼其用已有信息直接文本作答。
    let degenerateLoop = false;
    const searchQueryHistory = [];
    let webSearchCount = 0; // 本轮 web_search 调用计数，配合 webSearchCap 实现"有限度"搜索
    const runner = new AgentRunner(profile);
    const finalReply = await runner.run(async (round, r) => {
      let completion;
      try {
        // 退化循环触发后不再带工具（useTools=false），模型只能直接文本作答。
        const useTools = tools.length && !toolsDisabled && !degenerateLoop;
        // 调用模型前落一条 request：payload.messages 是当时完整数组的逐字深拷贝，
        // 杀进程重启后靠它重建「发给模型的 messages」（Harness 的硬指标）。
        recorder.enqueue({
          origin: 'core',
          sessionId,
          turnId,
          type: 'request',
          payload: {
            round,
            callSite: 'main',
            params: {
              model: aiContext.model,
              useTools: !!useTools,
              max_tokens: profile.maxTokens,
              tool_choice: useTools ? toolChoice : undefined,
              toolsCount: useTools ? tools.length : 0,
            },
            messages: JSON.parse(JSON.stringify(messages)),
          },
        });
        completion = await streamChatCompletion(
          aiContext.openai,
          {
            model: aiContext.model,
            messages,
            tools: useTools ? tools : undefined,
            tool_choice: useTools ? toolChoice : undefined,
            max_tokens: profile.maxTokens,
          },
          { signal: controller.signal, onDelta },
        );
      } catch (e) {
        const errMsg = e?.message || String(e);
        const toolErr = /tool|2013|function.?call|invalid param/i.test(errMsg);
        const aborted = e?.name === 'AbortError' || /abort/i.test(errMsg);
        if (!toolsDisabled && tools.length && toolErr) {
          console.warn(`[aiReply] 端点/模型不支持 tools（${errMsg}），降级重试（不携带 tools）`);
          toolsDisabled = true;
          completion = await streamChatCompletion(
            aiContext.openai,
            {
              model: aiContext.model,
              messages,
              max_tokens: profile.maxTokens,
            },
            { signal: controller.signal, onDelta },
          );
        } else if (aborted) {
          // 主请求超时/中断（如 120s 上限触发）：当前轮流被截断。
          // 用 salvageAsText（独立 60s 控制器）基于已有上下文强制纯文本收尾，救回一句真实回复，
          // 实在救不回才冒泡到外层通用兜底，避免直接崩成"还在学习中"。
          console.warn(`[aiReply] 主请求超时/中断（${errMsg}），尝试纯文本收尾`);
          try {
            const salvaged = await salvageAsText(aiContext, messages, onDelta, profile);
            if (salvaged && salvaged.trim()) {
              const { speech, emotion } = parseModelReply(salvaged.trim());
              if (speech) {
                console.log('[aiReply] 超时后纯文本收尾成功');
                return {
                  kind: 'final',
                  value: {
                    speech,
                    emotion,
                    images: [],
                    action: 'idle',
                    mood: 'curious',
                    source: 'model_salvaged',
                    model: aiContext.model,
                    usage: null,
                    sessionId,
                    userid: aiContext.userid,
                  },
                };
              }
            }
          } catch (se) {
            console.warn('[aiReply] 超时后纯文本收尾失败：', se?.message || se);
          }
          throw e;
        } else {
          throw e;
        }
      }

      const msg = completion.choices[0].message;

      // 诊断日志
      console.log(
        `[aiReply] round=${round} finish_reason=${completion.choices[0].finish_reason} ` +
        `has_content=${!!msg.content} content_len=${(msg.content || '').length} ` +
        `reasoning_len=${(completion._reasoningContent || '').length} ` +
        `chunks=${completion._chunkCount} ` +
        `tool_calls_count=${msg.tool_calls?.length || 0} ` +
        `tool_names=${(msg.tool_calls || []).map((t) => t.function?.name).join(',') || '(none)'}`,
      );
      if (msg.tool_calls?.length > 0) {
        console.log(`[aiReply] tool_calls detail:`, JSON.stringify(msg.tool_calls));
      }

      messages.push(msg);

      // 工具轮的中间产物：模型吐过的正文碎片随后会被 onDelta(null) 作废，
      // 记一条 discarded 事件供轨迹追溯，不进模型历史的最终态。
      if (msg.tool_calls?.length > 0) {
        recorder.enqueue({
          origin: 'core',
          sessionId,
          turnId,
          type: 'assistant_attempt',
          payload: {
            round,
            content: msg.content || '',
            tool_calls: msg.tool_calls,
            discarded: true,
            reason: 'tool_round',
          },
        });
      }

      // 无工具调用 → 模型想收尾
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        const rawContent = msg.content?.trim();
        // 阶段 C：任务未完成时，纯文本收尾被拦截——text 步骤视为已完成先推进，
        // 仍有未做步骤则注入 nudge、保持 turn 打开再转一轮（maxRounds 熔断兜底）。
        if (taskRuntime.hasActiveTask(sessionId)) {
          if (rawContent) taskRuntime.advancePendingStep(sessionId, 'text', null, rawContent.slice(0, 200));
          if (taskRuntime.hasActiveTask(sessionId)) {
            console.log('[aiReply] 任务未完成，拦截收尾并继续推进');
            if (onDelta) { try { onDelta(null); } catch {} }
            messages.push({ role: 'user', content: taskRuntime.pendingNudge(sessionId) });
            return { kind: 'continue', reason: 'active task not finished' };
          }
          // 任务恰好在这轮全部完成 → 落到下方正常 final 收尾
        }
        if (!rawContent) {
          // 流被截断（如超时 abort、reasoning 吃满 max_tokens）导致 content 为空：
          // 不再硬抛（会掉进"还在学习中"通用兜底），先强制一次"纯文本收尾"生成救回答案。
          console.error(
            `[aiReply] round=${round} 内容为空，尝试强制纯文本收尾 model=${aiContext.model} reasoning_len=${completion._reasoningContent?.length || 0} chunks=${completion._chunkCount}`,
          );
          try {
            const salvaged = await salvageAsText(aiContext, messages, onDelta, profile);
            if (salvaged && salvaged.trim()) {
              const { speech, emotion, images } = parseModelReply(salvaged.trim());
              if (speech) {
                console.log('[aiReply] 纯文本收尾成功，救回回复');
                return {
                  kind: 'final',
                  value: {
                    speech,
                    emotion,
                    images: Array.isArray(images) ? images : [],
                    action: 'idle',
                    mood: 'curious',
                    source: 'model_salvaged',
                    model: completion.model,
                    usage: completion.usage,
                    sessionId,
                    userid: aiContext.userid,
                  },
                };
              }
            }
          } catch (se) {
            console.warn('[aiReply] 纯文本收尾失败：', se?.message || se);
          }
          throw new Error(`模型返回内容为空（model=${aiContext.model}，可能仅输出 reasoning 或流被截断）`);
        }
        const { speech, emotion, images } = parseModelReply(rawContent);
        if (!speech) throw new Error('模型返回内容为空');
        return {
          kind: 'final',
          value: {
            speech,
            emotion,
            images: Array.isArray(images) ? images : [],
            action: 'idle',
            mood: 'curious',
            source: 'model',
            model: completion.model,
            usage: completion.usage,
            sessionId,
            userid: aiContext.userid,
          },
        };
      }

      // 有工具调用 → 这轮吐过的正文碎片全部作废（那不是最终回复），让调用方清空。
      // 然后执行工具并回灌，下一轮重新流。
      if (onDelta) {
        try { onDelta(null); } catch {}
      }
      // 领取本轮工具欠账：执行并回灌完毕后逐一 settle，账本清空才进下一轮。
      // 这是阶段 C「任务欠账」的挂接点——届时外部任务 note 进来会让 turn 保持打开。
      const toolCallIds = msg.tool_calls.map((tc) => tc.id);
      r.note(toolCallIds);
      for (const tc of msg.tool_calls) {
        let result;
        try {
          const args = tc.function?.arguments
            ? JSON.parse(tc.function.arguments)
            : {};
          const toolName = tc.function?.name;
          recorder.enqueue({
            origin: 'core',
            sessionId,
            turnId,
            type: 'tool_call',
            payload: { round, tool_call_id: tc.id, name: toolName, arguments: args },
          });
          // 退化循环检测：记录 web_search 的 query，出现近重复即标记 degenerateLoop，
          // 下一轮起不再带工具（见上方 useTools 判定），避免搜了又搜的自证式空转。
          if (toolName === 'web_search') {
            webSearchCount++;
            try {
              const q = (tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}).query || '';
              const key = String(q).trim().toLowerCase();
              if (key) {
                if (searchQueryHistory.includes(key)) degenerateLoop = true;
                else searchQueryHistory.push(key);
              }
            } catch { /* ignore parse error */ }
            // "有限度"搜索：达到上限（纠正模式 2 / 普通模式 4）即强制后续轮次纯文本收尾，
            // 不再带工具，避免无节制联网拖垮后端。
            if (webSearchCap > 0 && webSearchCount >= webSearchCap) {
              console.log(`[aiReply] web_search 已达上限(${webSearchCap})，强制纯文本收尾`);
              degenerateLoop = true;
            }
          }
          // 阶段 D：统一 dispatch 流水线——按 scope 选执行器（内置/全局/本连接前端）
          // + 统一超时 + 统一截断。前端执行器由 socketServer 按连接注册进注册表，
          // 不再用全局 getFrontendToolNames 判断归属（那正是串线根因）。
          const dispatched = await capabilities.dispatch(capScope, toolName, args, {
            searchKey: aiContext.searchKey,
            searchEndpoint: aiContext.searchEndpoint,
            searchProvider: aiContext.searchProvider,
            openai: aiContext.openai,
            sessionId,
            turnId,
            uid: aiContext.userid,
            origin: 'core',
            // 前端工具执行器：若本 scope 注册了 connection 能力，registry 会用它；
            // 这里兜底挂上（兼容尚未按新接口注册的旧调用方）。
            invokeFrontendTool: aiContext.invokeFrontendTool,
          });
          result = dispatched.content;
        } catch (e) {
          result = `error: ${e instanceof Error ? e.message : String(e)}`;
        }
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: String(result),
        });
        // 阶段 D：截断已在 capabilities.dispatch 流水线里统一执行。
        recorder.enqueue({
          origin: 'core',
          sessionId,
          turnId,
          type: 'tool_result',
          payload: {
            round,
            tool_call_id: tc.id,
            name: tc.function?.name,
            content: String(result),
            isError: typeof result === 'string' && result.startsWith('error:'),
          },
        });
        r.settle(tc.id); // 该工具结果已回灌，清偿欠账
        // 阶段 C：工具成功后推进 active task 的对应 tool 步骤（plan/reminder 由
        // taskRuntime 自身处理，这里对普通工具匹配 step.toolName）。
        const isErr = typeof result === 'string' && result.startsWith('error:');
        if (!isErr && !taskRuntime.isTaskTool(tc.function?.name)) {
          taskRuntime.advancePendingStep(sessionId, 'tool', tc.function?.name, String(result).slice(0, 300));
        }
      }
      // 本轮工具全部回灌完毕、账本清空 → 欠账清零，请求 runner 进入下一轮。
      return { kind: 'tools', toolCallIds };
    });

    // runner 在「无工具欠账」时才返回；跑满熔断上限会抛与原实现逐字一致的错误。
    return finalReply;
  } finally {
    clearTimeout(timeoutId);
    aiContext.activeRequests.delete(controller);
    // 每轮强制 flush：回复返回前把本轮 request / tool_* 全部落库，
    // 「杀进程重启后逐字重建」才成立。失败只警告，绝不影响回复。
    try { await recorder.flush(); } catch (e) { console.warn('[events] 本轮事件落库失败（已忽略）:', e?.message || e); }
    recorder.enqueue({
      origin: 'core',
      sessionId,
      turnId,
      type: 'turn_end',
      payload: { elapsedMs: Date.now() - _t0, model: aiContext.model },
    });
    try { await recorder.flush(); } catch (e) { console.warn('[events] 本轮事件落库失败（已忽略）:', e?.message || e); }
    endTurn();
  }
}

module.exports = { getReply };
