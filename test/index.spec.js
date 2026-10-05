import { env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, it, expect, vi } from "vitest";
import aggregates from "../sql/event-aggregates.sql?raw";
import { OUTPUT_LIMITS } from "../src/config.js";
import { reserveQuota } from "../src/quota.js";
import worker from "../src/index.js";
import schema from "../sql/schema.sql?raw";

async function initSchema() {
  for (const statement of schema.split(";").map(s => s.trim()).filter(Boolean)) {
    await env.rolemi_metrics.prepare(statement).run();
  }
}

beforeAll(async () => { await initSchema(); await env.rolemi_metrics.prepare(aggregates).run(); });

describe("RoleMI worker", () => {
  it("returns backend health", async () => {
    const response = await SELF.fetch("http://localhost/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: "RoleMI Backend", status: "ok" });
  });

  it("accepts minimal events, deduplicates retries, and aggregates without business content", async () => {
    const installation = "11111111-1111-4111-8111-111111111111";
    const execution = "22222222-2222-4222-8222-222222222222";
    const date = new Date().toISOString().slice(0, 10);
    const body = { events: [{ installation_id: installation, execution_id: execution, module: "deep_analysis", mode: "custom", event: "start", date }] };
    expect((await SELF.fetch("http://localhost/api/events", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).status).toBe(200);
    expect((await SELF.fetch("http://localhost/api/events", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).status).toBe(200);
    expect((await env.rolemi_metrics.prepare("SELECT COUNT(*) AS n FROM events WHERE execution_id = ?").bind(execution).first()).n).toBe(1);
    expect((await env.rolemi_metrics.prepare("SELECT mode FROM events WHERE execution_id = ?").bind(execution).first()).mode).toBe("custom");
    expect((await env.rolemi_metrics.prepare("SELECT count FROM daily_metrics WHERE event_date=? AND module=? AND event=?").bind(date, "deep_analysis", "start").first()).count).toBe(1);
    expect((await env.rolemi_metrics.prepare("SELECT COUNT(*) AS n FROM installations WHERE installation_id=?").bind(installation).first()).n).toBe(1);
  });

  it("rejects event payloads containing extra/business fields", async () => {
    const date = new Date().toISOString().slice(0, 10);
    const response = await SELF.fetch("http://localhost/api/events", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ events: [{
      installation_id: "33333333-3333-4333-8333-333333333333", execution_id: "44444444-4444-4444-8444-444444444444",
      module: "greeting", mode: "custom", event: "success", date, resume: "private resume"
    }] }) });
    expect(response.status).toBe(400);
  });

  it("uses server model/key and stores only AI metrics", async () => {
    const result = JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "private model output" }] }], usage: { input_tokens: 32, output_tokens: 10, output_tokens_details: { reasoning_tokens: 6 } } });
    const upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
      expect(url).toBe("https://api.deepseek.com/responses");
      expect(options.headers.Authorization).toBe("Bearer test-only-secret");
      const sent = JSON.parse(options.body);
      expect(sent.model).toBe("deepseek-v4-flash");
      return new Response(result, { headers: { "content-type": "application/json" } });
    });
    try {
      const response = await SELF.fetch("http://localhost/api/ai", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        installation_id: "55555555-5555-4555-8555-555555555555", module: "deep_analysis",
        request: { model: "client-must-not-control-this", input: [{ role: "user", content: "private resume" }] }
      }) });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(result);
      const row = await env.rolemi_metrics.prepare("SELECT * FROM ai_calls WHERE installation_id=?").bind("55555555-5555-4555-8555-555555555555").first();
      expect(row).toMatchObject({ module: "deep_analysis", model: "deepseek-v4-flash", input_chars: 14, input_tokens: 32, reasoning_tokens: 6, output_tokens: 10, status: "success" });
      expect(JSON.stringify(row)).not.toContain("private");
    } finally { upstream.mockRestore(); }
  });

  it("rejects unknown origins", async () => {
    const response = await SELF.fetch("http://localhost/api/events", { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, body: "{}" });
    expect(response.status).toBe(403);
  });
});

beforeEach(async () => { await env.rolemi_metrics.prepare('DELETE FROM ai_quota_attempts').run(); });

