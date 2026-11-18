# Kirari 数据根：`~/.kirari`

> 一份规范，两个实现：核心版 `pet-api/src/kirariHome.js`、桌宠版 `akisaki-kirari/electron/kirari-home.ts`。
> 两边的 `LAYOUT` 必须逐字对齐 —— 它们是**同一份数据的两个读写端**，任何一处漂移都会造成数据分叉。

## 为什么改

以前数据散在三个地方，规则藏在若干个文件里：

| 位置 | 装什么 | 问题 |
| --- | --- | --- |
| `%APPDATA%\akisaki-kirari` | 桌宠的配置、库、皮肤、头像、日志，**外加十几个 Chromium 缓存目录** | 想备份聊天记录得先在一堆 `Cache/`、`GPUCache/` 里挑；换机器同步时缓存跟着走 |
| `<pet-api 包根>/data` | 核心版全新部署时的兜底数据 | 换个部署方式（Docker / 源码 / 打包）路径就变，用户得重新配 |
| `%APPDATA%\akisaki-kirari\knowledge.json` 等 | 零散配置与知识库 | 每个模块自己拼路径，加一个文件就多一处硬编码 |

现在是**家目录下的一个可见目录**，与 `~/.codebuddy`、`~/.claude` 这类 AI agent 的数据根同一种形态：
配置、技能、MCP、知识库、聊天库、皮肤、日志全在一处，明文可读、可直接备份、可直接手改。

## 目录结构

```
~/.kirari/
├── home.json                    目录版本 + 一次性迁移记录（程序维护，不建议手改）
├── config.json                  当前生效的模型三件套 / 搜索 / 人格 / AgentProfile —— 两端同一份
├── models.json                  模型清单（WorkBuddy 同构，可整份与别家 agent 互拷）
├── pet-client.config.json       桌宠本机配置：备注名 / 我的头像 / 适配器 / 窗口 / 主题 / 形象
├── console-appearance.json      控制台外观（仅核心版，与桌宠主题刻意分开）
├── knowledge/
│   └── knowledge.json           私人知识库（本地条目 + 远程源）
├── mcp.json                     MCP 外部工具服务（标准格式，与 Claude Code / codebuddy / WorkBuddy 同构）
├── mcp/
│   └── servers.json             旧版 MCP 配置（只读一次，迁移后改名 .bak 留档）
├── skills/
│   ├── skills.json              旧 prompt 型技能（兼容保留，两端都还能读）
│   └── <skillId>/
│       └── SKILL.md             渐进披露技能正文（YAML 头 + Markdown 正文）
├── database/
│   ├── pet_sessions.db          聊天记录 / 事件流 / 任务 / 计划任务（同库）
│   ├── pet_sessions.db-wal
│   └── pet_sessions.db-shm
├── sessions/
│   └── local-session.json       本机会话 id（两端共用一段主对话）
├── network/
│   ├── net-state.json           组网状态（角色 / 配对 / 主机地址）
│   └── net-identity.json        组网设备身份（设备 id / 名称）
├── avatars/                     皮肤（官方皮肤 + 用户自定义，每个皮肤一个目录）
│   └── kirari/
│       ├── frames.json          帧定义
│       └── *.png                帧图片
├── user-avatar/                 「我的头像」上传文件
├── logs/
│   └── app-YYYY-MM-DD.log       运行日志（两端同目录，排障不用两头找）
└── backups/
    └── migration-<时间戳>.json  一次性迁移的明细快照（复制了什么、跳过了什么）
```

## 与其他 AI agent 的格式兼容

目标：**同一个 MCP、同一个技能、同一份模型清单，在 Kirari 和别的 agent 之间直接拷来就能用。**
所以这三个文件采用业界事实标准，而不是自创格式。

### `mcp.json` —— 标准 MCP 配置

```json
{
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"], "env": {} },
    "remote":     { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer xxx" } },
    "off":        { "command": "some-server", "disabled": true }
  }
}
```

- 键名即 server id：`mcpServers` 的键就是唯一标识，两家互换后名字不变，可对得上。
- 无 `transport` 字段：有 `command` 就是 stdio，有 `url` 就是 http（两者都有时以 `url` 为准，远程优先）。
- `disabled: true`（WorkBuddy 写法）与内部 `enabled: false` 双向映射。
- 未知字段（各家私有键如 `timeout`）**原样保留**，写回时不丢。
- 转换只在文件边界发生一次，实现真源：核心版 `src/mcp/standardMcp.js`、桌宠版 `electron/mcp/standardMcp.ts`。

旧格式 `mcp/servers.json`（裸数组）首次启动自动并入 `mcp.json`，只补不覆盖，随后改名 `.migrated-<时间戳>.bak`。

### `models.json` —— 模型清单（WorkBuddy 同构）

```json
[
  {
    "id": "deepseek-chat",
    "name": "便宜快档",
    "vendor": "Custom",
    "url": "https://api.example.com/v1",
    "apiKey": "sk-…",
    "supportsToolCall": true,
    "supportsImages": false,
    "supportsReasoning": false,
    "profileId": 1
  }
]
```

