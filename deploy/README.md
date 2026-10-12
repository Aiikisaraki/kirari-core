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

### 目录布局（先看这个）

本仓库的 `package.json` 依赖 `file:../kirari-net` —— 组网层，一个与它**平级**的独立包。
所以两者必须放在同一个父目录里：

```
kirari/
├── kirari-core/     ← 本仓库
└── kirari-net/      ← 组网层（必须存在，且已构建出 dist/）
```

组网层运行期只用它自己的 `dist`，从 git 拉下来后先构建一次：

```bash
cd ../kirari-net && npm install && npm run build
```

⚠️ 少了这一步会很难查：`npm ci` 对 `file:` 依赖**不校验目标是否存在**，只会在
`node_modules` 里留一个悬空软链 —— 安装日志一路正常，服务启动时才
`MODULE_NOT_FOUND: kirari-net`。（`deploy/install-service.sh` 会自动补齐这两步。）

### 模型配置放哪

模型配置的唯一入口是控制台（首页 `/`）的「大脑」页：可添加多套「服务地址 + 型号 + 钥匙」并选择当前使用，
存 `data/config.json`（与桌面端同构，可互相拷贝迁移）。`.env` 不提供任何模型配置
（老写法 `MODEL_ENDPOINT` / `MODEL_API_ENDPOINT` 已删除）。
机器人默认读 `BOT_MODEL_UID`（缺省 1）指向的账号。

查看当前账号有没有配好（密钥只回掩码）：

```bash
curl http://127.0.0.1:9089/api/profile \
  -H "X-Builtin-Token: $BUILTIN_ACCOUNT_TOKEN"
```

---

## 网页控制台

浏览器打开 `http://<服务器>:9089/` 就是控制台（`/console/` 这个老地址也还能用），
输入 `.env` 里的 `ADMIN_PASSWORD` 就能进。两个页面：

- **聊天** — 直接和机器人对话（SSE，支持贴图）。这段对话就是**本机会话**
  （`data/local-session.json`）：同一台机器上的桌宠版是同一段，在哪边聊都算数
- **设置** — 外观、备注名、我的头像、人格、大脑（服务地址 / 型号 / 钥匙）、技能、
  知识库、工具服务（MCP）、机器人（OneBot 适配器）、组网。
  保存后下一条消息立即生效

鉴权是**单一管理口令**：所有 `/api/*` 都要求请求头
`X-Admin-Token: <ADMIN_PASSWORD>`。`.env` 里没配 `ADMIN_PASSWORD` 时控制台整体禁用
（接口返回 503 并说明），**不会**默认放行 —— 能改大脑配置的页面不该裸奔。

注册登录已整体下线：管理面只有这一个口令，机器人接入仍走 `BOT_TOKEN`。

构建：控制台源码在 `web/`，产物是 `web/dist/`（服务启动时检测到才启用，
没构建过则首页回落成一行服务状态字）。产物用**相对路径**（vite `base: "./"`），
所以挂在 `/` 和 `/console/` 下都能正常加载资源。

```bash
cd web && npm install && npm run build   # 本地或服务器上构建都行
```

`deploy/install-service.sh` 会优先带走源目录里已构建好的 `web/dist`，
没有就在服务器上现构建一次；Docker 构建则在镜像里自动完成（`webbuild` 阶段）。

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
# 先构建组网层（Docker 构建只取它的 dist，不会替它编译）
cd ../kirari-net && npm install && npm run build && cd -

cp .env.example .env       # 改 BIND_ADDR / PORT / BOT_TOKEN / SESSION_SECRET
docker compose -f deploy/docker-compose.yml up -d
docker compose -f deploy/docker-compose.yml logs -f
```

镜像构建需要 `../kirari-net` 参与（compose 里用 `additional_contexts` 挂进去，
需要 Compose 2.17+ / BuildKit）。版本较老、不认识这个字段时的替代做法 ——
用 `docker buildx` 的等价命令行参数，不经过 compose：

```bash
docker buildx build \
  --build-context kirari_net=../kirari-net \
  -f deploy/Dockerfile -t kirari-core:0.8.0 ..
