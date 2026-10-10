# AGENTS.md — BetterTools 项目开发约定

> 这份文件会被 DSH（`@deepseek-ai/dsh-agent-instructions`）在**每个新对话的首次请求**自动注入，
> 目的：新开对话不必重新交代背景与习惯。

---

## 1. 沟通与讲解

- **用中文回复。**
- 我是**编程初学者**（电脑操作熟练）。讲解关键代码时说明**变量、函数、事件、数据流向**，让我能大致看懂 JS/TS 逻辑即可；**不要**深入底层原理和复杂设计模式，不要长篇大论。
- 改完代码用一两句话说明「改了什么、为什么这么改」。

## 2. 项目概况

- 目标：**个人工具箱** —— 聚合常用工具和网站，电脑和手机都能用。
- 路线：网页 → PWA → Python 自动化 → Python 后端同步 → C/WASM。**当前在阶段 1（纯前端静态工具箱）**。
- 技术栈：**Vite + React 19 + TypeScript + Tailwind CSS 4 + @dnd-kit**。
- 数据全部存浏览器 **localStorage**，没有后端；`src/data/tools.json` 只是首次使用的**种子数据**。
- 完整计划见 `DeveloperLogs/Startup_A_Sketch.md`。

## 3. 环境与命令（务必先读）

DSH 里的 Node / pnpm **不在 PATH 上**，要用完整路径：

- node：`C:\Users\ROG\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`
- pnpm：`C:\Users\ROG\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs`
- 调用：`& <node> <pnpm.mjs> <子命令>`，并把 node 的 bin 目录加入 `$env:PATH`（否则脚本内找不到 `node`）。

**沙箱**：受限（workspace-write）模式会逐个拦截文件操作，导致 `pnpm install/build` 极慢甚至卡死；**安装与构建一律用完全权限**（`danger-full-access`）运行，速度差上百倍。这**不是网络问题，不需要 VPN**。

**命令**：`pnpm dev` / `pnpm build`（含 `tsc --noEmit`）/ `pnpm preview`。

**预览**：<http://localhost:5173/> —— Vite 绑的是 IPv6，必须用 `localhost`，不能用 `127.0.0.1`。

**改完必须验证**：`pnpm build` 必须通过；必要时再用开发服务器确认新模块能编译。

## 4. 代码约定

- 注释与界面文案一律**中文**；注释解释「为什么这么做」。
- 目录：`src/components/` 组件；`src/hooks/` 自定义 Hook（`useTools` 工具数据、`useFavorites` 收藏、`useToolOrder` 排序、`useDevSettings` 开发者设置）；`src/lib/` 常量与工具函数。
- 新功能/改动完成后，**要更新 `DeveloperLogs/New Functions.md`**。

## 5. New Functions 日志规则

文件 `DeveloperLogs/New Functions.md`，**新条目加在顶部**。合并规则：

- **小改动**（加分组、加网站链接、改文案）→ 合并成一条「小改动合并」；
- **功能相近**（同属"编辑工具""拖拽"这类同一件事）→ 并进已有条目作为 **子项**，标题时间改成区间（如 `10:49–11:03`）；
- **功能独立、体量较大**（拖动排序、开发者设置面板）→ **单独一条**；
- 正文保持简短，末尾附「涉及文件」。

## 6. 开发者设置面板

- 位置：主页面右上角「⚙ 开发者设置」。
- **是否为某个参数留可调接口，由你自行判断**：数值属于"拍脑袋定的、调了能明显改变观感、不改代码就能验证"的，就加进去；结构性参数（接口地址、数据结构）不要加。
- 加参数改三处：`useDevSettings.ts` 的默认值、`DevSettingsPanel.tsx` 的 `FIELDS`、以及用到它的组件。
- **该面板开发目前暂停**，不要主动扩充；确有需要再加，并在回复中说明。

## 7. 工作习惯

- 交付文件（文档、图片、Office）用 `present` 展示。
- 涉及删除、覆盖、批量修改时，先确认目标路径再动手。
- 界面交互类功能我这边无法实机测试，交付时要列出「需要我验证的点」。
