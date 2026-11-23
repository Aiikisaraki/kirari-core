# 核心版扩展能力（容器部署）

> 桌宠端与核心版共用同一套扩展契约（src/extensions/host.js）和**同一个扩展目录布局**。
> 容器化部署时唯一的差别是：扩展包装到**数据卷里**，而不是宿主机。

## 目录布局（容器内）

    /data/                            <- PET_API_DATA_DIR，命名卷 pet-api-data
    ├── extensions/                   <- 扩展包根目录（宿主启动时扫描）
    │   └── com.akisaki.voice.aishell3/
    │       ├── manifest.json
    │       ├── package.json
    │       ├── bin/server.cjs        <- sidecar（launch: host-node，用容器内 Node 跑）
    │       ├── node_modules/         <- sherpa-onnx-node + Linux 原生库
    │       └── voices/               <- 音色库（按需下载 / 手动放置）
    │           ├── aishell3/
    │           │   ├── model.onnx
    │           │   ├── tokens.txt
    │           │   └── ...
    │           └── huayan/
    └── ...

关键点：**扩展目录在数据卷内**。容器重建 / 换镜像，扩展包和音色库都还在。

## 安装扩展包：三种方式

### 方式 1：docker cp（最直接）

扩展包在宿主机上打包成 Linux 版后拷进容器卷：

    # 1. 在宿主机打包（node_modules 必须是 Linux 版的 sherpa-onnx-node）
    cd kirari-ext-voice
    rm -rf node_modules package-lock.json
    npm install --omit=dev
    tar -czf voice-pack.tar.gz manifest.json package.json bin node_modules

    # 2. 拷进容器的数据卷
    docker cp voice-pack.tar.gz pet-api:/tmp/
    docker exec pet-api sh -c "mkdir -p /data/extensions/com.akisaki.voice.aishell3 \
      && tar -xzf /tmp/voice-pack.tar.gz -C /data/extensions/com.akisaki.voice.aishell3 \
      && rm /tmp/voice-pack.tar.gz"

    # 3. 重启服务（扩展宿主启动时扫描）
    docker restart pet-api

    # 4. 验证
    docker exec pet-api ls /data/extensions/
    docker logs pet-api 2>&1 | grep ext

### 方式 2：控制台 HTTP 端点（音色库管理）

核心版暴露了与桌宠端对等的管理端点（管理口令鉴权）：

    curl -H "X-Admin-Token: xxx" http://host:9089/api/extensions/voices
    curl -X POST -H "X-Admin-Token: xxx" \
      http://host:9089/api/extensions/voices/aishell3/download
    curl -H "X-Admin-Token: xxx" http://host:9089/api/extensions/voices/progress
    curl -X DELETE -H "X-Admin-Token: xxx" \
      http://host:9089/api/extensions/voices/aishell3

**限制**：扩展包本体（bin/ + node_modules）不能通过 HTTP 装 ——
那等于允许远程写任意可执行文件，安全上不成立。控制台端点只管「音色库」这层数据；
**扩展包本体**仍需方式 1 或方式 3。

### 方式 3：自定义镜像（运维友好）

把扩展包直接打进镜像，适合批量部署：

    FROM node:22-bookworm-slim
    # ... 原有内容 ...
    COPY kirari-ext-voice/  /opt/voice-pack/
    # 启动脚本里同步到 /data/extensions/（卷是空的才拷，幂等）
    # CMD 前置：node scripts/sync-pack.js /opt/voice-pack /data/extensions/com.akisaki.voice.aishell3

注意：/data 是 VOLUME，镜像里 COPY 进 VOLUME 路径的文件会在容器首次启动时
被卷内容覆盖（Docker 固有行为）。所以方式 3 要靠**启动脚本幂等同步**到卷里，
而不是 COPY 进 /data 本身。

## sherpa-onnx 的平台问题

扩展包 node_modules/sherpa-onnx-node 含**平台相关原生库**：

    sherpa-onnx-win-x64/    <- Windows 宿主机
    sherpa-onnx-linux-x64/  <- Linux 容器
    sherpa-onnx-darwin-*/   <- macOS

npm install 按当前平台全量装（optionalDependencies 机制），所以**同一份包**
在 Windows 宿主机和 Linux 容器里各装一份即可，运行时各自加载对应平台目录。
不需要交叉编译。

## 音色库下载的容器内依赖

voiceRoutes.js 解压用系统 tar -xjf：

  · tar：bookworm 基础包（required），slim 镜像自带
  · bzip2：**不在 slim 里** —— Dockerfile 已显式安装

下载走 Node 全局 fetch（Node 22 自带），无需额外依赖。

## 与桌宠端的互通

两端扩展包目录布局完全一致，**同一份扩展包**（含 Linux 版 node_modules）拷到
桌宠机的 ~/.kirari/extensions/ 一样能跑（Windows 下加载 sherpa-onnx-win-x64）。
音色库（voices/ 下的模型文件）是平台无关的，可以直接共享或同步。