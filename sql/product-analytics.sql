-- RoleMI 产品分析报表（D1 / SQLite）
--
-- 默认分析最近 30 个 UTC 业务日期（含今天）。events、ai_calls 和
-- daily_installations 的保留期约为 30 天，因此不要把本文件用于长期安装级分析。
-- 所有“安装”均指 installation_id，不代表自然人或商店下载量。

-- ============================================================================
-- 1. 规模：DAU、新激活安装、安装均执行次数
-- ============================================================================
-- 报表名称：规模日报
-- 新激活安装 = installations.first_seen_at 首次被业务事件观察到的日期。
-- 执行次数按 DISTINCT execution_id 计算，不会把 start/success 重复计数。
WITH RECURSIVE
calendar(day) AS (
  SELECT date('now', '-29 days')
  UNION ALL
  SELECT date(day, '+1 day') FROM calendar WHERE day < date('now')
),
active AS (
  SELECT event_date AS day, COUNT(*) AS active_installations
  FROM daily_installations
  WHERE event_date BETWEEN date('now', '-29 days') AND date('now')
  GROUP BY event_date
),
activated AS (
  SELECT substr(first_seen_at, 1, 10) AS day, COUNT(*) AS new_activated_installations
  FROM installations
  WHERE first_seen_at >= strftime('%Y-%m-%dT00:00:00.000Z', 'now', '-29 days')
    AND first_seen_at < strftime('%Y-%m-%dT00:00:00.000Z', 'now', '+1 day')
  GROUP BY substr(first_seen_at, 1, 10)
),
executions AS (
  SELECT event_date AS day, COUNT(DISTINCT execution_id) AS executions
  FROM events
  WHERE event_date BETWEEN date('now', '-29 days') AND date('now')
  GROUP BY event_date
)
SELECT c.day AS "日期",
       COALESCE(a.active_installations, 0) AS "日活跃安装数",
       COALESCE(n.new_activated_installations, 0) AS "新激活安装数",
       COALESCE(e.executions, 0) AS "执行次数",
       CASE WHEN COALESCE(a.active_installations, 0) = 0 THEN NULL
            ELSE ROUND(1.0 * e.executions / a.active_installations, 2)
       END AS "活跃安装平均执行次数"
FROM calendar c
LEFT JOIN active a ON a.day = c.day
LEFT JOIN activated n ON n.day = c.day
LEFT JOIN executions e ON e.day = c.day
ORDER BY c.day DESC;

-- ============================================================================
-- 2. 核心漏斗：最近 30 天同日安装级近似漏斗
-- ============================================================================
-- 报表名称：核心功能累进漏斗
-- 只使用 success 事件。jd_extract / jd_manual 合并为“JD 获取”。
-- 每一级要求同一个 installation_id 在同一个 event_date 命中本级及所有前级。
-- 这不是同一岗位的严格漏斗：当前事件没有 workflow_id/job_id，也不能证明步骤顺序。
WITH installation_day_flags AS (
  SELECT event_date,
         installation_id,
         MAX(CASE WHEN module IN ('jd_extract', 'jd_manual') THEN 1 ELSE 0 END) AS jd_get,
         MAX(CASE WHEN module = 'deep_analysis' THEN 1 ELSE 0 END) AS deep_analysis,
         MAX(CASE WHEN module = 'resume_match' THEN 1 ELSE 0 END) AS resume_match,
         MAX(CASE WHEN module = 'resume_revision' THEN 1 ELSE 0 END) AS resume_revision,
         MAX(CASE WHEN module = 'greeting' THEN 1 ELSE 0 END) AS greeting,
         MAX(CASE WHEN module = 'excel_export' THEN 1 ELSE 0 END) AS excel_export
  FROM events
  WHERE event = 'success'
    AND event_date BETWEEN date('now', '-29 days') AND date('now')
  GROUP BY event_date, installation_id
),
steps(step_order, step) AS (
  VALUES (1, 'jd_get'), (2, 'deep_analysis'), (3, 'resume_match'),
         (4, 'resume_revision'), (5, 'greeting'), (6, 'excel_export')
),
funnel AS (
  SELECT s.step_order, s.step,
         SUM(CASE
           WHEN s.step_order = 1 AND f.jd_get = 1 THEN 1
           WHEN s.step_order = 2 AND f.jd_get = 1 AND f.deep_analysis = 1 THEN 1
           WHEN s.step_order = 3 AND f.jd_get = 1 AND f.deep_analysis = 1 AND f.resume_match = 1 THEN 1
           WHEN s.step_order = 4 AND f.jd_get = 1 AND f.deep_analysis = 1 AND f.resume_match = 1
             AND f.resume_revision = 1 THEN 1
           WHEN s.step_order = 5 AND f.jd_get = 1 AND f.deep_analysis = 1 AND f.resume_match = 1
             AND f.resume_revision = 1 AND f.greeting = 1 THEN 1
           WHEN s.step_order = 6 AND f.jd_get = 1 AND f.deep_analysis = 1 AND f.resume_match = 1
             AND f.resume_revision = 1 AND f.greeting = 1 AND f.excel_export = 1 THEN 1
           ELSE 0
         END) AS installations
  FROM steps s
  LEFT JOIN installation_day_flags f ON 1 = 1
  GROUP BY s.step_order, s.step
),
rates AS (
  SELECT step_order, step, COALESCE(installations, 0) AS installations,
         LAG(COALESCE(installations, 0)) OVER (ORDER BY step_order) AS previous_installations,
         FIRST_VALUE(COALESCE(installations, 0)) OVER (ORDER BY step_order) AS entry_installations
  FROM funnel
)
SELECT step_order AS "步骤序号",
       CASE step
         WHEN 'jd_get' THEN 'JD 获取'
         WHEN 'deep_analysis' THEN '深度分析'
         WHEN 'resume_match' THEN '简历匹配'
         WHEN 'resume_revision' THEN '简历修改'
         WHEN 'greeting' THEN '招呼语生成'
         WHEN 'excel_export' THEN 'Excel 导出'
       END AS "漏斗步骤",
       installations AS "到达安装数",
       CASE WHEN previous_installations IS NULL OR previous_installations = 0 THEN NULL
            ELSE ROUND(100.0 * installations / previous_installations, 2)
       END AS "较上一步转化率百分比",
       CASE WHEN entry_installations = 0 THEN NULL
            ELSE ROUND(100.0 * installations / entry_installations, 2)
       END AS "较入口转化率百分比"
