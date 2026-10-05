/**
 * 用户反馈入口：保存反馈正文及用户主动关联岗位的 JD/工作流结果快照。
 * 不接收简历原文或附件；反馈记录用于 Bad Case 与 Prompt 效果分析。
 */
import { readJson } from "./request.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TYPES = new Set(["function_error", "analysis_inaccurate", "suggestion", "other"]);
const MAX_CONTENT = 500;
const MAX_JOB_TITLE = 300;
const MAX_JOB_ID = 200;
const MAX_JD = 20000;
const MAX_RESULT = 120000;
const ALLOWED = new Set([
  "installation_id", "type", "content", "job_id", "job_title", "jd_content",
  "deep_analysis_result", "match_result", "revision_result", "greeting_result"
]);

function jsonError(status, code) {
  return Response.json({ error: { code } }, { status });
}

function nullableText(value, max) {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "string" && value.length <= max ? value : undefined;
}

function resultText(value) {
  if (value === null || value === undefined) return null;
  let text;
  try { text = typeof value === "string" ? value : JSON.stringify(value); } catch { return undefined; }
  return text.length <= MAX_RESULT ? text : undefined;
}

export async function handleFeedback(request, env) {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const parsed = await readJson(request, 512 * 1024);
  if (parsed.response) return parsed.response;
  const body = parsed.body;
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !ALLOWED.has(key))) {
    return jsonError(400, "invalid_feedback");
  }

  const installationId = body.installation_id;
  const type = body.type;
  const content = typeof body.content === "string" ? body.content.trim() : "";
  const jobId = nullableText(body.job_id, MAX_JOB_ID);
  const jobTitle = nullableText(body.job_title, MAX_JOB_TITLE);
  const jdContent = nullableText(body.jd_content, MAX_JD);
  const deepAnalysis = resultText(body.deep_analysis_result);
  const match = resultText(body.match_result);
  const revision = resultText(body.revision_result);
  const greeting = resultText(body.greeting_result);

  if (!UUID.test(installationId || "") || !TYPES.has(type) || !content || content.length > MAX_CONTENT ||
      jobId === undefined || jobTitle === undefined || jdContent === undefined || deepAnalysis === undefined ||
      match === undefined || revision === undefined || greeting === undefined) {
    return jsonError(400, "invalid_feedback");
  }

  // 选择岗位时保存该岗位当时已经生成的工作流快照；未关联岗位时不接受孤立业务快照。
  if (!jobId && (jobTitle || jdContent || deepAnalysis || match || revision || greeting)) {
    return jsonError(400, "invalid_feedback");
  }

  const now = new Date().toISOString();
  try {
    const result = await env.rolemi_metrics.prepare(`
      INSERT INTO feedback (
        installation_id, type, content, job_id, job_title, jd_content,
        deep_analysis_result, match_result, revision_result, greeting_result, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(installationId, type, content, jobId, jobTitle, jdContent, deepAnalysis, match, revision, greeting, now).run();
    console.info(`[USER ${installationId.slice(0, 8)}] [FEEDBACK] ${type.toUpperCase()} id=${result.meta?.last_row_id ?? "?"}`);
    return Response.json({ success: true, id: result.meta?.last_row_id ?? null });
  } catch {
    return jsonError(503, "feedback_unavailable");
  }
}