| WorkBuddy 字段 | Kirari 内部字段 | 说明 |
| --- | --- | --- |
| `id` | `model` | 真实发给 API 的型号名 |
| `url` | `endpoint` | 服务地址 |
| `apiKey` | `key` | 密钥 |
| `name` | `name` | 界面显示名 |
| `profileId` | `id` | Kirari 内部主键（数字），别家忽略即可 |

`vendor` / `supports*` / `reasoning` / `useCustomProtocol` 原样保留但不解释。
`config.json` 只留「当前生效的三件套 + `activeModelId`」，清单彻底搬走 —— 旧的
`config.json.models[]` 会在首次启动时自动迁移，并从 `config.json` 删除该键。

### `skills/<id>/SKILL.md` —— Agent Skills 标准

YAML frontmatter + Markdown 正文，`name` + `description` 必备。解析器支持真实世界用到的
YAML 子集：引号标量、折叠块 `>`、字面块 `|`、跨行普通标量、块序列、任意深度嵌套元数据、
行内 `tags: a, b`。实测本机 389 个真实技能（Claude Code / codebuddy / WorkBuddy / Trae）
解析通过率 **97%**（剩余失败均为文件确实缺 `description` 或根本没有 frontmatter）。
只写 `description` 不写 `name` 时，以技能目录名兜底（与 Claude Code 行为一致）。

进 system 的只有 `- <name>: <描述前 160 字>` 一行；正文由模型按需 `load_skill` 加载。

### 为什么缓存不在这里

Electron 默认把两类完全不同的东西塞进同一个 `userData`：

1. **Chromium 运行时缓存** —— `Cache/`、`GPUCache/`、`Code Cache/`、`Local Storage/`、`Network/`、`blob_storage/`、`Dictionaries/`、`Dawn*Cache/`、`Shared Dictionary/`、`SharedStorage`、`Preferences`、`Local State`、`DIPS`
2. **用户真正在乎的数据** —— 配置、聊天库、技能、皮肤、头像

所以桌宠版把两者拆开（`electron/main.ts` 顶部、`ready` 之前）：

```ts
app.setPath("userData", "~/.kirari");                            // 数据
app.setPath("sessionData", "%APPDATA%\\akisaki-kirari\\chromium"); // 纯缓存
```

`sessionData` 是 Electron 专门为「不该跟着用户数据走的东西」提供的路径，**必须一起改**，
否则 Chromium 会继续往 `~/.kirari` 里写十几个机器命名的目录，家目录就没法看了。

## 路径解析优先级

从高到低，命中即停：

| 优先级 | 来源 | 用途 |
| --- | --- | --- |
| 1 | `KIRARI_HOME` | 显式指定整个数据根：测试、便携版、多开 |
| 2 | `PET_API_DATA_DIR` | **旧变量，语义降级**：不再是「探测桌宠版 userData」，而是「数据根换位置」 |
| 3 | `KIRARI_DESKTOP_DATA_DIR` | 同上，旧变量降级 |
| 4 | `~/.kirari` | 默认 |

保留 2、3 是因为 Docker 部署和既有脚本在用；直接删会让线上部署静默改路径。

桌宠版额外的求值分支：当 1–3 都未设置时，`kirariHome()` 会回落到当前 Electron 的
`app.getPath("userData")`。这不是产品逻辑，而是让**单测能把 `electron` mock 成临时目录**，
用例写在沙箱里而不是用户真实家目录（见 `electron/model-config.spec.ts`）。

## 一次性迁移

首次启动时，若 `~/.kirari/home.json` 里没有 `migration.at`，程序会把旧位置的已知数据**复制**进来：

| 旧位置 | 新位置 |
| --- | --- |
| `<旧根>/config.json` | `config.json` |
| `<旧根>/pet-client.config.json` | `pet-client.config.json` |
| `<旧根>/console-appearance.json` | `console-appearance.json` |
| `<旧根>/knowledge.json` | `knowledge/knowledge.json` |
| `<旧根>/mcp-servers.json` | `mcp/servers.json`（再由 `mcp.json` 迁移逻辑转入标准格式） |
| `<旧根>/skills.json` | `skills/skills.json` |
| `<旧根>/local-session.json` | `sessions/local-session.json` |
| `<旧根>/net-{state,identity}.json` | `network/net-{state,identity}.json` |
| `<旧根>/pet_sessions.db{,-wal,-shm}` | `database/pet_sessions.db{,-wal,-shm}` |
| `<旧根>/skills/**` | `skills/**` |
| `<旧根>/avatars/**` | `avatars/**` |
| `<旧根>/user-avatar/**` | `user-avatar/**` |
| `<旧根>/logs/**` | `logs/**` |
| `<旧根>/chat-session*.json`、`kirari.db`、`adapter.json` | **保持在根目录**（见下） |

