# Smart Travel 协作指南

本文件适用于整个 Git 仓库。这里的项目根目录是当前目录（`sites-app/`），不是它的父目录。父目录还保留一套旧 Python/静态实现和历史交接资料；除非任务明确要求，不要修改或迁移父目录内容。

## 1. 项目是什么

Smart Travel 是一个面向中国城市旅行的规划 Agent 网站。用户用自然语言描述城市、日期、人数、预算、偏好和必去地点，系统会：

1. 把需求整理成结构化旅行画像；
2. 查询天气、景点、住宿、交通、趋势和图片等外部信息；
3. 生成并校验三套差异化路线；
4. 展示来源、可信度、未知项、交通覆盖、风险和可执行时间线；
5. 把长规划任务的阶段结果保存到 D1，使刷新或短时断网后可以恢复。

这不是预置路线展示站。不能用硬编码路线、虚构事实或未经说明的估算冒充真实查询结果。

## 2. 代码在哪里

### 前端

- `app/travel/[[...tripId]]/page.tsx`：旅行工作区页面入口。
- `app/travel/[[...tripId]]/`：工作区样式与分层主题样式。
- `app/layout.tsx`、`app/globals.css`：全局页面结构、元数据和基础样式。
- `travel/TravelWorkspaceApp.tsx`：前端组合根，连接工作区状态、四阶段流程、侧边栏和最终结果页。
- `travel/components/`：需求输入、信息采集、规划进度、方案校验、地图和最终仪表盘等界面。
- `travel/hooks/`：规划生命周期、进度和恢复逻辑。
- `travel/services/planningApi.ts`：浏览器侧规划 API、轮询、阶段推进、取消、重试和重连。
- `travel/data/`、`travel/state/`：本地工作区存储和状态机。

### 后端与数据

- `worker/index.ts`：Cloudflare Worker 总入口；处理 `/api/*`，其余请求交给 Vinext。
- `worker/travel-api.ts`：旅行 API、17 阶段规划的高层编排和最终结果装配。它是兼容现有调用的后端门面，修改时必须保持范围小并补回归测试。
- `worker/providers/`：外部 provider 的 HTTP/MCP 调用、重试、缓存、健康记录和 POI 数据归一化。
- `worker/planning/`：模型规划结果归一化、缺失内容恢复、必去地点覆盖和时间线安全修复。
- `worker/workflow/`：V30 的 advance 执行预算、模型主动超时、运行遥测和 Research durable micro-checkpoint；这里的新模块必须保持 strict TypeScript。
- `worker/lib/`：Worker 侧无业务状态的通用值处理工具。
- `worker/persistence.ts`：D1 任务、阶段工件、事件、provider attempts、租约、缓存和配额。
- `drizzle/`：正式 D1 迁移。
- `db/schema.ts`：辅助类型描述；当前运行事实以迁移和 `worker/persistence.ts` 为准。
- `.openai/hosting.json`：Sites 项目与 D1 绑定。不要随意替换 `project_id` 或绑定名。

### Agent 与模型编排

- `worker/domain/model-routing.ts`：V4 Flash/V4 Pro 的任务路由、回退和熔断。
- `worker/domain/ai-throttle.ts`：同账号跨 Agent 的调用节流与有界 429 重试；D1 原子配额闸门位于 `worker/persistence.ts`。`AI_REQUEST_MIN_INTERVAL_MS` 默认 65000 毫秒，是保守设置，不是服务商公布的账号配额。
- `worker/domain/profile-extraction.ts`：确定性解析、AI 提取结果合并和字段来源。
- `worker/travel-api.ts` 中的阶段执行逻辑：需求解析、数据采集、研究、三方案生成、critic、修复、最终交通复核和编译。
- `worker/planning/planner-normalization.ts`：规划模型输出的归一化、确定性恢复、约束覆盖和时间线修复。
- `worker/providers/provider-client.ts`：模型与数据 provider 的传输、超时、有限重试、缓存和健康遥测。
- `travel/hooks/usePlanningLifecycle.ts` 与 `travel/services/planningApi.ts`：浏览器驱动 `/api/plan/advance`，并负责恢复、重试和真实服务端取消。