FROM rates
ORDER BY step_order;

-- 各漏斗模块的独立成功安装数。不要求命中前级，用来识别用户跳步或埋点缺失。
-- 报表名称：各漏斗步骤独立成功量
SELECT CASE
         WHEN module IN ('jd_extract', 'jd_manual') THEN 'JD 获取'
         WHEN module = 'deep_analysis' THEN '深度分析'
         WHEN module = 'resume_match' THEN '简历匹配'
         WHEN module = 'resume_revision' THEN '简历修改'
         WHEN module = 'greeting' THEN '招呼语生成'
         WHEN module = 'excel_export' THEN 'Excel 导出'
       END AS "功能步骤",
       COUNT(DISTINCT installation_id || '|' || event_date) AS "成功安装日数"
FROM events
WHERE event = 'success'
  AND module IN ('jd_extract', 'jd_manual', 'deep_analysis', 'resume_match',
                 'resume_revision', 'greeting', 'excel_export')
  AND event_date BETWEEN date('now', '-29 days') AND date('now')
GROUP BY CASE WHEN module IN ('jd_extract', 'jd_manual') THEN 'jd_get' ELSE module END
ORDER BY CASE (CASE WHEN module IN ('jd_extract', 'jd_manual') THEN 'jd_get' ELSE module END)
  WHEN 'jd_get' THEN 1 WHEN 'deep_analysis' THEN 2 WHEN 'resume_match' THEN 3
  WHEN 'resume_revision' THEN 4 WHEN 'greeting' THEN 5 WHEN 'excel_export' THEN 6
END;

-- ============================================================================
-- 3. 模块质量：start / success / failed / 无终态，含 hosted/custom 对比
-- ============================================================================
-- 报表名称：模块质量与托管模式对比
-- 先按 execution_id 收拢事件，避免用 success/start 聚合比值造成口径混乱。
-- 无终态 = 有 start，但没有 success 或 failed。
WITH execution_outcomes AS (
  SELECT event_date, module, mode, execution_id,
         MAX(CASE WHEN event = 'start' THEN 1 ELSE 0 END) AS has_start,
         MAX(CASE WHEN event = 'success' THEN 1 ELSE 0 END) AS has_success,
         MAX(CASE WHEN event = 'failed' THEN 1 ELSE 0 END) AS has_failed
  FROM events
  WHERE event_date BETWEEN date('now', '-29 days') AND date('now')
  GROUP BY event_date, module, mode, execution_id
)
SELECT module AS "功能模块",
       mode AS "服务模式",
       COUNT(*) AS "观察到的执行数",
       SUM(has_start) AS "开始执行数",
       SUM(has_success) AS "成功执行数",
       SUM(has_failed) AS "失败执行数",
       SUM(CASE WHEN has_start = 1 AND has_success = 0 AND has_failed = 0 THEN 1 ELSE 0 END) AS "无终态执行数",
       SUM(CASE WHEN has_start = 0 AND (has_success = 1 OR has_failed = 1) THEN 1 ELSE 0 END) AS "缺少开始事件的终态数",
       CASE WHEN SUM(has_start) = 0 THEN NULL
            ELSE ROUND(100.0 * SUM(CASE WHEN has_start = 1 AND has_success = 1 THEN 1 ELSE 0 END)
                       / SUM(has_start), 2)
       END AS "开始后成功率百分比",
       CASE WHEN SUM(has_start) = 0 THEN NULL
            ELSE ROUND(100.0 * SUM(CASE WHEN has_start = 1 AND has_failed = 1 THEN 1 ELSE 0 END)
                       / SUM(has_start), 2)
       END AS "开始后失败率百分比",
       CASE WHEN SUM(has_start) = 0 THEN NULL
            ELSE ROUND(100.0 * SUM(CASE WHEN has_start = 1 AND has_success = 0 AND has_failed = 0 THEN 1 ELSE 0 END)
                       / SUM(has_start), 2)
       END AS "开始后无终态率百分比"
