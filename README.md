# RoleMI Backend v3.0.0

RoleMI 浏览器扩展的 Cloudflare Worker 后端，提供托管 AI、使用事件统计和用户反馈接口。

生产地址、账号、数据库标识、扩展 ID、发布步骤和验收记录不在公开 README 中披露。

## 能力与数据边界

- **托管 AI**：校验请求，由服务端固定模型和密钥，限制输入与各模块输出预算，预占调用额度，再转发到兼容 Responses API 的模型服务。
- **使用事件**：接收匿名安装标识、执行标识、模块、事件状态和业务日期；去重后由 D1 触发器维护累计安装量、日活安装量和每日模块汇总。
- **用户反馈**：保存用户主动提交的反馈；关联岗位时可以同时保存岗位标题、JD 和已生成的工作流结果快照。
- **基础能力**：路由、CORS、请求体限长、健康检查，以及每天清理 30 天前的 AI 调用、事件和额度明细。

AI 调用指标和使用事件不保存提示词、简历、JD 或模型输出正文。`feedback` 表不同：它可能包含反馈正文、JD 和 AI 输出，但不接收简历原文或附件；定时任务对普通指标保留 30 天，对反馈保留 180 天。`installation_id` 是安装实例标识，不代表自然人或下载量。

代码入口是 `src/index.js`，AI、事件、反馈和额度逻辑分别位于 `src/ai-gateway.js`、`src/events.js`、`src/feedback.js` 和 `src/quota.js`；D1 建表、聚合触发器与报表位于 `sql/`。

## 环境

项目使用一套业务代码、两套运行环境：本地开发使用本机 Worker + 本地 D1 + `.dev.vars`；生产使用 Cloudflare Worker + 远程 D1 + Worker Secret。

| 环境 | Worker | D1 | 密钥 |
| --- | --- | --- | --- |
| Local | `wrangler dev --local` | `.wrangler/state` | `.dev.vars` |
| Production | Cloudflare Worker | 远程 D1 | Worker Secret |

## 本地启动

需要 Node.js、npm、Cloudflare Wrangler，以及一个兼容 Responses API 的上游模型服务。

```bash
npm ci
test -f .dev.vars || cp .dev.vars.example .dev.vars
# 编辑 .dev.vars，填写 AI_API_KEY；已有文件请保留，不要覆盖。
# 同时确认 wrangler.jsonc 中的 AI_API_URL 和 AI_MODEL 与密钥对应。
npx wrangler d1 execute rolemi-metrics --local --file=sql/schema.sql
npx wrangler d1 execute rolemi-metrics --local --file=sql/event-aggregates.sql
npm run dev:local
```

访问 `http://localhost:8787/health` 应返回：

```json
{ "name": "RoleMI Backend", "status": "ok" }
```

健康检查只说明 Worker 可访问，不检查 D1、密钥或上游模型。仓库不包含真实密钥，因此不能开箱完成真实 AI 推理。事件聚合依赖 `sql/event-aggregates.sql` 中的触发器，不可漏装。

已有数据库升级到本版本时执行一次 `sql/event-mode.sql`，将历史事件标记为 `unknown`；不要对全新库或已升级数据库重复执行。更早的旧两表数据库需先执行 `sql/metrics-v2.sql`，最后确认已安装 `sql/event-aggregates.sql`。

## 运行配置

非密钥配置位于 `wrangler.jsonc`，本地密钥放在不提交的 `.dev.vars` 中。可用的额度变量如下：

| 变量 | 代码默认值 | `.dev.vars.example` | 含义 |
| --- | ---: | ---: | --- |
| `AI_QUOTA_DISABLED` | `true` | `true` | `true` 跳过次数限制；仍记录调用尝试 |
| `AI_INSTALLATION_DAILY_LIMIT` | `20` | `20` | 单安装实例每日上限（UTC 日） |
| `AI_INSTALLATION_MINUTE_LIMIT` | `6` | `6` | 单安装实例最近 60 秒上限 |
| `AI_GLOBAL_DAILY_LIMIT` | `200` | `200` | 所有安装实例共享的每日上限 |

运行时环境变量优先于代码默认值。三个限额跨所有 AI 模块共享；无效、空值或非正整数会回退到代码默认值。额度在调用上游前按“尝试”预占，上游失败不退还。安装实例数量不限；这里限制的是每个实例及全局的 AI 调用次数，不限制扩展安装或激活数量。

各模块最大输出 Token：`deep_analysis` 5000、`resume_profile` 4000、`resume_match` 6000、`resume_revision` 8000、`greeting` 3200、`settings_test` 40。客户端可以请求更小值，不能提高上限。AI 请求体上限为 100 KiB，所识别文本合计最多 24,000 个 Unicode 码点，上游超时为 120 秒。

## HTTP 接口

| 路径 | 方法 | 请求体上限 | 说明 |
| --- | --- | ---: | --- |
| `/`、`/health` | 任意（通常为 `GET`） | — | Worker 健康状态 |
| `/api/ai` | `POST` | 100 KiB | 托管 Responses API 调用 |
| `/api/events` | `POST` | 64 KiB | 1–40 条匿名使用事件 |
| `/api/feedback` | `POST` | 512 KiB | 用户反馈及可选岗位快照 |

AI 请求外层包含 UUID v4 格式的 `installation_id`、受支持的 `module` 和 `request`。服务端忽略客户端模型值并强制 `stream: false`、`store: false`；不支持的上游参数会返回 `invalid_request`。

事件只允许 `installation_id`、`execution_id`、`module`、`mode`、`event`、`date` 六个字段。新事件的 `mode` 为 `hosted` 或 `custom`；历史迁移数据在库内标记为 `unknown`。`event` 为 `start`、`success` 或 `failed`，日期允许七天内补报及最多未来一天；整批中任一项无效会拒绝整批。重发和冲突事件会静默忽略。

反馈类型为 `function_error`、`analysis_inaccurate`、`suggestion` 或 `other`。反馈正文必填；只有提供 `job_id` 时才能携带岗位和工作流快照。

CORS 始终允许无 `Origin` 的服务端请求；本地环境还允许扩展来源、`null`、localhost 和 127.0.0.1，生产环境只允许 `ALLOWED_EXTENSION_ORIGINS` 中明确配置的扩展 Origin。CORS 不是身份认证；公网部署前仍应结合实际威胁模型评估认证或边缘访问控制。当前代码没有公开的统计或反馈查询 API。

## 验证

```bash
# 完整测试；需要相邻目录 ../RoleMI-RELEASE，供契约测试导入真实客户端代码
npm test

# 仅验证后端，不依赖相邻的扩展仓库
npx vitest run test/index.spec.js
```

测试使用模拟模型响应，不会发起真实模型调用。`npm test` 与 `npm run test:worker` 当前执行同一套 Vitest 配置。当前完整测试基线为 21 项：19 项 Worker/D1 回归和 2 项跨仓库客户端契约测试。

## 维护查询

```bash
npx wrangler d1 execute rolemi-metrics --local --command="SELECT * FROM ai_calls ORDER BY id DESC LIMIT 20;"
npx wrangler d1 execute rolemi-metrics --local --command="SELECT name FROM sqlite_master WHERE type='table';"
npx wrangler d1 execute rolemi-metrics --local --file=sql/report.sql
```

以上命令默认查询本地 D1。生产查询必须显式同时使用 `--remote --env production`，并在执行写操作前确认目标 Cloudflare 账号和数据库。
