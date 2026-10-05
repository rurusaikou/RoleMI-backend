// RoleMI 后端集中配置。运行时可通过 Worker 环境变量覆盖额度；未配置时使用这里的默认值。
export const AI_MODULES = new Set([
  "deep_analysis", "resume_profile", "resume_match", "resume_revision", "greeting", "settings_test",
]);

export const EVENT_MODULES = new Set([
  "jd_extract", "jd_manual", "favorite", "resume_import", "deep_analysis",
  "resume_profile", "resume_match", "resume_revision", "greeting", "excel_export",
]);

// 输出预算按模块封顶；客户端可降低预算，不能提高上限。
export const OUTPUT_LIMITS = {
  deep_analysis: 5000,
  resume_profile: 4000,
  resume_match: 6000,
  resume_revision: 8000,
  greeting: 3200,
  settings_test: 40,
};

export const AI_TIMEOUT_MS = 120_000;
export const MAX_AI_REQUEST_BYTES = 100 * 1024;
export const MAX_AI_INPUT_CHARS = 24_000;

const DEFAULT_QUOTA = Object.freeze({
  installationDaily: 20,
  installationMinute: 6,
  globalDaily: 200,
});

// 改为 true 可默认关闭调用次数限制；运行时 AI_QUOTA_DISABLED 可覆盖。
export const AI_QUOTA_DISABLED = true;

/**
 * 返回当前环境是否跳过次数检查；跳过检查时仍会写入额度尝试记录。
 * 仅未绑定变量时使用默认值；字符串不做大小写转换或去空白。
 */
export function isQuotaDisabled(env) {
  return env.AI_QUOTA_DISABLED === undefined
    ? AI_QUOTA_DISABLED
    : env.AI_QUOTA_DISABLED === true || env.AI_QUOTA_DISABLED === "true";
}

// Wrangler 环境变量通常是字符串，先转数值再校验；0 不表示无限额度。
function positiveInt(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** 读取运行时额度，并将缺失或无效值回退到经过校验的代码默认值。 */
export function getQuotaConfig(env) {
  return {
    installationDaily: positiveInt(env.AI_INSTALLATION_DAILY_LIMIT, DEFAULT_QUOTA.installationDaily),
    installationMinute: positiveInt(env.AI_INSTALLATION_MINUTE_LIMIT, DEFAULT_QUOTA.installationMinute),
    globalDaily: positiveInt(env.AI_GLOBAL_DAILY_LIMIT, DEFAULT_QUOTA.globalDaily),
  };
}

export { DEFAULT_QUOTA };
