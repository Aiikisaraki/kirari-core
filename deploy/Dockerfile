# 多阶段构建：编译原生依赖后，只把运行期文件拷进精简镜像。
#
# 说明：better-sqlite3 的预编译产物是 N-API（ABI 与 Node 版本无关），
# 绝大多数平台 npm install 直接取预编译二进制，不需要编译工具链；
# 若日志显示 node-gyp 编译，说明该平台没有对应预编译包，
# 这时会自动切到 node:20-bookworm 基础镜像（build-essential 已内置）。
FROM node:24-bookworm-slim AS deps

WORKDIR /app
# better-sqlite3 有原生模块，npm ci 时它会触发 install 脚本；
# libc6-compat 补上 glibc 兼容层（部分 N-API 产物需要）。
RUN apt-get update \
    && apt-get install -y --no-install-recommends libc6-compat \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund


FROM node:24-bookworm-slim AS runtime

WORKDIR /app

# 建议用非 root 运行；但 node 镜像内的 node 用户 uid 1000，
# 需要能写 /app/data（挂载卷）——docker-compose 里已配好。
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js ./
COPY src ./src

# SQLite 数据目录（挂卷到这里）
RUN mkdir -p /app/data && chown -R node:node /app

EXPOSE 9089

# 用 node 直接启动（不经 npm，让信号能直达进程，Docker stop 才利索）
CMD ["node", "server.js"]