DeepSeek `deepseek-flash` 只用于需求提取和用户画像；旧 `deepseek-v4-flash` 仅保留兼容。V4 Pro 用于研究、增强、规划、critic、修复和解释。生产环境启用严格模型路由，不允许不同职责静默串用模型。不要重新引入已经停用的 GLM 路由。

### 算法与可靠性规则

核心算法位于 `worker/domain/`，包括：

- `planner-v4.ts`：规划合同、硬约束审计和修复；
- `route-optimizer.ts`：候选点选择、分日和路线优化；
- `preference-intelligence.ts`：偏好画像和候选匹配；
- `contract.ts`：最终三方案合同；
- `compiler.ts`、`dependency-graph.ts`、`fragility.ts`、`stress-test.ts`：可执行性、依赖、缓冲、脆弱性和情景模拟；
- `research-*`、`decision-trace.ts`、`evidence.ts`：研究预算、证据综合和决策追踪；
- `crowd-*`、`traffic-coverage.ts`：拥挤风险预测和交通核验覆盖。
- `availability.ts`、`constraint-model.ts`：日期化开放窗口与分层约束编译；
- `fact-graph.ts`、`reproducibility.ts`：统一事实图、别名/来源关系和可复现快照；
- `diversity.ts`、`robustness.ts`：多维方案差异与可重复 Monte Carlo 鲁棒性仿真；
- `model-budget.ts`、`workflow-dag.ts`：按职责限制模型输出预算，并描述逻辑依赖 DAG；
- `offline-benchmark.ts`：不依赖模型的固定场景回归基准。

自动化测试集中在 `tests/`。

## 3. 本地运行

要求 Node.js `>=22.13.0`，使用仓库现有的 npm lockfile，不要擅自更换包管理器。

```bash
npm ci
```

复制服务端环境变量模板：

```bash
cp .dev.vars.example .dev.vars
```

Windows PowerShell：

```powershell
Copy-Item .dev.vars.example .dev.vars
```

只在本地 `.dev.vars` 中填写需要的密钥。完整规划至少需要可用的 `AI_API_KEY`；地图、图片和可选趋势 provider 按任务需要配置。不要读取、打印或提交他人的本地密钥文件。

启动开发环境：

```bash
npm run dev
```

默认访问 `http://localhost:3000/travel/`。规划由页面逐阶段推进；完全关闭页面后任务会暂停，重新打开后从 D1 检查点恢复。不要把完整长任务改回 `waitUntil()`。

## 4. 常用验证命令

```bash
# 领域、合同、恢复和结构回归
npm run test:domain

# TypeScript
npm run typecheck -- --incremental false

# ESLint
npm run lint

# 生产构建
npm run build

# 当前脚本等价于 test:domain + build
npm test

# 生产规划器固定场景与架构回归
npm run benchmark:planner
```

提交到 `main` 前，至少运行 `test:domain`、`typecheck` 和 `lint`。影响 Worker、构建配置、依赖或部署产物时还必须运行 `build`。不要通过关闭规则、扩大 `any`、删除失败测试或降低合同要求来让检查通过。

## 5. 密钥与环境文件

- 绝对不能向 GitHub 提交 API key、token、Cookie、访问凭证、`.env`、`.dev.vars`、日志中的凭证或任何真实秘密。
- `.gitignore` 已忽略 `.env*`、`.dev.vars`、`*.pem`、构建输出和 Wrangler 临时文件。
- 当前 Cloudflare/Vinext 本地运行使用 `.dev.vars`，因此规范模板是已提交的 `.dev.vars.example`。
- 目前不需要额外创建 `.env.example`；它会与实际运行方式重复。只有未来代码真的读取 `.env` 时，才创建不含真实值的 `.env.example`，并同步调整忽略规则。
- 新增环境变量时，同步更新 `.dev.vars.example`、Worker 的环境类型和相关说明，但示例值只能为空值或公开的非敏感默认值。

提交前可检查：

```bash
git status --short
git diff --cached
```

如果暂存内容包含疑似秘密，立即停止提交并移除该文件；不要把秘密复制到 Issue、PR、评论或聊天记录中。

