# 我的工具箱 (BetterTools)

个人工具箱网页：聚合常用工具和网站，电脑和手机都能用。

技术栈：Vite + React + TypeScript + Tailwind CSS

## 常用命令

```bash
pnpm install     # 安装依赖（第一次或依赖变化时）
pnpm dev         # 本地预览，默认 http://localhost:5173
pnpm build       # 打包成 dist/ 目录（用于部署）
pnpm preview     # 预览打包结果
```

## 目录说明

```
src/
├── main.tsx            入口：把 App 挂到页面上
├── App.tsx             主界面：搜索 + 分类 + 卡片列表
├── index.css           全局样式（引入 Tailwind）
├── types.ts            数据类型定义
├── data/tools.json     工具数据（第一版写死在这里）
├── hooks/
│   └── useFavorites.ts 收藏功能（存到浏览器本地）
└── components/
    ├── SearchBar.tsx    搜索框
    ├── CategoryTabs.tsx 分类切换
    └── ToolCard.tsx     单个工具卡片
```

## 路线

- 阶段 1（当前）：纯前端静态工具箱 + 部署
- 阶段 2：PWA
- 阶段 3：Python 自动化
- 阶段 4：Python 后端 + 同步
- 阶段 5/6：C / WebAssembly
