# 部署指南

三种方式，按你的机器挑一种。**核心版必须部署在常年开机的机器上**（VPS / NAS / 家里的小主机）。

| 方式 | 适合 | 特点 |
| --- | --- | --- |
| [A. systemd（Linux）](#a-systemdlinux推荐) | VPS、openEuler、OpenCloudOS、Debian | 最省心：崩溃自动重启 + 开机自启 + 日志进 journald |
| [B. Docker](#b-docker) | 已有 docker compose 编排习惯（NAS、群晖、HK VPS） | 隔离干净、数据用卷持久化 |
| [C. 进程守护（Windows / NAS）](#c-进程守护windows--nas) | 家里的常开 Windows 机器、群晖 | 用 nssm 或 PM2 托管 |

---

## 通用：先跑通再常驻

不管哪种方式，**先手动跑一次确认能起来**，再交给守护进程托管：

```bash
npm install
cp .env.example .env
# 编辑 .env：至少确认 PORT、BOT_TOKEN、SESSION_SECRET
npm start
```

另开一个终端验证：

```bash
curl http://127.0.0.1:9089/health
# {"status":"ok","message":"虚拟桌宠服务运行正常","version":"0.8.0",...}
```

起得来再往下走。起不来的常见原因见 [常见问题](#常见问题)。

### 模型配置放哪

`.env` 里只有**模型服务地址**（`MODEL_API_ENDPOINT`），真正的模型名和密钥存在 SQLite 的
`api_tokens` 表里 —— 一个部署可以有多个账号，各配各的。默认用 `BOT_MODEL_UID`（缺省 1）指向的内置账号。

查看当前账号有没有配好：

```bash
curl http://127.0.0.1:9089/api-token/status \
  -H "Authorization: Bearer $BUILTIN_ACCOUNT_TOKEN"
```

---

## A. systemd（Linux，推荐）

```bash
sudo ./deploy/install-service.sh
```

脚本会：建 `kirari` 用户 → 拷到 `/opt/kirari-core` → `npm ci --omit=dev` →
生成含随机密钥的 `.env`（权限 600）→ 注册并启动服务。

常用命令：

```bash
systemctl status kirari-core      # 看状态
systemctl restart kirari-core     # 重启
systemctl stop kirari-core        # 停止
journalctl -u kirari-core -f      # 实时日志
journalctl -u kirari-core -n 100  # 最近 100 行
```

升级：拉新代码后重新跑一次安装脚本即可（**`.env` 和 `data/` 不会被覆盖**）。

```bash
cd /path/to/kirari-core && git pull
sudo ./deploy/install-service.sh
```

---

## B. Docker

```bash
cp .env.example .env       # 改 BIND_ADDR / PORT / BOT_TOKEN / SESSION_SECRET
docker compose -f deploy/docker-compose.yml up -d
docker compose -f deploy/docker-compose.yml logs -f
```

**安全提醒**：服务器上建议把端口绑定改成 `127.0.0.1`（在 `.env` 里设 `BIND_ADDR=127.0.0.1`），
再由 Nginx / Caddy 反代对外并加 HTTPS。这样容器端口不直接暴露在公网，少一层被打的风险。

数据在卷 `kirari-data`（映射到容器内 `/app/data`），备份就是备份这个卷。

---

## C. 进程守护（Windows / NAS）

Windows 没有 systemd，用 nssm 把 Node 注册成系统服务：

```powershell
# 用管理员 PowerShell
nssm install KirariCore "C:\Program Files\nodejs\node.exe" "C:\kirari-core\server.js"
nssm set KirariCore AppDirectory C:\kirari-core
nssm set KirariCore AppEnvironmentExtra NODE_ENV=production
nssm set KirariCore AppStdout C:\kirari-core\logs\out.log
nssm set KirariCore AppStderr C:\kirari-core\logs\err.log
nssm set KirariCore AppRotateFiles 1
nssm set KirariCore start SERVICE_AUTO_START
nssm start KirariCore
```

不想装 nssm，也可以用 PM2（跨平台，NAS 上尤其常见）：

```bash
npm i -g pm2
pm2 start server.js --name kirari-core --cwd /volume1/kirari-core
pm2 save
pm2 startup     # 按提示执行它给出的那条命令，实现开机自启
```

---

## 接入你的机器人

服务起来后，机器人侧只要往 `POST /v1/chat` 发 HTTP 请求即可 ——
**不需要你的机器人适配本项目的任何协议**。

```bash
curl -X POST http://127.0.0.1:9089/v1/chat \
  -H "Authorization: Bearer $BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "onebot",
    "chatType": "group",
    "groupId": "87654321",
    "userId": "10001",
    "nickname": "小明",
    "content": "今天天气怎么样"
  }'
```

返回：

```json
{
  "sessionId": "bot:onebot:group:87654321",
  "speech": "主人，今天晴，24℃……",
  "emotion": "happy",
  "images": [],
  "model": "gpt-5-nano"
}
```

字段说明：

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `platform` | 否 | 平台标识，用于隔离不同平台的同号码，缺省 `default` |
| `chatType` | 否 | `group` / `private`；不传则按有没有 `groupId` 推断 |
| `groupId` | 群聊必需 | 群号 |
| `userId` | 私聊必需 | QQ 号 / 用户 id |
| `nickname` | 否 | 仅日志里方便看 |
| `content` | 与 images 至少一个 | 文本内容 |
| `images` | 否 | 图片 URL 或 base64，最多 9 张 |
| `persona` | 否 | 自定义人格，不传用预设 |
| `sessionId` | 否 | 显式指定；不传由服务端按群号/QQ 号映射 |

### 会话是怎么算的

服务端按「谁在哪个聊天里说话」生成稳定 ID，**进程重启后同一个群仍然接着上次聊**：

| 场景 | sessionId |
| --- | --- |
| 群 87654321 | `bot:onebot:group:87654321` |
| 同群换个人说话 | 同上（整群共享一份上下文） |
| 私聊 10001 | `bot:onebot:user:10001` |
| 另一个平台也用 87654321 | `bot:telegram:group:87654321`（不撞车） |

想改成「群内每人一份上下文」（多人发言时上下文不互相污染）：

```bash
BOT_GROUP_ISOLATE_PER_USER=true
```

注意：位置记忆**始终按群共享**，不受这个开关影响。

### 鉴权

`Authorization: Bearer <BOT_TOKEN>`。`BOT_TOKEN` 没配置时接口直接返回 503 并说明原因，
**不会默认放行**。生成方式：

```bash
openssl rand -hex 32
```

---

## 常见问题

**启动就退出，日志报 `Node 版本过低`**
装 Node 20 以上，建议 24。

**`systemctl` 起来了但连不上端口，日志没有输出**
大概率是 nssm/nvm 装的 Node，systemd 读不到 PATH。用绝对路径：
`ExecStart=/usr/local/bin/node server.js`，路径用 `which node` 确认。

**端口被占用**
`.env` 里改 `PORT`。注意改了之后防火墙规则也要跟着改。

**机器人回复很慢（>20 秒）**
正常。首条消息会触发「当日简报」采集（天气+新闻并让模型压缩），比较慢。
在日志里搜 `[dailyBrief]` 看是否在生成。后续当天再问就走缓存了。

**回复「模型尚未配置」**
该账号（`BOT_MODEL_UID`）还没写模型信息，用 `/api-token` 写入后再试。

**机器人「失忆」，重启后不记得之前聊过**
确认 `STORAGE_TYPE=db`（不是 memory），且数据目录有写权限。
Docker 部署要确认卷挂上了（`docker compose ... exec kirari-core ls -la /app/data`）。

**改了 `.env` 不生效**
systemd：`systemctl restart kirari-core`。Docker：容器环境变量在创建时固化，需 `up -d` 重建。
