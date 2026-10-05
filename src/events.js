/**
 * 使用事件入口：校验并批量写入匿名事件，供模块使用次数与成功/失败统计。
 */
import { readJson } from "./request.js";
import { EVENT_MODULES } from "./config.js";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_TYPES = new Set(["start", "success", "failed"]);
const EVENT_MODES = new Set(["hosted", "custom"]);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BATCH = 40;

function jsonError(status, code) {
  return Response.json({ error: { code } }, { status });
}

// 回转日期字符串排除 2 月 30 日等自动进位日期；时间窗口以该日 UTC 零点计算。
function validDate(date) {
  if (!DAY.test(date)) return false;
  const time = Date.parse(`${date}T00:00:00Z`);
  // 允许客户端离线补报七天；未来一天容纳时区靠前地区生成的本地业务日期。
  const age = Date.now() - time;
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date && age >= -86400000 && age <= 7 * 86400000;
}

// 精确限制六个字段，避免业务正文随匿名事件进入数据库。
function validEvent(item) {
  return item && typeof item === "object" && !Array.isArray(item) &&
    Object.keys(item).sort().join() === "date,event,execution_id,installation_id,mode,module" &&
    typeof item.installation_id === "string" && typeof item.execution_id === "string" && typeof item.date === "string" &&
    UUID.test(item.installation_id) && UUID.test(item.execution_id) &&
    EVENT_MODULES.has(item.module) && EVENT_TYPES.has(item.event) && EVENT_MODES.has(item.mode) && validDate(item.date);
}

/**
 * 批量校验并保存匿名执行事件；任何一项格式不合法都会拒绝整批。
 * 重复或冲突事件静默忽略，成功响应表示整批已处理，不表示每项都有新插入。
 */
export async function handleEvents(request, env) {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const parsed = await readJson(request, 64 * 1024);
  if (parsed.response) return parsed.response;
  const body = parsed.body;
  if (!body || Object.keys(body).join() !== "events" || !Array.isArray(body.events) ||
      body.events.length < 1 || body.events.length > MAX_BATCH || body.events.some(item => !validEvent(item))) {
    return jsonError(400, "invalid_events");
  }

  // created_at 是本批接收时间；item.date 是业务日期，供每日聚合使用。
  const now = new Date().toISOString();
  // UNIQUE(execution_id, event) 配合 INSERT OR IGNORE 去重客户端重发。
  // NOT EXISTS 保证同一次执行的安装、模块、日期一致，且 success/failed 只接受首个。
  // 不要求 start 先到，允许离线队列乱序发送。
  // D1 batch 与插入触发器一起提交明细和汇总；任一步失败时整批回滚。
  try {
    const results = await env.rolemi_metrics.batch(body.events.map(item => env.rolemi_metrics.prepare(`
      INSERT OR IGNORE INTO events
        (installation_id, execution_id, module, mode, event, event_date, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (
        SELECT 1 FROM events WHERE execution_id = ? AND
          (installation_id != ? OR module != ? OR mode != ? OR event_date != ? OR
            (? IN ('success', 'failed') AND event IN ('success', 'failed')))
      )
    `).bind(item.installation_id, item.execution_id, item.module, item.mode, item.event, item.date, now,
      item.execution_id, item.installation_id, item.module, item.mode, item.date, item.event)));

    // 只打印真正写入的新事件；客户端离线队列重发被去重后不会再次污染业务日志。
    body.events.forEach((item, index) => {
      if ((results[index]?.meta?.changes ?? 0) > 0) {
        console.info(`[USER ${item.installation_id.slice(0, 8)}] [EVENT] ${item.module} ${item.event.toUpperCase()}`);
      }
    });
  } catch {
    return jsonError(503, "metrics_unavailable");
  }
  return Response.json({ success: true });
}
