/**
 * 托管 AI 网关：校验模块请求、预占额度、转发 Responses API，并记录匿名调用统计。
 */
import { readJson } from "./request.js";
import { reserveQuota } from "./quota.js";

// 日志短标识仅用于排查，可能发生前缀碰撞；数据库仍使用完整 UUID。
function userTag(installationId) {
  return `[USER ${installationId.slice(0, 8)}]`;
}

import {
  AI_MODULES, OUTPUT_LIMITS, AI_TIMEOUT_MS, MAX_AI_REQUEST_BYTES, MAX_AI_INPUT_CHARS,
} from "./config.js";

function errorResponse(status, code) {
  return Response.json({ error: { code } }, { status });
}

// 上游未提供用量或格式异常时保存 NULL，避免把未知用量误记成零。
function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// 按 Unicode 码点计数；仅识别文本部件，图片等仍受请求总字节上限约束。
function textCharacters(value) {
  if (typeof value === "string") return [...value].length;
  if (!Array.isArray(value)) return 0;
  return value.reduce((total, part) => total +
    (["input_text", "output_text", "reasoning_text"].includes(part?.type)
      ? textCharacters(part.text) : 0), 0);
}

function inputCharacters(payload) {
  // 统计 instructions 和 input 的实际文本，不计角色名、图片或结构字符。
  let total = textCharacters(payload.instructions);
  if (typeof payload.input === "string") return total + textCharacters(payload.input);
  for (const item of payload.input ?? []) {
    total += textCharacters(item.content);
    if (["function_call", "custom_tool_call"].includes(item.type)) {
      total += textCharacters(item.arguments ?? item.input);
    }
    if (["function_call_output", "custom_tool_call_output"].includes(item.type)) {
      total += textCharacters(item.output);
    }
  }
  return total;
}

/**
 * 托管 AI 入口：校验 → 服务端配置 → 额度预占 → 上游调用 → 用量记录 → 透传。
 * 提示词和业务结果解析由插件负责，本模块只约束请求并记录不含正文的指标。
 */
