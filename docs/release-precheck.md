# 发版前预检流程

> 为什么要有这一步：CI 构建绿灯 ≠ 镜像能跑。

## 历史踩坑（都是「构建通过、运行即崩」）

| 坑 | CI 表现 | 实际后果 |
| --- | --- | --- |
| require 相对路径少一层 | 绿灯（COPY 不校验 require） | 容器重启循环 |
| Dockerfile COPY 了上下文外文件 | 构建失败但缓存层掩盖 | 推上去的镜像是旧的 |
| 前端组件未挂载 | 构建绿灯 | 设置页空白 |
| svc Proxy 参数多套一层数组 | 编译通过 | sidecar 收到 undefined 参数 |

## 流程

### 1. 本地 Docker 预检（必须）

```powershell
# Windows
./scripts/precheck.ps1

# Linux / macOS / WSL
./scripts/docker-precheck.sh
```

它做六件事：
1. 源码 require 体检（`scripts/check-requires.cjs`）
2. 构建镜像（优先 deploy/Dockerfile，失败退回根 Dockerfile）
3. 容器内关键文件存在性
4. **require 图加载测试**（拦 MODULE_NOT_FOUND）
5. 前端 index.html 引用的 JS 是否真存在
6. 扩展宿主握手（装了扩展包时）

全绿才继续。

### 2. 本地跑起来点一遍

```bash
docker run -d --name kirari-precheck -p 19090:9089 \
  -e PET_API_DATA_DIR=/app/data kirari-core:precheck
curl http://localhost:19090/health
```

打开 `http://localhost:19090/console`，重点看：
- 侧边栏是否完整（扩展页出现了吗）
- 聊天输入框是否固定底部
- 设置页各页是否都能打开

### 3. 发版

```bash
npm version patch --no-git-tag-version && git commit -am 'chore: bump'
git tag -a vX.Y.Z -m '...' && git push origin main vX.Y.Z
```

### 4. 部署后验证

```bash
docker compose pull && docker compose up -d
docker exec kirari-core node -e "console.log(require('/app/package.json').version)"
curl http://localhost:PORT/health
```
