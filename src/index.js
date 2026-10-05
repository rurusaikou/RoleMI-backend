/**
 * Cloudflare Worker 入口：统一路由 AI、事件、反馈、健康检查及定时清理任务。
 */
import { handleAI } from "./ai-gateway.js";
import { handleEvents } from "./events.js";
import { handleFeedback } from "./feedback.js";

// 本地开发及扩展的跨域策略；CORS 不是客户端身份认证。
function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const localOrigin = origin === "http://localhost" || origin?.startsWith("http://localhost:") ||
    origin === "http://127.0.0.1" || origin?.startsWith("http://127.0.0.1:");
  const configured = String(env.ALLOWED_EXTENSION_ORIGINS || "")
    .split(",").map(value => value.trim()).filter(Boolean);
  const extensionAllowed = origin?.startsWith("chrome-extension://") &&
    (env.APP_ENV !== "production" || configured.includes(origin));
  const allowed = !origin || (env.APP_ENV !== "production" && (origin === "null" || localOrigin)) || extensionAllowed;
  if (!allowed) return null;
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

export default {
  // 所有 HTTP 路由共用同一 Origin 门禁和响应头收口，业务处理器无需重复实现 CORS。
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (!cors) return Response.json({ error: { code: "origin_not_allowed" } }, { status: 403 });
    // 预检先于路由判断，因此允许的 Origin 对未知路径也会得到 204。
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    // 业务处理器只负责自身响应，入口统一补上跨域头。
    let response;
    if (url.pathname === "/api/ai") {
      response = await handleAI(request, env);
    } else if (url.pathname === "/api/events") {
      response = await handleEvents(request, env);
    } else if (url.pathname === "/api/feedback") {
      response = await handleFeedback(request, env);
    } else if (url.pathname === "/health" || url.pathname === "/") {
      response = Response.json({ name: "RoleMI Backend", status: "ok" });
    } else {
      response = Response.json({ error: { code: "not_found" } }, { status: 404 });
    }

    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(cors)) headers.set(key, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },

  // 每日定时清理统计明细；普通指标保留 30 天，用户主动提交的反馈保留 180 天。
  async scheduled(_controller, env) {
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
    // 明细按完整时间戳删除；每日安装按业务日期删除并保留截止日，因而最多跨 31 个 UTC 日期标签。
    const cutoffDay = cutoff.slice(0, 10);
    const feedbackCutoff = new Date(Date.now() - 180 * 86400000).toISOString();
    await env.rolemi_metrics.batch([
      env.rolemi_metrics.prepare("DELETE FROM ai_calls WHERE created_at < ?").bind(cutoff),
      env.rolemi_metrics.prepare("DELETE FROM events WHERE created_at < ?").bind(cutoff),
      env.rolemi_metrics.prepare("DELETE FROM ai_quota_attempts WHERE created_at < ?").bind(cutoff),
      env.rolemi_metrics.prepare("DELETE FROM daily_installations WHERE event_date < ?").bind(cutoffDay),
      env.rolemi_metrics.prepare("DELETE FROM feedback WHERE created_at < ?").bind(feedbackCutoff),
    ]);
  }
};