export async function handleAI(request, env) {
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }

  // 1. 先限制请求大小和输入形状；不合法的请求不会消耗模型额度。
  const parsed = await readJson(request, MAX_AI_REQUEST_BYTES);
  if (parsed.response) return parsed.response;
  const body = parsed.body;
  const payload = body?.request;
  // input/instructions 的 null 与缺省同样处理，但至少一项必须满足非空条件。
  // 这里只校验数组元素为对象，具体消息角色和内容结构由上游校验。
  if (!body || typeof body.installation_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.installation_id) ||
      typeof body.module !== "string" || !AI_MODULES.has(body.module) ||
      !payload || typeof payload !== "object" || Array.isArray(payload) ||
      (payload.model !== undefined && (typeof payload.model !== "string" || !payload.model.trim())) ||
      (payload.instructions != null && typeof payload.instructions !== "string") ||
      (payload.input != null && typeof payload.input !== "string" && !Array.isArray(payload.input)) ||
      (Array.isArray(payload.input) && payload.input.some(item => !item || typeof item !== "object" || Array.isArray(item))) ||
      (!payload.input?.length && !payload.instructions?.trim())) {
    return errorResponse(400, "invalid_request");
  }
  if (inputCharacters(payload) > MAX_AI_INPUT_CHARS) return errorResponse(413, "input_too_large");
  if (payload.stream !== undefined && payload.stream !== false) {
    return errorResponse(400, "streaming_not_supported");
  }

  // 2. 白名单限制可透传参数；模型、流式和存储开关会在发送时覆盖。
  const allowed = new Set(['model', 'input', 'instructions', 'temperature', 'max_output_tokens', 'text', 'reasoning', 'stream', 'store']);
  if (Object.keys(payload).some(key => !allowed.has(key)) ||
      (payload.max_output_tokens !== undefined && (!Number.isSafeInteger(payload.max_output_tokens) || payload.max_output_tokens < 1))) {
    return errorResponse(400, "invalid_request");
  }
  const maxOutputTokens = Math.min(payload.max_output_tokens ?? OUTPUT_LIMITS[body.module], OUTPUT_LIMITS[body.module]);

  // 上游地址和 Key 只读取服务端绑定，不接受插件指定 URL 或认证信息。
  let endpoint;
  try {
    endpoint = new URL(env.AI_API_URL);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) throw new Error();
  } catch {
    return errorResponse(503, "ai_not_configured");
  }
  if (typeof env.AI_API_KEY !== "string" || !env.AI_API_KEY.trim()) {
    return errorResponse(503, "ai_not_configured");
  }
  // 托管模式由服务端固定模型；忽略客户端 model，避免普通用户绕过项目配置。
  const model = env.AI_MODEL;
  if (typeof model !== "string" || !model.trim()) return errorResponse(503, "ai_not_configured");

  // 3. 先占额度再付费调用；后续失败也不退额度，数据库不可用时拒绝调用。
  try {
    if (!await reserveQuota(env, body.installation_id, body.module)) {
      console.warn(`${userTag(body.installation_id)} [AI] ${body.module} QUOTA_EXCEEDED`);
      return errorResponse(429, "quota_exceeded");
    }
  } catch {
    console.error(`${userTag(body.installation_id)} [AI] ${body.module} QUOTA_ERROR`);
    return errorResponse(503, "metrics_unavailable");
  }

  // 4. 超时覆盖建立连接与读取完整响应；网关本身不自动重试。
  const started = Date.now();
  let response;
  let responseText;
  let usage;
  let status = "failed";
  let latency;
  let gatewayError;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    response = await fetch(endpoint.href, {
      method: "POST",
      redirect: "manual",
      headers: {
        Authorization: `Bearer ${env.AI_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ ...payload, model, max_output_tokens: maxOutputTokens, stream: false, store: false }),
      signal: controller.signal,
    });
    responseText = await response.text();
    if (!response.ok) {
      console.warn(`${userTag(body.installation_id)} [AI] ${body.module} UPSTREAM_HTTP_${response.status}`);
    }
    try {
      const result = JSON.parse(responseText);
      usage = result?.usage;
      // HTTP 成功不等于生成完成；截断单独计为 incomplete。
      if (response.ok && result?.status === "completed" && !result?.error) status = "success";
      else if (response.ok && result?.status === "incomplete") status = "incomplete";
    } catch {
      // 非 JSON 响应也按原始正文返回，不将内容写入统计或日志。
    }
  } catch (error) {
    const isTimeout = controller.signal.aborted;
    // 异常 message 可能夹带上游正文或请求信息，日志只保留分类所需的结构化字段。
    const safeDetails = [
      `timeout=${isTimeout}`,
      `name=${error?.name ?? "unknown"}`,
    ];
    if (error?.cause?.code) safeDetails.push(`cause.code=${error.cause.code}`);
    console.error(`${userTag(body.installation_id)} [AI] ${body.module} UPSTREAM_FAILED ${safeDetails.join(", ")}`);
    gatewayError = isTimeout
      ? errorResponse(504, "upstream_timeout")
      : errorResponse(502, "upstream_unavailable");
  } finally {
    // 耗时不包含前置额度检查和后续指标写库，也不是客户端端到端耗时。
    latency = Date.now() - started;
    clearTimeout(timeout);
  }

  // 5. 用量统计是尽力写入；失败不影响已经取得的模型结果。
  try {
    await env.rolemi_metrics.prepare(`
      INSERT INTO ai_calls (
        installation_id, module, model, input_chars, input_tokens,
        reasoning_tokens, output_tokens, latency_ms, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      body.installation_id,
      body.module,
      model,
      inputCharacters(payload),
      tokenCount(usage?.input_tokens),
      tokenCount(usage?.output_tokens_details?.reasoning_tokens),
      tokenCount(usage?.output_tokens),
      latency,
      status,
      new Date(started).toISOString(),
    ).run();
  } catch {
    // 不记录异常对象：数据库/上游错误可能携带敏感正文。
    console.error(`${userTag(body.installation_id)} [AI] ${body.module} METRICS_WRITE_FAILED`);
  }

  // 6. 保留上游状态与正文供插件解析，只转发需要的响应头。
  console.info(`${userTag(body.installation_id)} [AI] ${body.module} ${(gatewayError ? "failed" : status).toUpperCase()} ${(latency / 1000).toFixed(1)}s`);
  if (gatewayError) return gatewayError;
  const headers = new Headers({ "Cache-Control": "no-store" });
  for (const name of ["content-type", "retry-after", "x-request-id"]) {
    if (response.headers.has(name)) headers.set(name, response.headers.get(name));
  }
  // 这些状态禁止携带正文；3xx 原样返回，但不透传 Location。
  return new Response([204, 205, 304].includes(response.status) ? null : responseText, {
    status: response.status,
    headers,
  });
}