> 旧位置候选（按顺序取第一个非空的）：`%APPDATA%\akisaki-kirari`（Windows）、
> `~/Library/Application Support/akisaki-kirari`（macOS）、`~/.akisaki-kirari`、`<pet-api>/data`。

### 三条硬约束

1. **只复制，绝不移动/删除。** 用户的原目录一个字节都不动，出问题能立刻回退。
2. **目标已存在的文件跳过，不覆盖。** 用户可能已经在新位置手改过，覆盖 = 删他的数据。
3. **幂等判据是 `home.json` 里的迁移记录，不是「目标目录空不空」。** 否则用户手动删掉某个
   文件后，下次启动会被整体重搬一遍。

### 为什么 `chat-session*.json` / `kirari.db` / `adapter.json` 留在根目录

它们不是「当前数据」，而是**待迁移的遗留物**，由三个迁移器从数据根**根目录**按文件名读取：

| 文件 | 迁移器 | 去向 |
| --- | --- | --- |
| `chat-session*.json` | `electron/ai/migrate/legacy-chat.ts` | 解析后写入 `messages` 表，**成功后删除源文件** |
| `kirari.db` | `electron/ai/migrate/legacy-db.ts` | 旧库数据并入 `pet_sessions.db`，**成功后删除源文件** |
| `adapter.json` | `core/src/settings/clientConfig.js` | 并入 `pet-client.config.json`，源文件改名留档 |

把这三类搬进子目录会让那三条迁移链直接断掉，所以数据根的根目录会**短暂**保留它们。
等迁移器消费完，它们会自己消失（或被改名成 `.bak`）。

## 两个实现之间的分工

| | 核心版 `kirariHome.js` | 桌宠版 `kirari-home.ts` |
| --- | --- | --- |
| `LAYOUT` 常量 | ✅ 真源 | ✅ 同构副本 |
| `resolveHome()` | ✅ | ✅ 同一套优先级 |
| `ensureLayout()` | ✅ | ✅ |
| `migrateLegacy()` | ✅ 启动即迁移 | ✅ `ready` 后迁移 |
| `setHomeRoot()` | — | ✅ 在 `ready` 之前登记，压住「模块顶层求值」问题 |

**为什么要 `setHomeRoot()`**：ESM 的 `import` 早于 `main.ts` 模块体执行。`main.ts` 里任何
模块级常量（`MCP_CONFIG_PATH`、`SKILLS_CONFIG_PATH`、皮肤目录……）如果在顶层调 `homePath()`，
就会在 `setHomeRoot()` 之前求值，绑定到 Electron 默认的旧 `userData` —— 结果就是「配置写新根、
读旧根」，这是最难查的一类 bug。因此：

- `main.ts` 把数据根初始化放在**所有 import 之后、其他模块级常量之前**；
- 跨模块会被提前 import 的路径（如 `model-config.ts` 的 config 路径）改成**调用时求值**，不存常量。

## 排错

| 想知道 | 看哪里 |
| --- | --- |
| 这次读的是哪份数据、从哪来 | 核心版启动日志 `[data-dir] 数据根 = …（来源：…）` |
| 迁移搬了什么 | `~/.kirari/home.json` → `migration.copiedCount`；明细在 `~/.kirari/backups/migration-*.json` |
| 每个文件的确切位置 | 核心版 `GET /api/data-info`（需 `x-admin-token`），返回 `layout` 全量路径 + `migration` |
| 桌宠端是否也对上了 | 启动日志 `[home] 数据根 = …` / `[home] 缓存目录 = …` |
| 日志 | `~/.kirari/logs/app-YYYY-MM-DD.log` |

## 加新文件时

1. 先在 `kirariHome.js` 的 `LAYOUT` 里登记相对路径（**唯一真源**）；
2. 在 `kirari-home.ts` 的 `LAYOUT` 里加同名同值的条目；
3. 如果是目录，加进 `DIR_KEYS`；
4. 调用方用 `paths.<key>` / `homePath("<key>")`，**不要再往数据根上拼字符串**；
5. 跑 `node scripts/check-home-layout.js` 确认两端没漂移。

`core/src/settings/localSettings.js` 已经做了逻辑名 → 绝对路径的翻译层
（`readJson("knowledge")` / `writeJsonMerged("consoleAppearance", …)`），
新的 JSON 设置文件走它即可，不必自己拼路径。

### 跨 agent 兼容文件的三条铁律

改 `mcp.json` / `models.json` / `SKILL.md` 相关代码时：

1. **格式以别家为准，不为内部方便改文件结构。** 内部要 id、要 transport、要数字主键，
   都在边界转换层消化，别让这些私有概念漏进文件。
2. **读的时候不能静默当作空。** 文件坏了必须显式抛错/报日志 —— 静默空会让用户下一次
   保存把整个配置覆盖掉，等于删了他的配置。
3. **写的时候保留未知字段。** 用户（或别家 agent）手写的私有键必须原样带回去，
   否则一次保存就把人家配置吃掉了。
