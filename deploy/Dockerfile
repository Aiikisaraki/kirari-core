# 多阶段构建：编译原生依赖后，只把运行期文件拷进精简镜像。
#
# 说明：better-sqlite3 的预编译产物是 N-API（ABI 与 Node 版本无关），
# 绝大多数平台 npm install 直接取预编译二进制，不需要编译工具链；
# 若日志显示 node-gyp 编译，说明该平台没有对应预编译包，
# 这时会自动切到 node:20-bookworm 基础镜像（build-essential 已内置）。
#
# ── 组网层 kirari-net 怎么进来 ────────────────────────────────────────
# 它是与 kirari-core **平级**的本地包（package.json 写的是 file:../kirari-net），
# 而 Docker 构建上下文只有 kirari-core 一个目录，里面根本没有 ../kirari-net。
# 所以 compose 里额外挂了一个构建上下文（additional_contexts: kirari_net），
# 这个文件用 `COPY --from=kirari_net` 取它的预编译产物。
#
# ⚠️ 构建前先在 kirari-net 里跑一次 `npm run build`：这里取的是它的 **dist**，
#    Docker 构建不会替它编译（它的 devDependencies 也不在镜像里）。
#
# ⚠️ 为什么不干脆让 npm 去解析 file: 依赖：
#    npm ci 在目标目录不存在时**不报错**，只会在 node_modules 里留一个悬空软链；
#    镜像照样能构建成功，但启动时 require("kirari-net") 直接 MODULE_NOT_FOUND ——
#    属于「构建绿灯、运行即崩」的坑。这里改成把包**落成实体目录**，
#    不依赖 npm 建软链，也就不受构建上下文里有没有 ../kirari-net 影响。
FROM node:24-bookworm-slim AS deps

WORKDIR /app
# 说明：bookworm 本身就是 glibc，better-sqlite3 的 N-API 预编译产物直接可用，
# 不需要任何额外系统包。（曾写 apt-get install libc6-compat —— 那是 Alpine 的
# 包名，Debian 源里不存在，会让构建直接失败。）

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# 把组网层放成 node_modules 里的实体目录（覆盖 npm ci 留下的悬空软链）
COPY --from=kirari_net package.json /kirari-net-src/package.json
COPY --from=kirari_net dist /kirari-net-src/dist
RUN rm -rf node_modules/kirari-net \
    && mkdir -p node_modules/kirari-net \
    && cp -r /kirari-net-src/package.json /kirari-net-src/dist node_modules/kirari-net/ \
    && node -e "require('/app/node_modules/kirari-net')" \
    && echo "[build] kirari-net 已就位且可被 require"


# Web 控制台静态页：在独立阶段用 npm 装依赖并构建（容器构建期有网），
# 产物拷进 runtime。web/ 是独立小工程，与主服务依赖互不相干。
FROM node:24-bookworm-slim AS webbuild
WORKDIR /web
COPY web/package.json ./
RUN npm install --no-audit --no-fund
COPY web ./
RUN npm run build


FROM node:24-bookworm-slim AS runtime

WORKDIR /app

# 建议用非 root 运行；但 node 镜像内的 node 用户 uid 1000，
# 需要能写 /app/data（挂载卷）——docker-compose 里已配好。
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js ./
COPY src ./src
# 控制台静态页（app.js 检测到 web/dist/index.html 才会启用 /console）
COPY --from=webbuild /web/dist ./web/dist

# SQLite 数据目录（挂卷到这里）
RUN mkdir -p /app/data && chown -R node:node /app

# 9089 = 机器人 HTTP 接口；19760 = 组网固定端口（NET_ROLE=host 时才需要，
# 而且必须在 compose 里映射出去，否则局域网内的设备连不上）。
EXPOSE 9089 19760

# 用 node 直接启动（不经 npm，让信号能直达进程，Docker stop 才利索）
CMD ["node", "server.js"]
