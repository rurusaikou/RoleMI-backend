-- 已有数据库一次性升级：历史事件无法可靠推断服务模式，统一标记 unknown。
-- 新事件接口只接受 hosted/custom；unknown 仅供迁移后的历史数据使用。
ALTER TABLE events ADD COLUMN mode TEXT NOT NULL DEFAULT 'unknown'
  CHECK (mode IN ('hosted', 'custom', 'unknown'));
