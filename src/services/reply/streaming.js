// src/services/reply/streaming.js
// LLM 流式调用封装：统一走 SSE 流式累积为标准 ChatCompletion 形态（兼容 reasoning 模型），
// 以及把工具原始结果交给 LLM 润色成符合人设的口语回复。

const { parseModelReply } = require('./parser');
const { buildBasePrompt } = require('./promptBuilder');

// ModelScope 等推理接口只支持流式响应（SSE），且 reasoning 模型会在 delta 里同时给出
// reasoning_content（思考过程）与 content（最终答案）。这里统一走 stream:true 拉 chunks，
// 累积成与 ChatCompletion 同形的对象返回，下游（completion.choices[0].message / usage / model）
// 无需改动。对非流式供应商同样兼容：拿到流后累积等价于一次完整响应。
async function streamChatCompletion(openai, params, { signal } = {}) {
  const stream = await openai.chat.completions.create(
    { ...params, stream: true, stream_options: { include_usage: true } },
    { signal },
  );
  let role = 'assistant';
  let content = '';
  let reasoningContent = '';
  // tool_calls 按 index 合并：流式下同一 tool call 的 name/arguments 分片到达，必须累加。
  const toolCalls = new Map();
  let finishReason = null;
  let model = params.model;
  let usage = null;
  let chunkCount = 0;
  for await (const chunk of stream) {
    chunkCount++;
    if (chunk.model) model = chunk.model;
    const choice = chunk.choices?.[0];
    if (choice) {
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const d = choice.delta;
      if (d) {
        if (d.role) role = d.role;
        if (typeof d.content === 'string' && d.content.length) content += d.content;
        if (typeof d.reasoning_content === 'string' && d.reasoning_content.length) reasoningContent += d.reasoning_content;
        if (Array.isArray(d.tool_calls)) {
          for (const tc of d.tool_calls) {
            const idx = typeof tc.index === 'number' ? tc.index : 0;
            let cur = toolCalls.get(idx);
            if (!cur) {
              cur = { id: '', type: 'function', function: { name: '', arguments: '' } };
              toolCalls.set(idx, cur);
            }
            if (tc.id) cur.id = tc.id;
            if (tc.type) cur.type = tc.type;
            if (tc.function?.name) cur.function.name += tc.function.name;
            if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
          }
        }
      }
    }
    // 最后一个 chunk 通常 choices=[]，仅携带 usage。
    if (chunk.usage) usage = chunk.usage;
  }
  const assembledCalls = toolCalls.size ? Array.from(toolCalls.values()) : undefined;
  const messageToolCalls =
    assembledCalls && assembledCalls.some((tc) => tc.function?.name || tc.function?.arguments)
      ? assembledCalls
      : undefined;
  return {
    choices: [
      { message: { role, content, tool_calls: messageToolCalls }, finish_reason: finishReason },
    ],
    model,
    usage,
    _chunkCount: chunkCount,
    _reasoningContent: reasoningContent,
  };
}

// 把工具的原始数据交给 LLM 润色成符合人设的口语回复。
// 成功返回模型解析结果；失败（异常 / 模型空回复 / 解析不出 speech）则抛出，由调用方回退到工具原始结果。
// systemPromptOverride 可选：传入自定义 system 提示（如位置设置确认），此时仍用 {{TOOL_RESULTS}} 占位符注入事实。
async function polishToolResult(rawToolText, aiContext, sessionId, userText, controller, systemPromptOverride) {
  // 润色任务只聚焦「当前用户问题 + 工具数据」，不引入完整对话历史。
  // 完整历史容易让模型把上一轮的反问/确认当成当前任务，导致"请稍等我获取"、"天气还是时间"等幻觉。
  const systemPrompt = (systemPromptOverride || buildBasePrompt())
    .replace('{{TOOL_RESULTS}}', rawToolText)
    .replace('{{USER_QUESTION}}', userText || '请帮我看看上面的信息');

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userText || '请帮我看看上面查到的信息。' },
  ];

  console.log(`[polish] LLM 润色调用前 @${Date.now()}`);
  const completion = await streamChatCompletion(
    aiContext.openai,
    { model: aiContext.model, messages, max_tokens: 800 },
    { signal: controller.signal },
  );
  console.log(`[polish] LLM 润色返回 @${Date.now()}`);

  const msg = completion.choices[0].message;
  if (!msg || !msg.content || !msg.content.trim()) {
    console.error(
      `[polish] 润色内容为空 model=${aiContext.model} reasoning_len=${completion._reasoningContent?.length || 0} chunks=${completion._chunkCount}`,
    );
    throw new Error('模型润色返回为空');
  }
  const { speech, emotion, images } = parseModelReply(msg.content.trim());
  if (!speech) throw new Error('模型润色结果为空');
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

module.exports = { streamChatCompletion, polishToolResult };
