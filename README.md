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

- `public/travel/`：网站页面、样式与浏览器交互。
- `worker/travel-api.ts`：DeepSeek Flash/Pro 分工、受控联网工具、MCP 调用、景点与路线数据处理。
- `worker/index.ts`：Cloudflare Worker 入口。
- `.openai/hosting.json`：Sites 项目标识与托管配置。

## 数据边界

- 天气优先使用 MCPMarket 天气查询，Open-Meteo 直连兜底。
- 酒店仅展示酒店 MCP 实际返回的候选，不虚构房价或余房。
- 高德 MCP 用于 POI 精确图片和公交/地铁路线；共享额度不足时透明回退。
- 未接入官方来源的实时客流、景区预约等信息保持“未知”。