FROM execution_outcomes
GROUP BY module, mode
ORDER BY module, mode;

-- ============================================================================
-- 4. AI 效率：按日、模块拆分调用量、Token、延迟与成功率
-- ============================================================================
-- 报表名称：AI 每日效率
-- avg_latency_ms / p95_latency_ms 仅包含 Worker 调用上游并读取完整响应的时间。
-- Token 为 NULL 表示上游没有返回合法用量；known_*_rows 用于判断覆盖率。
WITH base AS (
  SELECT substr(created_at, 1, 10) AS day, module, status,
         input_tokens, reasoning_tokens, output_tokens, latency_ms,
         ROW_NUMBER() OVER (
           PARTITION BY substr(created_at, 1, 10), module ORDER BY latency_ms
         ) AS latency_rank,
         COUNT(*) OVER (
           PARTITION BY substr(created_at, 1, 10), module
         ) AS group_calls
  FROM ai_calls
  WHERE created_at >= strftime('%Y-%m-%dT00:00:00.000Z', 'now', '-29 days')
    AND created_at < strftime('%Y-%m-%dT00:00:00.000Z', 'now', '+1 day')
)
SELECT day AS "日期",
       module AS "AI 模块",
       COUNT(*) AS "调用次数",
       SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS "成功调用数",
       SUM(CASE WHEN status = 'incomplete' THEN 1 ELSE 0 END) AS "未完整调用数",
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS "失败调用数",
       ROUND(100.0 * SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) / COUNT(*), 2) AS "成功率百分比",
       SUM(input_tokens) AS "输入Token合计",
       SUM(reasoning_tokens) AS "推理Token合计",
       SUM(output_tokens) AS "输出Token合计",
       SUM(CASE WHEN input_tokens IS NOT NULL THEN 1 ELSE 0 END) AS "输入Token已知记录数",
       SUM(CASE WHEN reasoning_tokens IS NOT NULL THEN 1 ELSE 0 END) AS "推理Token已知记录数",
       SUM(CASE WHEN output_tokens IS NOT NULL THEN 1 ELSE 0 END) AS "输出Token已知记录数",
       ROUND(AVG(latency_ms), 0) AS "平均延迟毫秒",
       MAX(CASE WHEN latency_rank = CAST((95 * group_calls + 99) / 100 AS INTEGER)
                THEN latency_ms END) AS "P95延迟毫秒"
FROM base
GROUP BY day, module
ORDER BY day DESC, module;

-- 最近 30 天按模块汇总，适合直接比较哪些模块最耗 Token、最慢或最不稳定。
-- 报表名称：AI 模块30天汇总
SELECT module AS "AI 模块",
       COUNT(*) AS "调用次数",
       SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS "成功调用数",
       SUM(CASE WHEN status = 'incomplete' THEN 1 ELSE 0 END) AS "未完整调用数",
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS "失败调用数",
       ROUND(100.0 * SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) / COUNT(*), 2) AS "成功率百分比",
       SUM(input_tokens) AS "输入Token合计",
       SUM(reasoning_tokens) AS "推理Token合计",
       SUM(output_tokens) AS "输出Token合计",
       ROUND(AVG(input_tokens), 1) AS "已知输入Token平均值",
       ROUND(AVG(output_tokens), 1) AS "已知输出Token平均值",
       ROUND(AVG(latency_ms), 0) AS "平均延迟毫秒"
