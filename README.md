# 智能旅游助手（Sites 部署版）

面向中国城市的智能旅行决策网站。DeepSeek V4 Flash 先把自然语言需求整理成结构化约束，DeepSeek V4 Pro 再结合天气、酒店、高德地图 MCP 与受控联网核验生成三套差异化路线。

## 本地运行

```bash
npm install
npm run dev
```

生产构建：

```bash
npm run build
```

## 主要目录

- `app/travel/[[...tripId]]/`：Vinext 页面入口和分层样式。
- `travel/`：React 工作区、四阶段交互、最终仪表盘、本地历史和规划生命周期。
- `worker/domain/`：画像、模型路由、三方案合同、路线优化、证据和可靠性规则。
- `worker/travel-api.ts`：受控联网工具、MCP 调用、17 阶段规划执行器和旅行 API。
- `worker/persistence.ts`、`drizzle/`：D1 任务、阶段工件、事件、租约和正式迁移。
- `worker/index.ts`：Cloudflare Worker 入口。
- `tests/`：领域、合同、恢复和界面结构回归测试。
- `.openai/hosting.json`：Sites 项目标识与托管配置。

规划任务由页面按阶段调用 `/api/plan/advance` 推进，并把检查点保存到 D1。刷新或短时断网后可以恢复；完全关闭页面时任务暂停，不会在后台继续消耗模型额度。

## 数据边界

- 天气使用 Open-Meteo 直连，保存未来 16 天快照；超出预报窗口的日期明确标为待核验。
- 酒店仅展示酒店 MCP 实际返回的候选，不虚构房价或余房。
- 高德 MCP 用于 POI 精确图片和公交/地铁路线；共享额度不足时透明回退。
- 未接入官方来源的实时客流、景区预约等信息保持“未知”。
