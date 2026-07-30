<p align="center">
  <img src="./assets/kirari-banner.jpg" alt="Kirari" width="720">
</p>

# Kirari 绮莉 (kirari-desktop)

桌面宠物客户端：Electron + Vue 3 + Vite + TypeScript。

## 特性

- 模型配置可在安装向导或「设置」中填写，配置持久化于用户目录 `config.json`，直接编辑文件即生效。
- 默认使用免费大模型 API（chatanywhere），也可自由切换任意 OpenAI 兼容端点。

## 开发

```bash
npm install
npm run dev          # 开发模式（前端 + 本地后端子进程）
```

## 打包（本地）

```bash
rm -rf release
npm run dist         # vite build + electron-builder，产出 release/*.exe
```

## 仓库结构

- 本仓库为**前端/客户端**（Electron 应用）。
- 后端服务见 [`kirari-core`](https://github.com/Aiikisaraki/kirari-core)。

---

> 🤖 **本项目由 AI 辅助创建并持续维护**。界面、交互逻辑与打包流程均在 AI 协作下设计与实现，欢迎反馈与共建。
