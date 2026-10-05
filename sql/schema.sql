PRAGMA foreign_keys = ON;

-- AI 模型调用明细：只保存匿名标识、模块、用量、耗时和状态，不保存业务正文。
CREATE TABLE IF NOT EXISTS ai_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  installation_id TEXT NOT NULL,
  module TEXT NOT NULL,
  model TEXT NOT NULL,
  input_chars INTEGER,
  input_tokens INTEGER,
  reasoning_tokens INTEGER,
  output_tokens INTEGER,
  latency_ms INTEGER,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_calls_created_at ON ai_calls(created_at);
CREATE INDEX IF NOT EXISTS idx_ai_calls_installation_created ON ai_calls(installation_id, created_at);

-- 客户端模块事件。execution_id + event 唯一，客户端重发不会重复计数。
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  installation_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  module TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('hosted', 'custom', 'unknown')),
  event TEXT NOT NULL CHECK (event IN ('start', 'success', 'failed')),
  event_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(execution_id, event)
);
CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
CREATE INDEX IF NOT EXISTS idx_events_installation ON events(installation_id);

-- 匿名累计安装实例。不是自然人数/下载量。
CREATE TABLE IF NOT EXISTS installations (
  installation_id TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

-- 每日匿名安装去重收据，可定期清理。
CREATE TABLE IF NOT EXISTS daily_installations (
  event_date TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  PRIMARY KEY(event_date, installation_id)
);
CREATE INDEX IF NOT EXISTS idx_daily_installations_date ON daily_installations(event_date);

-- 无业务正文的每日聚合。
CREATE TABLE IF NOT EXISTS daily_metrics (
  event_date TEXT NOT NULL,
  module TEXT NOT NULL,
  event TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(event_date, module, event)
);

-- 免费托管额度的模型尝试收据；30 天后可清理。
CREATE TABLE IF NOT EXISTS ai_quota_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  installation_id TEXT NOT NULL,
  module TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quota_installation_created ON ai_quota_attempts(installation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_quota_created ON ai_quota_attempts(created_at);


-- 用户主动提交的反馈及可选岗位工作流快照。与匿名 metrics 不同，本表可能包含 JD 和 AI 输出正文；不保存简历原文。
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  installation_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('function_error', 'analysis_inaccurate', 'suggestion', 'other')),
  content TEXT NOT NULL,
  job_id TEXT,
  job_title TEXT,
  jd_content TEXT,
  deep_analysis_result TEXT,
  match_result TEXT,
  revision_result TEXT,
  greeting_result TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback(created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_installation_created ON feedback(installation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_type_created ON feedback(type, created_at);
