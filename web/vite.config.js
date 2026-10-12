import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// 开发期：npm run dev 起本地 Vite，接口代理到本机核心版（避免跨域）。
// 生产期：npm run build 产物进 dist/，由核心版 express.static 同端口托管。
export default defineConfig({
    plugins: [vue()],
    // 相对路径：控制台既挂在 /console 下，也直接挂在 / 上（首页打开就是它）。
    // 写死 /console/ 的话，从 / 打开时资源会去请求 /assets/... 而那个路径并不存在。
    base: "./",
    server: {
        port: 5180,
        proxy: {
            "/api": {
                target: process.env.CONSOLE_API_TARGET || "http://127.0.0.1:9089",
                changeOrigin: true,
            },
        },
    },
    build: {
        outDir: "dist",
        emptyOutDir: true,
    },
});
