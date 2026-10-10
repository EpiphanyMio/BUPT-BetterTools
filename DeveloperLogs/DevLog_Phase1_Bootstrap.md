# 开发记录：阶段 1 项目搭建

> 日期：2026-10-10
> 范围：环境准备 → 项目骨架 → 首版网页（纯前端静态工具箱）
> 关联计划：同目录 `Startup_A_Sketch.md`

---

## 一、本次步骤及各自的意义

### 1. 读取需求文档
**做了什么**：读取 `Startup_A_Sketch.md`（258 行），确认项目目标、技术栈与分阶段路线。
**意义**：动手前先对齐目标，避免做成"另一个东西"。结论是先做**阶段 1：纯前端静态工具箱**。

---

### 2. 修复工作区的 Windows 文件权限
**做了什么**：首次访问目录时报错 `SetNamedSecurityInfoW failed (Win32 5)`——文件夹缺少当前用户的「完全控制」权限，沙箱无法读写。用内置的诊断修复脚本补上权限并验证通过。
**意义**：这是一切的前提。权限不恢复，后面的建文件、装依赖全部无法进行。
**备份**：修复前的权限已存在 `..\.dsh-acl-recovery\`，可用其中的 `.ps1` 回滚。

---

### 3. 检查开发环境
**做了什么**：检查 Node.js / 包管理器 / Git。
**结果**：

| 工具 | 状态 |
| --- | --- |
| Node.js | ✅ v24.21.0（内置） |
| pnpm | ✅ v11.7.0（内置） |
| npm | ⚠️ 未安装，用 pnpm 代替 |
| Git | ⚠️ 未安装（阶段 1 用不到） |

**意义**：确认"不需要额外安装就能开工"，并定下用 **pnpm 代替计划里的 npm**（命令几乎一致）。

---

### 4. 创建项目骨架
**做了什么**：建立这些文件——

| 文件 | 作用 |
| --- | --- |
| `index.html` | 页面容器，只有一个 `<div id="root">` |
| `vite.config.ts` | 打包配置（React 插件 + Tailwind 插件） |
| `tsconfig.json` | TypeScript 规则 |
| `package.json` | 依赖清单与命令 |
| `.npmrc` | 让 pnpm 把仓库/缓存放在项目内 |
| `.gitignore` | 排除 node_modules 等，为将来 Git 做准备 |
| `README.md` | 项目说明与常用命令 |

**意义**：先搭"地基"。之后所有开发都只动 `src/`，不用再碰配置。

---

### 5. 安装依赖（踩坑并解决）
**做了什么**：用 pnpm 安装 React 19、Vite 8、TypeScript 7、Tailwind 4。
**遇到的坑**：第一次用 pnpm 默认的**隔离布局**（node_modules 里全是符号链接），构建时报 `Cannot find package 'rolldown'` 和原生模块加载失败。
**解决**：在 `.npmrc` 加 `nodeLinker=hoisted`，改成**扁平布局**（和 npm 一样），重新安装后一切正常。
**意义**：理解了 pnpm 两种 node_modules 布局的差别；扁平布局在 Windows 上更稳，也更贴近你原计划的 npm 体验。

---

### 6. 编写业务代码
**做了什么**：实现三个核心功能。

| 文件 | 作用 |
| --- | --- |
| `src/data/tools.json` | 23 个工具数据（开发/学习/设计/实用/AI 五类） |
| `src/types.ts` | 定义 Tool 类型，字段写错立刻报错 |
| `src/hooks/useFavorites.ts` | 收藏逻辑 + localStorage 持久化 |
| `src/components/SearchBar.tsx` | 搜索框 |
| `src/components/CategoryTabs.tsx` | 分类切换 |
| `src/components/ToolCard.tsx` | 工具卡片 + 收藏星标 |
| `src/App.tsx` | 主界面：持有状态、组合三个筛选条件 |

**意义**：把"搜索 + 分类 + 收藏 + 打开链接"四个功能落地。
**关键认知（React 数据流）**：状态放在 `App` → 通过 props 往下传 → 子组件用回调通知父组件改状态 → 界面自动刷新。这是后面所有功能的基础模型。

---

### 7. 构建验证
**做了什么**：运行 `pnpm build`（= `tsc` 类型检查 + `vite` 打包）。
**结果**：类型检查 0 错误；产物 `dist/` 生成成功（HTML + CSS 13.75 kB + JS 227 kB）。
**意义**：证明代码不只是"能看"，而是**真的能打包部署**。这一步是上线前的体检。

---

### 8. 启动本地预览
**做了什么**：运行 `pnpm dev`，服务地址 <http://localhost:5173/>。
**意义**：改代码后页面自动刷新（HMR），是日常开发时一直开着的窗口。
**注意**：Vite 绑定 IPv6，访问要用 `localhost`，不能用 `127.0.0.1`。

---

## 二、遇到的问题汇总

| 问题 | 原因 | 解决 |
| --- | --- | --- |
| 目录读写全部失败 | 文件夹缺「完全控制」权限 | 跑内置权限修复脚本 |
| `'node' is not recognized` | 内置 Node 不在 PATH | 命令前把 Node 目录加进 `$env:PATH` |
| `spawn EPERM` | 沙箱拦截子进程 | 构建/启动命令用完全权限运行 |
| `Cannot find package 'rolldown'` | pnpm 隔离布局 + 符号链接 | 改 `nodeLinker=hoisted` 扁平布局 |

---

## 三、当前状态

- ✅ 阶段 1 功能全部完成并可访问
- ✅ 代码类型安全、可打包
- 🟡 预览服务后台运行中
- ⏸️ 遗留：DSH 插件 `dsh-external-dsh-context-compactor-0.5.7.tgz` 的安装**尚未完成**（已调研清楚安装方式，未执行）

---

## 四、下一步可选

1. 换掉 `src/data/tools.json` 里的数据，填入真实常用网站
2. 美化界面 / 加暗色模式
3. 装 Git → 推 GitHub → 部署到 Vercel 或 Cloudflare Pages（**上线**）
4. 进入阶段 2：加 PWA，让手机能"添加到主屏幕"
