# HANDOFF · 项目交接

> 只写状态与结论，规则见 `AGENTS.md`。更新 2026-10-19 15:31；不确定的标 **待确认**。

## 状态
- `HEAD = 8c67d1d` 线上部署已生效。**工作区有未提交的「用户组管理」改动**（worker + src + 文档）：`pnpm build` exit 0、`scripts/_admin-users-e2e.mjs` 22/22、浏览器实测 23/23 全过。
- ⚠️ **push 前必须先跑线上 D1 迁移**（新表 `login_records`）：`npx wrangler d1 execute bupt-bettertools-sync --remote --file=worker/schema.sql`。不跑不影响登录/注册，但 `/api/admin/users` 会 500。
- R2 桶已建（文件管理上云已上线）。`wrangler.jsonc` 里有一个**不是这次改动**的多余 R2 绑定 `bupt_bettertools_files`，push 前**待确认**。
- **网页开发暂停**：只有用户说「需要合作」才恢复（本次是用户直接下的任务）。

## 项目
工具/网站聚合，多端可用 + 多用户账号 + 云端同步。线上 <https://bupt-bettertools.yuesu76.workers.dev/>，push 自动部署；前端 Vite+React 19+TS+Tailwind 4+@dnd-kit，后端 Workers+D1（`worker/`）；管理员 `EpiphanyMio`（密码**待确认**），注册需邀请码。

## 关键目录
`src/App.tsx` 外壳（门禁/模块切换/搜索/访客横幅）｜`src/components/`｜`src/hooks/`（tools/favorites/order/appSettings/devSettings/theme/auth/sync/fileSync/guest）｜`src/lib/`（auth/sync/syncData/guestMode/fileStore/fileCloud/fileSync/userAdmin/search/fileUtils）｜`src/modules/` Files·Toolbox·UserAdmin｜`src/google.css`+`src/ui.css` 令牌与基类｜`worker/`（index/auth/d1/r2/schema.sql）｜`DeveloperLogs/` 接口文档+日志｜`scripts/browser-verify.mjs`

## 已完成
工具箱（增删改/分组/收藏/拖拽/详情/搜索）；文件管理（新建/上传/改名/删除/移动/预览/下载）；Google/Material 风格+跟随系统深浅色+上线；云端同步（D1 单行快照+乐观锁，离线优先）；多用户账号（邀请码注册+管理员面板）；访客只读（数据层拦截+界面禁用+横幅）；文件管理上云（R2 存内容 + D1 存目录树 + outbox 离线队列 + 公开分享链接）；**用户组管理**（管理员首页第三入口：全员用量/最近登录时间/IP；普通用户首页看自己用量）；接口文档；浏览器冒烟 9/9。

## 进行中
用户组管理功能已完成本地验证（build / 后端 e2e / 浏览器实测全过），**未提交、未 push**；等用户确认后执行线上 D1 迁移 + 提交推送。

## 待办
1. 用户组管理上线：**先跑线上 D1 迁移**（`login_records`），确认 `wrangler.jsonc` 的多余 R2 绑定，再提交 push；上线后线上实测管理员能看到 3 人列表 + IP、普通用户首页有自己用量。
2. 浏览器实测（文件上云遗留）：登录后上传/改名/移动/删除 → 换设备（或清 IndexedDB）登录同账号能看到；断网改文件 → 恢复网络 10 秒内补传；生成分享链接 → 无痕窗口能打开；删除后链接 404；访客/未登录分享按钮禁用。
3. [ui] 文件模块骨架屏/空态/错误态——数据层已就绪：`listLoading`/`listError`/根节点 `data-list-state`
4. [core] 删过渡期 `setNotice(message)`（`FilesModule.tsx`），等 #3 完成，否则错误显示两遍
5. [ui] 三处按钮缺禁用视觉：访客下「编辑分组」「✎」「☆」无反应但外观正常（`CategoryTabs`/`ToolCard` 无 `readOnly`）
6. 访客横幅 z-index：`.scrim`(ui.css:210) 与 `GuestBanner.tsx:32` 同为 `z-50`，弹窗时被压暗；**待确认**
7. [core] 清理死代码：`useSync` 的 `isConfigured`/`setToken` 无消费方，`setToken` 空实现
8. [core] `DevSettingsContent.tsx:166` 的 `w-28field` 疑似应为 `w-28 field`
9. [core] 旧共享令牌残留：`SYNC_TOKEN` 已不参与鉴权；`.dev.vars`/`scripts/_sync-token.txt` 删否**待确认**
10. 路线图后续：PWA → Python 自动化（`Startup_A_Sketch.md`）

## 坑
- `a2a-communicator/STATUS.md` #5「`refresh()` 闪骨架屏」**已在 `0525cbe` 修好**（`{ silent: true }`），别重做。
- `*.workers.dev` DNS 污染→代理 `http://127.0.0.1:7897`；git push 连不上同样加代理；本机 `wrangler dev`/`d1 --local` 起不来，用 `scripts/_auth-e2e.mjs`、`_sync-e2e.mjs`、`_files-e2e.mjs` 验证。
- 文件配额只能按 **R2 对象真实大小**（`head`）算，不能用 `file_nodes.size`：客户端在传内容前会先推一个"猜的大小"，拿它算 delta 会让用量永远记 0（已踩过）。
- 换账号必须清本机文件缓存（`better-tools:files-owner` → `resetFileStore()`），否则上一个账号的文件会被迁移进新账号。
- `login_records` **只留最近一次**登录（不记历史）；IP 优先 `cf-connecting-ip`，本地/代理环境为空串，页面显示「——」；`lastLoginAt = null` 表示从未登录，不能当 0（会显示成 1970）。
- Worker 代码先上线而 schema 没跑时：登录/注册照常（`recordLogin` 已 catch），但 `GET /api/admin/users` 会 500。上线顺序永远是「先跑 schema，再 push」。

## 约定
不用 UI 框架；不写死颜色、不用 `dark:`；组件不直接碰存储/fetch（存储走 hooks，fetch 只在 `lib/auth.ts`、`lib/sync.ts`、`lib/fileCloud.ts`、`lib/userAdmin.ts`）；快照整包单行+乐观锁，按 `user_id` 隔离，PBKDF2-SHA256 10 万次；同步是加分项，离线照常可用；文件内容走 R2、目录树走 D1，本机 IndexedDB 只做缓存；访客只读两层（`isGuest()` 硬拦截+界面禁用），**登录成功必须清访客标记**；`refresh(id, { silent: true })` 不闪骨架屏；管理员接口一律 `requireAdmin`（401 和 403 分开），前端 `isAdmin` 只决定入口显不显示。

## 最近提交
`8c67d1d` 文件管理上云 | `4af160f` 卡片详情按钮 | `57fc9ad` 日志归档 | `1f7ff4f` browser-verify | `0525cbe` 访客只读 | `c0f64ac` 协作触发词 | `64b8f66` 多用户账号 | `2b0c915` 云端同步

## 别读 / 别碰
`node_modules/`、`dist/`、`.pnpm-*`、`.wrangler/`、`.dsh/`、`.dsh-tmp/`、`.backup-before-google/`、`.dev.vars`（密钥）、`DeveloperLogs/archive/`（按需）、`scripts/_*`（临时）、`pnpm-lock.yaml`（除非改依赖）。
