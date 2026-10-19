# HANDOFF · 项目交接

> 只写状态与结论，规则见 `AGENTS.md`。更新 2026-10-19 16:05；不确定的标 **待确认**。

## 状态
- `HEAD = 98ca28b` 已 push 到 `origin/main`：线上是「用户组管理 v1 + 每账号配额」，HTML 引用 `index-OkshDJ7s.js`（本次改动之前）。
- 工作区**已改完「公共文件池」**（worker + src + 文档）：`pnpm build` exit 0、`_files-e2e.mjs` **32/32**；浏览器实测进行中（见进行中）。
- 公共文件池**不需要跑 D1 迁移**（复用 `file_nodes`，`user_id = 0` 表示池内节点），push 即可上线。
- ⚠️ 线上 `user_quotas` 表是否已跑过 **待确认**（HANDOFF 上次警告过；若没跑，上传会 500）。本次改动不依赖它，但线上验证前先确认。
- `wrangler.jsonc` 里有一个**不是这次改动**的多余 R2 绑定 `bupt_bettertools_files`，仍**待确认**；`AGENTS.md` 也有未提交改动，都没动。
- **网页开发暂停**：只有用户说「需要合作」才恢复（本次是用户直接下的任务）。

## 项目
工具/网站聚合，多端可用 + 多用户账号 + 云端同步。线上 <https://bupt-bettertools.yuesu76.workers.dev/>，push 自动部署；前端 Vite+React 19+TS+Tailwind 4+@dnd-kit，后端 Workers+D1（`worker/`）；管理员 `EpiphanyMio`（密码**待确认**），注册需邀请码。

## 关键目录
`src/App.tsx` 外壳（门禁/模块切换/搜索/访客横幅）｜`src/components/`｜`src/hooks/`（tools/favorites/order/appSettings/devSettings/theme/auth/sync/fileSync/guest）｜`src/lib/`（auth/sync/syncData/guestMode/fileStore/fileCloud/fileSync/userAdmin/search/fileUtils）｜`src/modules/` Files·Toolbox·UserAdmin｜`src/google.css`+`src/ui.css` 令牌与基类｜`worker/`（index/auth/d1/r2/schema.sql）｜`DeveloperLogs/` 接口文档+日志｜`scripts/browser-verify.mjs`

## 已完成
工具箱（增删改/分组/收藏/拖拽/详情/搜索）；文件管理（新建/上传/改名/删除/移动/预览/下载）；Google/Material 风格+跟随系统深浅色+上线；云端同步（D1 单行快照+乐观锁，离线优先）；多用户账号（邀请码注册+管理员面板）；访客只读（数据层拦截+界面禁用+横幅）；文件管理上云（R2 存内容 + D1 存目录树 + outbox 离线队列 + 公开分享链接）；用户组管理（管理员首页第三入口：全员用量/最近登录时间/IP；普通用户首页看自己用量）；每账号配额 + 全站 10GB 硬上限；**公共文件池**（我的文件/公共池切换；所有登录用户共享一棵树、都能增删改；池内内容 R2 key `p/{nodeId}` + `customMetadata.uploader` 记上传者，删除/换人重传按它退配额；池内文件不开放免登录分享）；接口文档；冒烟 9/9。

## 进行中
「公共文件池」代码 + 文档已完成，**未提交、未 push**。后端 e2e 32/32、build 通过；浏览器实测脚本 `scripts/_ui-pool-verify.mjs` 已跑到跨账号可见，最后一次因测试时序（上传后同步防抖）未跑完 —— 确认后提交推送。

## 待办
1. 公共文件池：跑完浏览器实测 → 提交 push（push 即部署）；上线后登录两个账号验证「A 放池里的文件 B 能看到、B 的配额不变、上传者配额增加」。
2. 配额功能上线：先确认线上 D1 已跑过 `user_quotas`（没跑就上传 500），再核对管理员调额、普通用户首页 `/ quota` 跟随、全站概览 10.0 GB。
3. 线上管理员登录后核对：首页三卡三列、用户组管理里能看到全员用量/最近登录/IP；普通账号只看到自己用量。注意**老账号在下一次登录前显示「从未登录」**。
4. 浏览器实测（文件上云遗留）：登录后上传/改名/移动/删除 → 换设备能看到；断网改文件 → 恢复网络 10 秒内补传；分享链接无痕可开、删除后 404；访客/未登录分享按钮禁用。
5. [ui] 文件模块骨架屏/空态/错误态——数据层已就绪：`listLoading`/`listError`/根节点 `data-list-state`
6. [core] 删过渡期 `setNotice(message)`（`FilesModule.tsx`），等 #5 完成，否则错误显示两遍
7. [ui] 三处按钮缺禁用视觉：访客下「编辑分组」「✎」「☆」无反应但外观正常（`CategoryTabs`/`ToolCard` 无 `readOnly`）
8. 访客横幅 z-index：`.scrim`(ui.css:210) 与 `GuestBanner.tsx:32` 同为 `z-50`，弹窗时被压暗；**待确认**
9. [core] 清理死代码：`useSync` 的 `isConfigured`/`setToken` 无消费方，`setToken` 空实现
10. [core] `DevSettingsContent.tsx:166` 的 `w-28field` 疑似应为 `w-28 field`
11. [core] 旧共享令牌残留：`SYNC_TOKEN` 已不参与鉴权；`.dev.vars`/`scripts/_sync-token.txt` 删否**待确认**
12. 路线图后续：PWA → Python 自动化（`Startup_A_Sketch.md`）