```

**安全提醒**：服务器上建议把端口绑定改成 `127.0.0.1`（在 `.env` 里设 `BIND_ADDR=127.0.0.1`），
再由 Nginx / Caddy 反代对外并加 HTTPS。这样容器端口不直接暴露在公网，少一层被打的风险。

数据在卷 `kirari-data`（映射到容器内 `/app/data`），备份就是备份这个卷。
组网状态（凭据、配对码）也在里面（`/app/data/net`）。

**容器里当组网主机**：需要额外做两件事，否则对方拿到连接码也连不上 ——
把 19760 映射出去（compose 里那段默认是注释掉的），并且设
`NET_ADVERTISE_HOST=<宿主机局域网 IP>`（不设的话连接码里写的是容器内网地址）。

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

## 组网（可选）

让多台设备共用一个「大脑」：**只有主机需要配模型 Key**，其他设备把请求上行给它，
主机统一调模型，回复再广播回全网（活锁模型：全网只有一个出口、一份回复）。
不开组网时行为与以前完全一样。

角色由 `.env` 的 `NET_ROLE` 决定：

| 值 | 含义 |
| --- | --- |
| `off`（默认） | 不参与组网 |
| `host` | 当主机：模型出口，其他设备连它（7×24 常开的机器推荐这个） |
| `leaf` | 当叶子：请求上行给主机，本机不需要配 Key |

### 没有密钥要配

两端在网络里的地位完全一样，**谁也不带密钥出厂**，所以 `.env` 里没有组网密钥这一项：

| 角色 | 密钥从哪来 |
| --- | --- |
| 当主机 | 第一次启动时自己签一把，只存在本机（`data/net/net-state.json`，权限 600） |
| 当叶子 | 贴一张主机给的连接码，密钥在配对那一刻领到 |

于是同一个镜像发给不同的人，是互不相通、也互不可见的若干张网。
（历史变量 `KIRARI_NET_SECRET` 已删除，写了也没用。）

密钥只用于派生会话密钥（各端拿**自己手上那把** + 主机的 salt 算出来），**本身不上网络**；
握手之后的帧全部加密（AES-256-GCM + 防重放）。局域网里扫端口的人连不上，
拿到安装包解包 JS 的人也拿不到 —— 安装包里没有密钥。

### 当主机

```bash
NET_ROLE=host
NET_ADVERTISE_HOST=192.168.57.169   # 见下方说明，多网卡/容器部署必填
NET_PRINT_PAIRING=1                 # 需要连接码时打开（会打进日志）
```

1. 放行局域网端口 **19760**（组网固定端口，别暴露到公网）：
   ```bash
   sudo firewall-cmd --permanent --add-port=19760/tcp && sudo firewall-cmd --reload
   ```
2. 重启服务，日志里会打印一个一次性连接码（默认 7 天有效、用一次即失效）：
   ```
   🔑 [net] 已签发一次性连接码：kirari://join?d=xxxxx
   ```
   对方那边**不需要配任何密钥**，整串粘进「组网 → 接入别人的主机」即可。
3. 不想要就把它作废；连接码等同于密码，`NET_PRINT_PAIRING` 默认关闭。

**`NET_ADVERTISE_HOST` 是什么**：连接码里要写「对方用哪个地址连你」。
不填时自动猜（取第一个 `192.168` / `10.` / `172.16-31.` 网段的地址），
两种情况必须手动指定：

- **容器部署**：不指定会写容器内网地址（`172.x`），对方拿到码也连不上；
- **多网卡机器**：自动猜的那张未必是别人能访问到的那张。

### 当叶子

首次接入填一次主机给的连接码：

```bash
NET_ROLE=leaf
NET_PAIRING_CODE=kirari://join?d=xxxxx
```

接入成功后凭据会存进状态目录（默认 `data/net/`），**这行就可以删掉**了：
之后每次开机都按凭据自动重连，不用重新配对。

> `NET_STATE_DIR` 指向的那个目录一定要持久化（容器里挂卷、系统部署别删）——
> 里面有凭据，**也有本机自己的密钥**，丢了就得重新配对。

叶子端**本地不再调模型**，所以这台机器可以不配模型 Key；请求会带着
`net:<本机设备号>:<会话>` 的命名空间上行，主机那边按设备隔离上下文 ——
不同设备的对话脉络互不串味。组网断掉会回退到本机独立处理（本机没配 Key 时会提示去配置），
不会让机器人变砖。

### Windows / NAS

不给 `NET_ROLE` 就是 `off`，行为与升级前一致。要参与组网时在 `.env` 里加
`NET_ROLE` 即可；nssm 用户注意 `AppEnvironmentExtra` 里也要加上它。

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
去控制台（首页 `/`）的「大脑」页把模型信息配好（多套也行，选一套当前使用）再试。
配置齐全后左下角状态会变成「大脑已就绪」。

**机器人「失忆」，重启后不记得之前聊过**
确认 `STORAGE_TYPE=db`（不是 memory），且数据目录有写权限。
Docker 部署要确认卷挂上了（`docker compose ... exec kirari-core ls -la /app/data`）。

聊天记录按**会话 id**分区，本机会话 id 固定存在数据目录的 `local-session.json` 里。
如果这个 id 每次启动都变（历史上发生过：桌宠版把 id 只放在内存里），
旧的对话就变成没人认领的孤儿 —— 表现就是「明明聊过，界面却是空的」。
现在两端都从这个文件取同一个 id，并且启动时会把库里散落的早期会话**并进来**，
已经产生过碎片的旧数据会被自动修好。机器人会话 `bot-*` 不参与合并。

**改了 `.env` 不生效**
systemd：`systemctl restart kirari-core`。Docker：容器环境变量在创建时固化，需 `up -d` 重建。

**设了 `NET_ROLE` 但组网没起来**
先看启动日志里返回的 `reason`：

- `host-start-failed` → 端口 19760 被占用（`ss -lntp | grep 19760`）。
  **不会再出现「没配密钥」这一类失败了** —— 两端都不预置密钥，
  当主机时本机自己签一把，当叶子时凭连接码去领。
- `no-credential` → 叶子还没接入过：填一次 `NET_PAIRING_CODE=<主机给的连接码>`。
- `follow-failed` → 连接码对不上（用过了 / 已撤销 / 过期 / 地址不通）。

**服务启动时报 `Cannot find module 'kirari-net'`**
组网层没就位。确认 `kirari-net` 与 `kirari-core` 平级、且已 `npm run build`
（详见上面的「目录布局」）。用 `deploy/install-service.sh` 装的话它会自动处理。

**叶子端连上了，但发消息没有回复（或等很久才回）**
先看**主机**日志里有没有 `[relay] 已受理`：

- 有 → 请求到主机了，问题在主机那边的模型配置；
- 没有 → 帧没到主机。按顺序查：主机是否正在监听 19760
  （`ss -lntp | grep 19760`）、防火墙是否放行、`NET_ADVERTISE_HOST` 填的地址
  对方是否真能访问到。

组网端口是 **TCP** 19760，`firewall-cmd --add-port=19760/tcp`；只放行 UDP 是没用的。

**叶子重启后就再也上行不通了**
已修复（主机侧重放窗口原本按设备复用、叶子重连后序号从 0 重来，第一帧就被当重放丢掉，
表现为「显示已连上、发什么都不回」）。若在旧版本上遇到：
升级到含该修复的版本即可，组网代码在 `kirari-net` 包里。
