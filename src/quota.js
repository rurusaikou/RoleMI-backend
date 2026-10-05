import { getQuotaConfig, isQuotaDisabled } from "./config.js";

/**
 * 为一次模型尝试预占额度，成功插入返回 true，任一限额耗尽返回 false。
 * 数据库异常交给调用方处理；额度按尝试计数，不依赖 ai_calls 是否写入成功。
 */
export async function reserveQuota(env, installationId, module, now = new Date()) {
  const limits = getQuotaConfig(env);
  const nowIso = now.toISOString();
  // 不限次数时仍记录尝试，保留统计及恢复限额后的计数。
  if (isQuotaDisabled(env)) {
    const result = await env.rolemi_metrics.prepare(
      "INSERT INTO ai_quota_attempts (installation_id, module, created_at) VALUES (?, ?, ?)"
    ).bind(installationId, module, nowIso).run();
    return result.meta?.changes === 1;
  }
  // 日额度按 UTC 零点重置，分钟额度使用最近 60 秒的滑动窗口。
  const dayStart = `${nowIso.slice(0, 10)}T00:00:00.000Z`;
  const minuteStart = new Date(now.getTime() - 60_000).toISOString();
  // 三项额度跨所有 AI 模块共享；module 只用于记录，不参与额度分组。
  // 用同一条条件 INSERT 完成检查和预占，避免并发请求读取旧计数后一起通过。
  const result = await env.rolemi_metrics.prepare(`
    INSERT INTO ai_quota_attempts (installation_id, module, created_at)
    SELECT ?, ?, ? WHERE
      (SELECT COUNT(*) FROM ai_quota_attempts WHERE installation_id = ? AND created_at >= ?) < ?
      AND (SELECT COUNT(*) FROM ai_quota_attempts WHERE installation_id = ? AND created_at >= ?) < ?
      AND (SELECT COUNT(*) FROM ai_quota_attempts WHERE created_at >= ?) < ?
  `).bind(installationId, module, nowIso,
    installationId, dayStart, limits.installationDaily,
    installationId, minuteStart, limits.installationMinute,
    dayStart, limits.globalDaily).run();
  return result.meta?.changes === 1;
}