FROM ai_calls
WHERE created_at >= strftime('%Y-%m-%dT00:00:00.000Z', 'now', '-29 days')
  AND created_at < strftime('%Y-%m-%dT00:00:00.000Z', 'now', '+1 day')
GROUP BY module
ORDER BY COUNT(*) DESC, module;

-- ============================================================================
-- 5. 用户声音：反馈量、类型、Bad Case、每千次执行反馈率
-- ============================================================================
-- 最近 30 天按日和反馈类型统计。
-- 报表名称：每日反馈类型分布
SELECT substr(created_at, 1, 10) AS "日期",
       type AS "反馈类型",
       COUNT(*) AS "反馈数量"
FROM feedback
WHERE created_at >= strftime('%Y-%m-%dT00:00:00.000Z', 'now', '-29 days')
  AND created_at < strftime('%Y-%m-%dT00:00:00.000Z', 'now', '+1 day')
GROUP BY substr(created_at, 1, 10), type
ORDER BY substr(created_at, 1, 10) DESC, COUNT(*) DESC, type;

-- 高频 Bad Case 的当前可用近似：完全相同（忽略首尾空格和大小写）的反馈正文。
-- 自由文本表达不同但语义相同的反馈不会被自动合并，需要人工/AI 二次归类。
-- 报表名称：重复出现的Bad Case
SELECT type AS "反馈类型",
       lower(trim(content)) AS "标准化反馈正文",
       COUNT(*) AS "出现次数",
       MIN(created_at) AS "首次反馈时间",
       MAX(created_at) AS "最近反馈时间"
FROM feedback
WHERE created_at >= strftime('%Y-%m-%dT00:00:00.000Z', 'now', '-179 days')
  AND created_at < strftime('%Y-%m-%dT00:00:00.000Z', 'now', '+1 day')
GROUP BY type, lower(trim(content))
HAVING COUNT(*) >= 2
ORDER BY COUNT(*) DESC, MAX(created_at) DESC
LIMIT 50;

-- Bad Case 人工复盘队列：不输出 JD 和模型结果正文，只提示是否有岗位快照。
-- 报表名称：Bad Case人工复盘队列
SELECT id AS "反馈ID",
       substr(installation_id, 1, 8) AS "安装短标识",
       type AS "反馈类型",
       content AS "反馈正文",
       job_title AS "岗位标题",
       CASE WHEN job_id IS NULL THEN '否' ELSE '是' END AS "是否包含岗位快照",
       created_at AS "反馈时间"
FROM feedback
WHERE type IN ('function_error', 'analysis_inaccurate')
ORDER BY created_at DESC
LIMIT 100;

-- 每千次执行反馈率。分子、分母都限制在同一个 30 日窗口。
-- 当前 feedback 没有 module/execution_id，因此只能计算总体相关率，不能精确归因到模块。
-- 报表名称：每日每千次执行反馈率
WITH daily_executions AS (
  SELECT event_date AS day, COUNT(DISTINCT execution_id) AS executions
  FROM events
  WHERE event_date BETWEEN date('now', '-29 days') AND date('now')
  GROUP BY event_date
),
daily_feedback AS (
  SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS feedback_count
  FROM feedback
  WHERE created_at >= strftime('%Y-%m-%dT00:00:00.000Z', 'now', '-29 days')
    AND created_at < strftime('%Y-%m-%dT00:00:00.000Z', 'now', '+1 day')
  GROUP BY substr(created_at, 1, 10)
)
SELECT e.day AS "日期",
       e.executions AS "执行次数",
       COALESCE(f.feedback_count, 0) AS "反馈数量",
       ROUND(1000.0 * COALESCE(f.feedback_count, 0) / e.executions, 2) AS "每千次执行反馈数"
FROM daily_executions e
LEFT JOIN daily_feedback f ON f.day = e.day
WHERE e.executions > 0
ORDER BY e.day DESC;

-- 整个 30 日窗口的每千次执行反馈率。
-- 报表名称：近30天每千次执行反馈率
WITH totals AS (
  SELECT (SELECT COUNT(DISTINCT execution_id)
          FROM events
          WHERE event_date BETWEEN date('now', '-29 days') AND date('now')) AS executions,
         (SELECT COUNT(*)
          FROM feedback
          WHERE created_at >= strftime('%Y-%m-%dT00:00:00.000Z', 'now', '-29 days')
            AND created_at < strftime('%Y-%m-%dT00:00:00.000Z', 'now', '+1 day')) AS feedback_count
)
SELECT executions AS "执行次数",
       feedback_count AS "反馈数量",
       CASE WHEN executions = 0 THEN NULL
            ELSE ROUND(1000.0 * feedback_count / executions, 2)
       END AS "每千次执行反馈数"
FROM totals;
