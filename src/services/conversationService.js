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
const { preflightTools, buildTools, detectCorrectionIntent } = require('./reply/intent');
const { streamChatCompletion, polishToolResult } = require('./reply/streaming');
const dailyBriefing = require('./dailyBriefingService');
const knowledgeRetrieval = require('../knowledge/retrievalService');
const { runTool, getFrontendToolNames } = require('../tools');
const sessionManager = require('../session/sessionManager');

// 工具循环最多轮数（也用于超时预算计算）。
const MAX_ROUNDS = 5;

// 兜底收尾：当模型在工具循环末尾只吐了 reasoning / 流被截断而 content 为空时，
// 用 tools:undefined + 一句强指令强制模型直接产出最终文本（不再调用任何工具）。
// 自带独立 AbortController（不与主请求共享），避免主超时已触发导致救回也一并被掐断。
async function salvageAsText(aiContext, messages) {
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
    const completion = await streamChatCompletion(
      aiContext.openai,
      { model: aiContext.model, messages: patched, max_tokens: 1500 },
      { signal: ctrl.signal },
    );
    return completion.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(tid);
  }
}

async function getReply({ aiContext, content = '', images = [], sessionId, clientIp = '', locationScope = null, skillPrompts = [], persona = null } = {}) {
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

  const controller = new AbortController();
  // 超时随"可能触发的工具轮次"放大：短消息默认仅 45s，但带工具的多轮 loop 很容易超过。
  // 基线取消息复杂度超时，但至少 60s；再为每轮工具预留 15s，封顶 120s。
  const baseTimeout = getRequestTimeout(text || '[用户发送了图片]');
  const timeout = Math.min(120000, Math.max(baseTimeout, 60000) + MAX_ROUNDS * 15000);
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  aiContext.activeRequests.add(controller);
  const _t0 = Date.now();
  console.log(`[getReply] === 开始处理 "${text.slice(0, 40)}" @${_t0}`);

  try {
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
        const c = await polishToolResult(raw, aiContext, sessionId, text, controller, sys.locationSet);
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
        const polished = await polishToolResult(rawText, aiContext, sessionId, polishUserText, controller, sys.polish);
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
      kbBlock = await knowledgeRetrieval.retrieveForPrompt(aiContext, text || '[用户发送了图片]');
    } catch (e) {
      console.warn('[aiReply] 知识库检索失败（已忽略）:', e?.message || e);
    }

    const systemPrompt = preflight.injected
      ? sys.withTools.replace('{{TOOL_RESULTS}}', preflight.injected.join('\n'))
      : sys.normal;

    // 注入前端托管的 skill 行为模板（提示词形态能力）：把启用中的 skill 指令追加到 system，
    // 让模型在回复时遵循这些「技能设定」。
    const skillBlock =
      Array.isArray(skillPrompts) && skillPrompts.length
        ? '\n\n# 已启用的技能（请遵循以下设定）\n' + skillPrompts.join('\n\n')
        : '';

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

    const messages = [
      { role: 'system', content: systemPrompt + dailyBlock + kbBlock + skillBlock },
      ...normalizedRecent,
      { role: 'user', content: userContent },
    ];

    const correctionMode = detectCorrectionIntent(text);
    const allTools = buildTools();
    // 纠正场景【放开搜索、但有限度】：主人指出"你说错了/她没说过"时，宠物的正确反应是
    // 去搜索找出真正的正确答案，而不是盲信自己或硬抗。所以 web_search 仍可用。
    // 但搜索必须"有限度"——用 webSearchCap 兜底：纠正模式限 2 次、普通模式限 4 次，
    // 达到上限即强制后续轮次纯文本收尾，避免无节制搜索把后端拖垮（原 45s 超时崩因）。
    const tools = allTools;
    const toolChoice = tools.length ? 'auto' : undefined;
    const webSearchCap = correctionMode ? 2 : 4;
    if (correctionMode) console.log(`[aiReply] 纠正意图命中，允许有限搜索（webSearchCap=${webSearchCap}）后强制收尾`);

    // tool-call loop：模型可多次调用工具，直到产出最终文本
    let toolsDisabled = false; // 部分端点/模型（如 ModelScope 推理接口）不支持 function calling，
                               // 请求带 tools 会直接 400；此时降级为纯文本重试一次。
    // 退化循环保护：模型反复用近重复 query 调 web_search（搜了又搜、自证式空转）时，
    // 强制后续轮次不再带工具，逼其用已有信息直接文本作答。
    let degenerateLoop = false;
    const searchQueryHistory = [];
    let webSearchCount = 0; // 本轮 web_search 调用计数，配合 webSearchCap 实现"有限度"搜索
    for (let round = 0; round < MAX_ROUNDS; round++) {
      let completion;
      try {
        // 退化循环触发后不再带工具（useTools=false），模型只能直接文本作答。
        const useTools = tools.length && !toolsDisabled && !degenerateLoop;
        completion = await streamChatCompletion(
          aiContext.openai,
          {
            model: aiContext.model,
            messages,
            tools: useTools ? tools : undefined,
            tool_choice: useTools ? toolChoice : undefined,
            max_tokens: 1500,
          },
          { signal: controller.signal },
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
              max_tokens: 1500,
            },
            { signal: controller.signal },
          );
        } else if (aborted) {
          // 主请求超时/中断（如 120s 上限触发）：当前轮流被截断。
          // 用 salvageAsText（独立 60s 控制器）基于已有上下文强制纯文本收尾，救回一句真实回复，
          // 实在救不回才冒泡到外层通用兜底，避免直接崩成"还在学习中"。
          console.warn(`[aiReply] 主请求超时/中断（${errMsg}），尝试纯文本收尾`);
          try {
            const salvaged = await salvageAsText(aiContext, messages);
            if (salvaged && salvaged.trim()) {
              const { speech, emotion } = parseModelReply(salvaged.trim());
              if (speech) {
                console.log('[aiReply] 超时后纯文本收尾成功');
                return {
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

      // 无工具调用 → 最终回复
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        const rawContent = msg.content?.trim();
        if (!rawContent) {
          // 流被截断（如超时 abort、reasoning 吃满 max_tokens）导致 content 为空：
          // 不再硬抛（会掉进"还在学习中"通用兜底），先强制一次"纯文本收尾"生成救回答案。
          console.error(
            `[aiReply] round=${round} 内容为空，尝试强制纯文本收尾 model=${aiContext.model} reasoning_len=${completion._reasoningContent?.length || 0} chunks=${completion._chunkCount}`,
          );
          try {
            const salvaged = await salvageAsText(aiContext, messages);
            if (salvaged && salvaged.trim()) {
              const { speech, emotion, images } = parseModelReply(salvaged.trim());
              if (speech) {
                console.log('[aiReply] 纯文本收尾成功，救回回复');
                return {
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
        };
      }

      // 有工具调用 → 执行并回灌
      for (const tc of msg.tool_calls) {
        let result;
        try {
          const args = tc.function?.arguments
            ? JSON.parse(tc.function.arguments)
            : {};
          const toolName = tc.function?.name;
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
          // 前端托管工具（MCP/skill 提供，总是以 frontend__ 前缀标识）：
          // 后端无法本地执行，必须通过 WS 回调解 Electron 主进程执行后取回结果。
          const frontendToolNames = aiContext.invokeFrontendTool ? getFrontendToolNames() : null;
          if (frontendToolNames && frontendToolNames.has(toolName)) {
            result = await aiContext.invokeFrontendTool(toolName, args);
          } else {
            result = await runTool(toolName, args, {
              searchKey: aiContext.searchKey,
              searchEndpoint: aiContext.searchEndpoint,
              searchProvider: aiContext.searchProvider,
              openai: aiContext.openai,
            });
          }
        } catch (e) {
          result = `error: ${e instanceof Error ? e.message : String(e)}`;
        }
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: String(result),
        });
      }
    }

    throw new Error('工具调用轮次过多，未能生成最终回复');
  } finally {
    clearTimeout(timeoutId);
    aiContext.activeRequests.delete(controller);
  }
}

module.exports = { getReply };
