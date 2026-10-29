# RoleMI 产品分析 SQL 使用说明

`sql/product-analytics.sql` 是只读产品报表，覆盖规模、核心漏斗、模块质量、AI 效率和用户反馈，不会建表、更新或删除数据。

## 运行方法

在项目根目录执行：

```bash
# 本地 D1
npm run db:local:analytics

# 生产 D1
npm run db:prod:analytics
```

命令由 `scripts/run-product-analytics.mjs` 读取 SQL，按顶层分号拆分报表，再逐条通过 Wrangler `--command` 发送到 D1 普通查询接口。逐条执行可避免 D1 对超长 compound query 的限制。不要改成 `--file`：Wrangler 会把文件交给 D1 `/import` 接口，即使其中只有 `SELECT`，也可能显示数据库暂时不可用并返回 `Authentication error [code: 10000]`。

只验证生产连接时使用：

```bash
npx wrangler d1 execute rolemi-metrics --remote --env production --command="SELECT 1;"
```

生产报表会输出反馈正文和岗位标题，请勿将原始结果发布到公共渠道。

## 默认窗口

报表默认查询最近 30 个 UTC 日期标签（含当天），因为 `events`、`ai_calls` 和 `daily_installations` 约保留 30 天。重复 Bad Case 单独查询最近 180 天，与 feedback 保留周期一致。

`events.event_date` 是客户端业务日期；`created_at` 和 `first_seen_at` 是服务端 UTC 时间。离线补报和客户端时区可能造成少量按日偏差。

要查询最近 7 天，应在同一条查询中把所有 `-29 days` 一起替换为 `-6 days`，避免分子与分母窗口不同。

## 指标口径

### 规模

| 指标 | 口径 |
| --- | --- |
| 日活跃安装 | `daily_installations` 每日去重安装实例 |
| 新激活安装 | `installations.first_seen_at` 当日首次出现 |
| 执行次数 | 每日 `COUNT(DISTINCT execution_id)` |
| 安装均执行次数 | 执行次数 / 日活跃安装 |

这里的安装是 `installation_id`，不是自然人、注册用户或商店下载量。“新安装实例”更准确的看板名称是“新激活安装”。

### 核心漏斗

漏斗只使用 success 事件，将 `jd_extract` 和 `jd_manual` 合并为 JD 获取：

```text
JD 获取 → 深度分析 → 匹配 → 修改 → 招呼语 → 导出
```

统计单元是 `installation_id + event_date`，每一级要求同一安装在同一天命中本级和所有前级。这是同日安装级近似漏斗，不是同一岗位严格漏斗：现有事件没有跨模块共享的 `workflow_id` 或 `job_id`，也无法可靠证明步骤顺序。

报表同时给出各步骤独立成功安装日数，用于识别跳步、缓存/历史结果或前级埋点缺失。

### 模块质量

先按 `execution_id` 合并，再统计：

- `started`：收到 start；
- `succeeded`：收到 success；
- `failed`：收到 failed；
- `no_terminal`：有 start，但没有 success/failed；
- `terminal_without_start`：有终态但没有 start；
- 三项比例的分母均为 started。

结果按 `module + mode` 分组，可直接比较 hosted/custom。无终态不一定是业务失败，也可能是页面关闭、网络中断或离线队列尚未上报。

### AI 效率

报表按日和模块汇总：调用量、success/incomplete/failed、成功率、三类 Token、平均延迟和 P95 延迟。

Token 为 NULL 表示上游没有返回合法用量。汇总值只是已知用量，因此必须同时看 `known_*_token_rows / calls`，不能把未知记录当成零成本。`latency_ms` 只覆盖 Worker 调用上游并读取完整响应，不是客户端端到端耗时。

`ai_calls.status` 是模型网关状态，events 的 success/failed 是客户端功能状态；当前没有 `execution_id` 将两者精确关联。

### 用户声音

报表提供：

- 每日反馈量和类型；
- 标准化后完全相同正文的重复次数；
- 最近 100 条错误/不准确反馈复盘队列；
- 每日及 30 日总体的每千次执行反馈率。

高频 Bad Case 当前只能合并 `lower(trim(content))` 后完全相同的文本。语义相同但措辞不同的反馈仍需人工或受控 AI 分类。feedback 没有 module/execution_id，所以每千次执行反馈率只能做总体指标，不能精确归因到模块。

## 看板映射

| 结果 | 推荐展示 |
| --- | --- |
| 规模日表 | 指标卡和趋势线 |
| 累进漏斗 | 漏斗图，注明“同日安装级近似” |
| 独立步骤成功数 | 柱状图，用于检查跳步 |
| module/mode 质量 | 按失败率或无终态率排序的表格 |
| AI 日报和模块汇总 | 调用量、成功率、平均/P95 延迟趋势及模块对比 |
| 反馈类型 | 堆叠柱状图 |
| 重复 Bad Case、复盘队列 | 权限受控的内部表格 |
| 每千次执行反馈率 | 日趋势和 30 日指标卡 |

数据量较小时应同时展示绝对值和分母，避免低样本百分比误导。

## 异常排查

1. 确认命令使用的是 local 还是 production。
2. 用 `SELECT 1` 验证生产查询权限。
3. 确认 `events_aggregate_insert` 触发器存在。
4. 对比 events 明细与 daily_metrics，判断是否漏装触发器。
5. 查看 `terminal_without_start`，判断 start 是否丢失。
6. 查看 Token 已知记录数，避免把未知用量误判为零。
7. 某日归零时检查业务日期、Cron 和扩展上报；`/health` 正常不代表埋点正常。

## 后续埋点补充顺序

1. `events.workflow_id`：构建同一岗位严格漏斗；
2. `ai_calls.execution_id`：关联客户端执行与模型调用；
3. `feedback.execution_id/module/mode`：精确归因反馈；
4. `bad_case_category`：结构化统计语义相同的问题；
5. 无业务正文的长期 cohort 聚合：支持超过 30 天的留存分析。

补齐前，不应把近似漏斗、总体反馈率或时间邻近的 AI 调用解释为严格因果关系。
