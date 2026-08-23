<p align="center">
  <img src="./assets/kirari-banner.jpg" alt="Kirari" width="720">
</p>

# Kirari Core · 虚拟桌宠后端服务

Kirari绮莉 的 WebSocket + REST 后端，负责大模型对话、记忆持久化、位置与天气/时间工具调用，以及账户与模型配置管理。

## 特性

- **WebSocket 主通道**：实时双向通信，支持文本与图片消息。
- **大模型驱动**：兼容任意 OpenAI 协议端点，可自由切换模型与 API 地址。
- **记忆持久化**：SQLite 保存对话上下文与用户信息。
- **位置感知**：用户可在对话中设置所在城市，自动用于天气、时间查询。
- **工具调用**：内置时间、天气、联网搜索、AI 生图等实时工具，结果经大模型润色后自然回复。
- **知识库**：内置免注册知识源（萌娘百科、PubChem、PubMed、MusicBrainz）+ 用户私人知识库。
- **账户体系**：本地内置账户（`X-Builtin-Token`）+ 服务端账号密码登录。

## 快速开始

```bash
npm install
npm start          # 默认监听 9089 端口（.env 可改）
```

服务启动后，前端或 `wscat` 即可连接 `ws://localhost:9089/ws`。

## 接口文档

详见 [`PORTREADME.md`](./PORTREADME.md)（WebSocket / REST 接口完整规范）。

## 关联项目

- **[kirari-desktop](https://github.com/Aiikisaraki/kirari-desktop)（桌面客户端）**：Electron + Vue 3 应用，作为本地子进程启动本服务（默认 `ws://localhost:9089/ws`），或对接独立部署的本服务。客户端亦通过 WS 工具桥接（工具名前缀 `frontend__`）将本地 MCP/skill 工具回调解本服务执行。
- **OpenAI 兼容大模型服务**：内置默认端点 `https://api.chatanywhere.tech/v1`（ChatAnywhere）；本地 `.env` 中的 `MODEL_API_ENDPOINT` 可覆盖该默认值，亦可在用户配置中切换为智谱 GLM / 通义千问 / DeepSeek 等任意兼容端点。

## 引用的 API 与外部数据服务

本服务在工具层（`src/tools`）与知识源（`src/knowledge`）中调用以下公开、多为免密钥的数据/服务。它们仅作为**可配置数据源**引用，不内置任何专有内容。

| 用途 | 服务 / 端点 | 密钥 |
| ---- | ----------- | ---- |
| 大模型对话（OpenAI 兼容） | 内置默认 `https://api.chatanywhere.tech/v1`（ChatAnywhere），本地 `.env` 可覆盖 | 用户 Key |
| 天气 / 地理编码 | [Open-Meteo](https://open-meteo.com)（`api.open-meteo.com`、`geocoding-api.open-meteo.com`） | 免密钥 |
| 联网搜索（默认源） | [UAPI](https://uapis.cn)（`uapis.cn/api/v1/search/aggregate`）聚合搜索 | 可选令牌，无则匿名 |
| 联网搜索（可选） | [Tavily](https://tavily.com)（`api.tavily.com`） | 用户 Key |
| 联网搜索（可选） | [SearXNG](https://searxng.org) 自建实例 | 自建，免密钥 |
| 知识源：ACGN | [萌娘百科](https://zh.moegirl.org.cn)（MediaWiki API） | 免密钥 |
| 知识源：化学 | [PubChem](https://pubchem.ncbi.nlm.nih.gov)（NCBI） | 免密钥 |
| 知识源：医学 | [PubMed](https://pubmed.ncbi.nlm.nih.gov)（NCBI E-utilities） | 免密钥 |
| 知识源：音乐 | [MusicBrainz](https://musicbrainz.org) | 免密钥 |
| IP 归属地 | [ipapi.co](https://ipapi.co) | 免密钥 |
| AI 生图 | OpenAI 兼容 `images.generate`（如 DALL·E，随用户端点） | 用户 Key |

> 使用上述第三方服务须遵守各自的服务条款；相关密钥由使用者自行提供并承担合规责任（含速率限制、区域可用性等）。

## 主要第三方依赖

运行时：`express`、`ws`、`better-sqlite3`、`sqlite3`、`openai`、`bcryptjs`、`dotenv`、`sharp`。
开发：`nodemon`、`concurrently`。

以上依赖各自沿用其原始开源许可证（多为 MIT / ISC / Apache-2.0），通过 npm 安装，其许可证随包提供，使用即视为接受其条款。

## 许可证与资源版权

- **代码**：本项目以 **MIT 许可证** 发布，详见仓库根目录 [`LICENSE`](./LICENSE)。
- **第三方依赖**：运行时与构建依赖各自沿用其原始开源许可证（见上方「主要第三方依赖」），通过 npm 安装，其许可证随包提供。
- **形象与视觉素材（AI 生成 + 人工设计）**：`assets/kirari-banner.jpg` 等角色形象由作者通过 AI 生成并结合人工设计、调校而成。关于 AI 生成内容的著作权，各地法律认定不一（部分地区要求具备人类创造性贡献方可构成作品）；作者就其中的人工设计、编排与后期处理主张权利，并在法律允许范围内按 MIT 许可证授权。如你另行分发这些素材，请留意 AI 生成内容的权属可能与代码不同，并自行留存生成过程记录。
- **外部服务**：本项目仅把第三方 API 作为可配置数据源引用，不内置其专有内容；使用须遵守各自服务条款，密钥由使用者自行提供并承担合规责任。

## 关联项目

- 桌面客户端（Electron + Vue 3）：[`Aiikisaraki/kirari-desktop`](https://github.com/Aiikisaraki/kirari-desktop)

---

> 🤖 **本项目由 AI 辅助创建并持续维护**。核心代码、架构设计与日常迭代均在 AI 协作下完成，欢迎反馈与共建。