const post = (path, body) => SELF.fetch(`http://localhost${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});
const aiBody = (request = {}) => ({ installation_id: crypto.randomUUID(), module: 'greeting', request: { input: 'hello', ...request } });

it('enforces actual UTF-8 request bytes without a length header', async () => {
  expect((await post('/api/ai', aiBody({ input: '中'.repeat(35000) }))).status).toBe(413);
  expect((await post('/api/events', { events: [], extra: 'x'.repeat(66000) })).status).toBe(413);
});
it('validates AI identity, text limit, streaming, and unsupported upstream controls', async () => {
  expect((await post('/api/ai', { ...aiBody(), installation_id: 'not-a-uuid' })).status).toBe(400);
  expect((await post('/api/ai', { ...aiBody(), installation_id: [crypto.randomUUID()] })).status).toBe(400);
  expect((await post('/api/ai', aiBody({ input: 'x'.repeat(24001) }))).status).toBe(413);
  expect((await post('/api/ai', aiBody({ stream: true }))).status).toBe(400);
  expect((await post('/api/ai', aiBody({ tools: [{ type: 'web_search' }] }))).status).toBe(400);
  expect((await post('/api/ai', aiBody({ max_output_tokens: -1 }))).status).toBe(400);
});
it('keeps backend output caps aligned with the highest supported client budgets', () => {
  expect(OUTPUT_LIMITS).toEqual({
    deep_analysis: 5000,
    resume_profile: 4000,
    resume_match: 6000,
    resume_revision: 8000,
    greeting: 3200,
    settings_test: 40,
  });
});
it('atomically reserves only six of twenty concurrent attempts', async () => {
  const id = crypto.randomUUID();
  const results = await Promise.all(Array.from({ length: 20 }, () => reserveQuota(env, id, 'greeting')));
  expect(results.filter(Boolean)).toHaveLength(6);
});
it('disables all quotas while recording attempts and supports restoring limits', async () => {
  const id = crypto.randomUUID();
  const now = new Date('2040-01-02T12:00:00Z');
  const config = { ...env, AI_INSTALLATION_DAILY_LIMIT: '1', AI_INSTALLATION_MINUTE_LIMIT: '1', AI_GLOBAL_DAILY_LIMIT: '1' };
  expect(await reserveQuota(config, id, 'greeting', now)).toBe(true);
  expect(await reserveQuota(config, id, 'greeting', now)).toBe(false);
  for (const flag of ['true', true]) {
    expect(await reserveQuota({ ...config, AI_QUOTA_DISABLED: flag }, id, 'greeting', now)).toBe(true);
  }
  expect((await env.rolemi_metrics.prepare('SELECT COUNT(*) AS n FROM ai_quota_attempts').first()).n).toBe(3);
  for (const flag of ['false', false, 'invalid']) {
    expect(await reserveQuota({ ...config, AI_QUOTA_DISABLED: flag }, id, 'greeting', now)).toBe(false);
  }
});
it('enforces daily installation and global budgets', async () => {
  const now = new Date('2040-01-02T12:00:00Z');
  const id = crypto.randomUUID();
  await env.rolemi_metrics.batch(Array.from({ length: 20 }, () => env.rolemi_metrics.prepare(
    'INSERT INTO ai_quota_attempts (installation_id,module,created_at) VALUES (?, ?, ?)'
  ).bind(id, 'greeting', '2040-01-02T10:00:00.000Z')));
  expect(await reserveQuota(env, id, 'greeting', now)).toBe(false);
  await env.rolemi_metrics.batch(Array.from({ length: 180 }, () => env.rolemi_metrics.prepare(
    'INSERT INTO ai_quota_attempts (installation_id,module,created_at) VALUES (?, ?, ?)'
  ).bind(crypto.randomUUID(), 'greeting', '2040-01-02T10:00:00.000Z')));
  expect(await reserveQuota(env, crypto.randomUUID(), 'greeting', now)).toBe(false);
});
it('accepts out-of-order events but keeps only the first terminal outcome', async () => {
  const item = { installation_id: crypto.randomUUID(), execution_id: crypto.randomUUID(), module: 'favorite', mode: 'custom', event: 'success', date: new Date().toISOString().slice(0, 10) };
  expect((await post('/api/events', { events: [item, { ...item, event: 'failed' }, { ...item, event: 'start' }, item] })).status).toBe(200);
  const rows = await env.rolemi_metrics.prepare('SELECT event FROM events WHERE execution_id=? ORDER BY event').bind(item.execution_id).all();
  expect(rows.results.map(row => row.event)).toEqual(['start', 'success']);
  expect((await post('/api/events', { events: [{ ...item, event: 'failed', date: '2026-02-30' }] })).status).toBe(400);
  expect((await post('/api/events', { events: [{ ...item, installation_id: [item.installation_id] }] })).status).toBe(400);
  expect((await post('/api/events', { events: [{ ...item, mode: 'unknown' }] })).status).toBe(400);
  expect((await post('/api/events', { events: [{ ...item, mode: 'other' }] })).status).toBe(400);
});
it('rolls back event receipts when aggregation fails, then allows retry', async () => {
  const item = { installation_id: crypto.randomUUID(), execution_id: crypto.randomUUID(), module: 'excel_export', mode: 'hosted', event: 'start', date: new Date().toISOString().slice(0, 10) };
  await env.rolemi_metrics.prepare(`CREATE TRIGGER test_aggregate_failure BEFORE INSERT ON daily_metrics WHEN NEW.module='excel_export' BEGIN SELECT RAISE(ABORT, 'test'); END;`).run();
  try {
    expect((await post('/api/events', { events: [item] })).status).toBe(503);
    expect((await env.rolemi_metrics.prepare('SELECT COUNT(*) AS n FROM events WHERE execution_id=?').bind(item.execution_id).first()).n).toBe(0);
  } finally { await env.rolemi_metrics.prepare('DROP TRIGGER test_aggregate_failure').run(); }
  expect((await post('/api/events', { events: [item] })).status).toBe(200);
});
it('bounds output and preserves reasoning compatibility errors and incomplete responses', async () => {
  const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
    const sent = JSON.parse(options.body);
    expect(sent.max_output_tokens).toBe(40);
    expect(sent.store).toBe(false);
    if (sent.reasoning) return Response.json({ error: { message: 'unsupported reasoning' } }, { status: 422 });
    return Response.json({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } });
  });
  try {
    const body = { ...aiBody({ max_output_tokens: 999999, reasoning: { effort: 'none' } }), module: 'settings_test' };
    expect((await post('/api/ai', body)).status).toBe(422);
    delete body.request.reasoning;
    expect((await (await post('/api/ai', body)).json()).status).toBe('incomplete');
  } finally { upstream.mockRestore(); }
});
it('returns configuration, quota storage and network errors without sensitive text', async () => {
  const request = () => new Request('http://localhost/api/ai', { method: 'POST', body: JSON.stringify(aiBody()) });
  expect((await worker.fetch(request(), { ...env, AI_API_KEY: '' })).status).toBe(503);
  expect((await worker.fetch(request(), { ...env, rolemi_metrics: {} })).status).toBe(503);
  const upstream = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('private upstream data'));
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const result = await worker.fetch(request(), env);
    expect(result.status).toBe(502);
    expect(await result.json()).toEqual({ error: { code: 'upstream_unavailable' } });
    expect(errorLog.mock.calls.flat().join(' ')).not.toContain('private upstream data');
  } finally { upstream.mockRestore(); errorLog.mockRestore(); }
});
it('supports extension preflight and rejects unknown routes and methods', async () => {
  const response = await SELF.fetch('http://localhost/api/ai', { method: 'OPTIONS', headers: { Origin: 'chrome-extension://test' } });
  expect(response.status).toBe(204);
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe('chrome-extension://test');
  expect((await SELF.fetch('http://localhost/api/ai')).status).toBe(405);
  expect((await SELF.fetch('http://localhost/missing')).status).toBe(404);
});
it('scheduled retention removes old details and preserves cumulative aggregates', async () => {
  const id = crypto.randomUUID();
  await env.rolemi_metrics.prepare('INSERT INTO events (installation_id,execution_id,module,mode,event,event_date,created_at) VALUES (?,?,?,?,?,?,?)')
    .bind(id, crypto.randomUUID(), 'favorite', 'hosted', 'start', '2000-01-01', '2000-01-01T00:00:00.000Z').run();
  await worker.scheduled({}, env);
  expect((await env.rolemi_metrics.prepare('SELECT COUNT(*) AS n FROM events WHERE installation_id=?').bind(id).first()).n).toBe(0);
  expect((await env.rolemi_metrics.prepare('SELECT COUNT(*) AS n FROM daily_installations WHERE installation_id=?').bind(id).first()).n).toBe(0);
  expect((await env.rolemi_metrics.prepare('SELECT COUNT(*) AS n FROM installations WHERE installation_id=?').bind(id).first()).n).toBe(1);
  expect((await env.rolemi_metrics.prepare("SELECT count FROM daily_metrics WHERE event_date='2000-01-01' AND module='favorite'").first()).count).toBe(1);
});

it("stores feedback with the selected job workflow snapshot", async () => {
  const installation = crypto.randomUUID();
  const payload = {
    installation_id: installation,
    type: "analysis_inaccurate",
    content: "核心要求判断不准确",
    job_id: "job-123",
    job_title: "AI 产品经理",
    jd_content: "负责 AI Agent 产品规划",
    deep_analysis_result: { essence: ["AI 产品"] },
    match_result: { decision: "strong" },
    revision_result: [{ suggestion: "突出 Agent 项目" }],
    greeting_result: { greeting: "您好，我有相关经验。" }
  };
  const response = await SELF.fetch("http://localhost/api/feedback", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
  });
  expect(response.status).toBe(200);
  const row = await env.rolemi_metrics.prepare("SELECT * FROM feedback WHERE installation_id=?").bind(installation).first();
  expect(row).toMatchObject({ type: payload.type, content: payload.content, job_id: "job-123", job_title: "AI 产品经理", jd_content: payload.jd_content });
  expect(JSON.parse(row.deep_analysis_result)).toEqual(payload.deep_analysis_result);
  expect(JSON.parse(row.match_result)).toEqual(payload.match_result);
  expect(JSON.parse(row.revision_result)).toEqual(payload.revision_result);
  expect(JSON.parse(row.greeting_result)).toEqual(payload.greeting_result);
});

it("allows feedback without a related job and rejects snapshots without job id", async () => {
  const installation_id = crypto.randomUUID();
  expect((await SELF.fetch("http://localhost/api/feedback", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ installation_id, type: "suggestion", content: "希望增加筛选功能" })
  })).status).toBe(200);
  expect((await SELF.fetch("http://localhost/api/feedback", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ installation_id, type: "analysis_inaccurate", content: "不准", jd_content: "orphan JD" })
  })).status).toBe(400);
});
