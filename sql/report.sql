-- 累计安装只来自已接收的业务事件，不包括仅调用 AI 的安装。
SELECT COUNT(*) AS anonymous_installations FROM installations;
-- 取最近 30 个有记录日期；保留期限由 scheduled 清理控制。
SELECT event_date, COUNT(*) AS active_installations FROM daily_installations GROUP BY event_date ORDER BY event_date DESC LIMIT 30;
SELECT event_date, module, event, count FROM daily_metrics ORDER BY event_date DESC, module, event;
-- 服务模式明细直接从 events 统计；unknown 仅代表升级前的历史记录。
SELECT event_date, mode, module, event, COUNT(*) AS count
FROM events GROUP BY event_date, mode, module, event
ORDER BY event_date DESC, mode, module, event;
-- ai_calls 写入为尽力而为，可能缺失；NULL Token 按 0 展示仅代表已知用量合计。
SELECT substr(created_at,1,10) AS day, model, status, COUNT(*) AS calls,
       SUM(COALESCE(input_tokens,0)) AS input_tokens,
       SUM(COALESCE(output_tokens,0)) AS output_tokens,
       ROUND(AVG(latency_ms),0) AS avg_latency_ms
FROM ai_calls GROUP BY day, model, status ORDER BY day DESC;
