-- 仅新插入事件触发汇总；被忽略的重复事件不会再次计数，也不回补历史事件。
-- 触发器与事件写入处于同一事务，汇总失败时事件明细也回滚。
CREATE TRIGGER IF NOT EXISTS events_aggregate_insert
AFTER INSERT ON events
WHEN NEW.module != 'legacy'
BEGIN
  -- 累计安装实例：首次出现建档，后续事件更新最近上报时间。
  INSERT INTO installations (installation_id, first_seen_at, last_seen_at)
  VALUES (NEW.installation_id, NEW.created_at, NEW.created_at)
  ON CONFLICT(installation_id) DO UPDATE SET last_seen_at = excluded.last_seen_at;
  -- 每日活跃安装：同一日期、同一安装只保留一条。
  INSERT OR IGNORE INTO daily_installations (event_date, installation_id, first_seen_at)
  VALUES (NEW.event_date, NEW.installation_id, NEW.created_at);
  -- 按业务日期、模块和事件状态分别累计，不包含业务正文。
  INSERT INTO daily_metrics (event_date, module, event, count)
  VALUES (NEW.event_date, NEW.module, NEW.event, 1)
  ON CONFLICT(event_date, module, event) DO UPDATE SET count = count + 1;
END;