## 6. 双人协作与 `main` 直传规则

- 项目由周树铭（zsm）和好友（gmh）共同开发，两人通过错开工作时间减少冲突。
- 当前不采用功能分支审核制，也不要求先创建 PR；默认直接在 `main` 开发、提交并推送到 GitHub。
- 每次开始开发前，无论改动大小，都必须先把本地项目同步到 GitHub 最新的 `main`。不能因为两人错峰工作就跳过同步。
- 同步不得覆盖、删除、暂存或提交 `.env`、`.env.*`、`.dev.vars`、API key、token 等本地私密配置。
- 当前仓库的 GitHub remote 名为 `github`；其他克隆可能叫 `origin`，应先以 `git remote -v` 的实际结果为准，再替换下面命令中的 remote 名。

每次开发开始前执行：

```bash
git switch main
git status --short
git fetch github main
git pull --ff-only github main
```

只有工作区没有待处理改动且 `pull --ff-only` 成功后，才开始修改。如果存在未提交改动、分叉、冲突或无法快进，不要强制重置、强推或覆盖文件；停止开发并先与另一位协作者确认如何处理。

完成后：

1. 运行与改动相称的测试；
2. 检查 `git status` 和 diff，确保只有当前需求相关内容，且不含任何私密文件；
3. 提交到本地 `main`；
4. 推送前再次执行 `git fetch github main`，确认开发期间远端没有新增提交；如果远端已变化，先安全同步并解决冲突；
5. 使用 `git push github main` 直接更新主线，禁止对 `main` 使用强制推送；
6. 推送完成后告知另一位协作者，方便对方下一次开发前同步。

除非用户在当前任务中另有明确要求，站点发布应以已成功推送到 GitHub 的最新 `main` 为准。

## 7. 修改范围与现有约束

- 只修改当前需求需要的文件。不要顺手重构、升级依赖、改 UI、删除旧逻辑或替换技术方案。
- 先阅读相关代码和测试；文档与代码冲突时，以当前可验证代码为准，并在提交说明或交付说明中指出冲突。
- 保持三套稳定方案 ID 正好为 `hot`、`niche`、`relax`；每套都必须覆盖全部必去地点并严格符合支持的旅行天数。
- 用户文本中的明确约束优先于表单默认值。当前单次规划支持 1～7 天，超出范围必须明确提示，不能静默截断。
- 拥挤度只能称为预测；酒店价格是候选参考；天气窗口外保持未知；交通必须区分已核验和估算。不得伪造“实时”数据。
- 首次打开页面不能自动开始规划。
- 访问凭证只保存在 Secure、HttpOnly、SameSite=Strict Cookie 中，不得放进浏览器 JavaScript、URL 或 localStorage。
- 保持浏览器驱动的 `/api/plan/advance`、D1 检查点、租约、幂等、取消和恢复语义。长模型调用不得放进完整任务级 `waitUntil()`。
- V30 起每次 `/api/plan/advance` 只能执行一个有限时长工作单元：soft budget 40 秒、外部调用最多 30 秒、长节流等待必须写入 `retryNotBefore`。Research operation 必须先写 artifact 再推进 cursor，并通过确定性 operation ID 幂等复用。
- 模型 429/QPM 是调用限流，不是输出结构错误；必须等待、有界重试并保留检查点，不能直接宣称“两次结构失败”后降级。永久 404/鉴权失败与结构错误分别处理，持续限流应明确报错。单次连通性测试通过不代表完整规划链路通过。
- D1 结构变更必须通过 `drizzle/` 新迁移完成，并兼容已有任务；不要只改 `db/schema.ts`。
- 本地工作区存储保留现有 schema 兼容，不要随意清空用户历史。
- 除非需求明确涉及视觉设计，否则保持现有四阶段工作流、十套主题、动画加载策略和移动端布局。
- 不要删除看起来“没用”的代码、父目录旧实现或历史资料，除非任务明确列出删除目标且确认可恢复性。

当需求可能违反上述约束或需要扩大范围时，先在对话或交付说明中说明原因和影响，再等待确认。
