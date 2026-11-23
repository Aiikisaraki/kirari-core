# ---- 构建阶段：编译原生模块 better-sqlite3 ----
FROM node:22-bookworm AS build
WORKDIR /app
# better-sqlite3 在 npm install 时会用 node-gyp 编译，需系统级构建工具。
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN npm rebuild better-sqlite3

# ---- 运行阶段：精简镜像，直接复用已编译的原生模块 ----
FROM node:22-bookworm-slim
# 音色库下载需要解压 .tar.bz2（扩展包语音合成）。
# slim 镜像自带 tar，但 bzip2 不在精简集里 —— tar -j 需要 bzip2 二进制。
RUN apt-get update \
    && apt-get install -y --no-install-recommends bzip2 tar \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=9089 \
    PET_API_DATA_DIR=/data \
    TZ=Asia/Shanghai
COPY --from=build /app /app
# 扩展包管理脚本（ext-install.cjs）属于 kirari-ext-voice 包，不在本仓库构建上下文里；
# 由部署方挂载或 docker cp 进容器，不要在这里 COPY。
EXPOSE 9089
# 数据库落在 /data 卷，容器重建不丢数据。
VOLUME ["/data"]
CMD ["node", "server.js"]