## 坑
- `scripts/_archive-log.mjs` 是旧的一次性脚本：**整篇覆盖** `DeveloperLogs/archive/NewFunctions-2026-10.md`，不是追加；别直接跑。本次误用后已用 `git show HEAD:` 恢复。
- 公共文件池复用 `file_nodes`：`user_id = 0` 是池子，真实账号从 1 开始。池内 R2 key 是 `p/{nodeId}`，私人是 `u/{userId}/{nodeId}`。
- 池内文件的配额归属靠 R2 `customMetadata.uploader`（不是 D1）。换人重传时会先退旧上传者、再记新上传者；删除同理。别再用 `file_nodes.size` 算配额。
- 池内文件不开放免登录分享：`POST /api/files/shares` 对池内节点回 404（UI 已禁用按钮）。
- `a2a-communicator/STATUS.md` #5「`refresh()` 闪骨架屏」**已在 `0525cbe` 修好**（`{ silent: true }`），别重做。
- `*.workers.dev` DNS 污染→代理 `http://127.0.0.1:7897`；git push 连不上同样加代理；本机 `wrangler dev`/`d1 --local` 起不来，用 `scripts/_auth-e2e.mjs`、`_sync-e2e.mjs`、`_files-e2e.mjs` 验证。
- 文件配额只能按 **R2 对象真实大小**（`head`）算，不能用 `file_nodes.size`：客户端在传内容前会先推一个"猜的大小"，拿它算 delta 会让用量永远记 0（已踩过）。
- 换账号必须清本机文件缓存（`better-tools:files-owner` → `resetFileStore()`），否则上一个账号的文件会被迁移进新账号。
- `login_records` **只留最近一次**登录（不记历史）；IP 优先 `cf-connecting-ip`，本地/代理环境为空串，页面显示「——」；`lastLoginAt = null` 表示从未登录，不能当 0（会显示成 1970）。
- Worker 代码先上线而 schema 没跑时：登录/注册照常（`recordLogin` 已 catch），但 `GET /api/admin/users` 会 500。上线顺序永远是「先跑 schema，再 push」。
- 配额改动上线时顺序更要严格：`user_quotas` 缺失会让**上传接口**也 500（没有 login_records 那种降级），等于所有文件传不上去。
- 个人配额是 `user_quotas` 覆盖值、**没有行就用默认值**（500MB）；全站 10GB 只按 `SUM(file_usage.bytes)` 算（不数 `file_nodes.size`：墓碑和客户端猜的大小会让数字偏大）。把某人配额调到低于已用量不会删文件，只拦 `delta > 0` 的新增。

## 约定
不用 UI 框架；不写死颜色、不用 `dark:`；组件不直接碰存储/fetch（存储走 hooks，fetch 只在 `lib/auth.ts`、`lib/sync.ts`、`lib/fileCloud.ts`、`lib/userAdmin.ts`）；快照整包单行+乐观锁，按 `user_id` 隔离，PBKDF2-SHA256 10 万次；同步是加分项，离线照常可用；文件内容走 R2、目录树走 D1，本机 IndexedDB 只做缓存；访客只读两层（`isGuest()` 硬拦截+界面禁用），**登录成功必须清访客标记**；`refresh(id, { silent: true })` 不闪骨架屏；管理员接口一律 `requireAdmin`（401 和 403 分开），前端 `isAdmin` 只决定入口显不显示；配额接口传**整数字节**、界面用 MB 输入，默认配额只存在于代码常量里（无行=默认）。

## 最近提交
`275dc75` 用户组管理 | `8c67d1d` 文件管理上云 | `4af160f` 卡片详情按钮 | `57fc9ad` 日志归档 | `1f7ff4f` browser-verify | `0525cbe` 访客只读 | `c0f64ac` 协作触发词 | `64b8f66` 多用户账号 | `2b0c915` 云端同步

## 别读 / 别碰
`node_modules/`、`dist/`、`.pnpm-*`、`.wrangler/`、`.dsh/`、`.dsh-tmp/`、`.backup-before-google/`、`.dev.vars`（密钥）、`DeveloperLogs/archive/`（按需）、`scripts/_*`（临时）、`pnpm-lock.yaml`（除非改依赖）。
