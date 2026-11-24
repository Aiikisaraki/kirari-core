# ---- 构建阶段：编译原生模块 better-sqlite3 + 处理 kirari-net ----
FROM node:22-bookworm AS build
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
# kirari-net 是 file:../kirari-net 的平级依赖，构建上下文里没有。
# 先用空的占位目录满足 npm 解析，装完主依赖后再落实体（见下方 COPY .kirari-net-build）。
RUN mkdir -p node_modules/kirari-net
RUN npm install --omit=dev
COPY . .
# kirari-net 预置目录（由构建脚本 stage 进来，见 scripts/docker-precheck.sh 与 CI），
# 没有时用空占位保证构建不失败（运行期会缺 kirari-net，靠预检抓出来）
COPY .kirari-net-build* /tmp/kirari-net-src/
RUN if [ -f /tmp/kirari-net-src/package.json ]; then \
      rm -rf node_modules/kirari-net && mkdir -p node_modules/kirari-net && \
      cp /tmp/kirari-net-src/package.json node_modules/kirari-net/ && \
      cp -r /tmp/kirari-net-src/dist node_modules/kirari-net/dist && \
      node -e "require('/app/node_modules/kirari-net')" && echo '[build] kirari-net OK'; \
    else echo '[build] 警告：没有 stage kirari-net，运行期需外部挂载'; fi
RUN npm rebuild better-sqlite3

# ---- Web 控制台构建（独立阶段，产物拷进 runtime）----
FROM node:22-bookworm-slim AS webbuild
WORKDIR /web
COPY web/package.json ./
RUN npm install --no-audit --no-fund
COPY web ./
RUN npm run build

# ---- 运行阶段 ----
FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends bzip2 tar \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=9089 \
    PET_API_DATA_DIR=/data \
    TZ=Asia/Shanghai
# 注意 COPY --from=build /app 的语义：把源目录 /app 的内容拷到目标 /app（不是 /app/app）。
# 写成 `COPY --from=build /app /app` 在 BuildKit 下等价，但老版 docker 会变成 /app/app，
# 这里用 /app/ 结尾显式表达「拷内容」。
COPY --from=build /app/ /app/
# 控制台静态页（app.js 检测到 web/dist/index.html 才启用 /console）
COPY --from=webbuild /web/dist /app/web/dist
EXPOSE 9089
VOLUME ["/data"]
CMD ["node", "server.js"]
