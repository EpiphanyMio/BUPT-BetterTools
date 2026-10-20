# HANDOFF · 项目交接

> 只写状态与结论，规则见 `AGENTS.md`。更新 2026-10-20；不确定的标 **待确认**。

## 状态
- 「Deadline 管理器」已搭建 AI 识别链路：页面填写自备 API 地址/模型/API Key；Worker 把 DOCX/PDF 交给 PythonAnywhere MarkItDown，MD/TXT 直接读取，再调用 OpenAI Chat Completions 兼容接口；结果必须人工确认。Flask 部署包在 `services/markitdown-api/`。`pnpm build` 与 Python 语法检查通过；PythonAnywhere 尚未部署，Worker 的 `MARKITDOWN_API_URL` / `MARKITDOWN_API_SECRET` 尚未配置，真实转换和 AI 调用待验证。旧版 DOC、扫描 PDF 暂不支持。
- 上一个已推送提交 `ad0a4a9`：新增「图片解混淆」模块（纯前端，不需要 D1/R2 迁移），push 即自动部署。
- 上一轮「公共文件池」线上仍在（566167e 之后没有后端改动）；`user_quotas` 表是否已跑过仍**待确认**（见待办）。
- 本轮验证：`pnpm build` exit 0（67 模块）、Node 单测 82/82、浏览器 28/28（访客身份，4 种算法端到端逐像素对比 0 差异）。
- `wrangler.jsonc` 里的多余 R2 绑定 `bupt_bettertools_files` 仍**待确认**；`AGENTS.md` 有未提交改动，都没动。
- `ExternalTools/ObfuscationUtils/` 是 Java 参考库（未提交、不影响构建）；别 `git add -A`。
- **网页开发暂停**：只有用户说「需要合作」才恢复（本次是用户直接下的任务）。

## 项目
工具/网站聚合，多端可用 + 多用户账号 + 云端同步。线上 <https://bupt-bettertools.yuesu76.workers.dev/>，push 自动部署；前端 Vite+React 19+TS+Tailwind 4+@dnd-kit，后端 Workers+D1（`worker/`）；管理员 `EpiphanyMio`（密码**待确认**），注册需邀请码。

## 关键目录
`src/App.tsx` 外壳（门禁/模块切换/搜索/访客横幅）｜`src/components/`｜`src/hooks/`（tools/favorites/order/appSettings/devSettings/theme/auth/sync/fileSync/guest）｜`src/lib/`（auth/sync/syncData/guestMode/fileStore/fileCloud/fileSync/userAdmin/search/fileUtils/imageObfuscation/pngCodec）｜`src/modules/` Files·Toolbox·UserAdmin·ImageDeobfuscate｜`src/google.css`+`src/ui.css` 令牌与基类｜`worker/`（index/auth/d1/r2/schema.sql）｜`DeveloperLogs/` 接口文档+日志｜`scripts/browser-verify.mjs`

## 已完成
工具箱（增删改/分组/收藏/拖拽/详情/搜索）；文件管理（新建/上传/改名/删除/移动/预览/下载）；Google/Material 风格+跟随系统深浅色+上线；云端同步（D1 单行快照+乐观锁，离线优先）；多用户账号（邀请码注册+管理员面板）；访客只读（数据层拦截+界面禁用+横幅）；文件管理上云（R2 存内容 + D1 存目录树 + outbox 离线队列 + 公开分享链接）；用户组管理（管理员首页第三入口：全员用量/最近登录时间/IP；普通用户首页看自己用量）；每账号配额 + 全站 10GB 硬上限；**公共文件池**（我的文件/公共池切换；所有登录用户共享一棵树、都能增删改；池内内容 R2 key `p/{nodeId}` + `customMetadata.uploader` 记上传者，删除/换人重传按它退配额；池内文件不开放免登录分享）；接口文档；冒烟 9/9；**图片解混淆**（8 种算法移植、自写 PNG 编解码、纯本地）。

## 进行中
Deadline 管理器线上导入流程待验证；先前线上功能仍待真实账号验证（见待办 #1、#2）。

## 待办
1. 图片解混淆上线后实测：首页第三张卡能进；选 PNG → 混淆 → 下载 → 重新上传解混淆，结果应与原图一致（Sort/Random 必须用 PNG 测）。
2. 公共文件池上线后验证：两个账号登录，A 在公共池传文件 → B 能看到、能下载；B 的 `used` 不变、A 的 `used` 增加；A 或 B 删除后上传者的 `used` 退回去。
3. 配额功能上线：先确认线上 D1 已跑过 `user_quotas`（没跑就上传 500），再核对管理员调额、普通用户首页 `/ quota` 跟随、全站概览 10.0 GB。
4. 线上管理员登录后核对：首页四卡 2×2（普通账号三卡一行）、用户组管理里能看到全员用量/最近登录/IP；普通账号只看到自己用量。注意**老账号在下一次登录前显示「从未登录」**。
5. 浏览器实测（文件上云遗留）：登录后上传/改名/移动/删除 → 换设备能看到；断网改文件 → 恢复网络 10 秒内补传；分享链接无痕可开、删除后 404；访客/未登录分享按钮禁用。
6. [ui] 文件模块骨架屏/空态/错误态——数据层已就绪：`listLoading`/`listError`/根节点 `data-list-state`
7. [core] 删过渡期 `setNotice(message)`（`FilesModule.tsx`），等 #6 完成，否则错误显示两遍
8. [ui] 三处按钮缺禁用视觉：访客下「编辑分组」「✎」「☆」无反应但外观正常（`CategoryTabs`/`ToolCard` 无 `readOnly`）
9. 访客横幅 z-index：`.scrim`(ui.css:210) 与 `GuestBanner.tsx:32` 同为 `z-50`，弹窗时被压暗；**待确认**
10. [core] 清理死代码：`useSync` 的 `isConfigured`/`setToken` 无消费方，`setToken` 空实现
11. [core] `DevSettingsContent.tsx:166` 的 `w-28field` 疑似应为 `w-28 field`
12. [core] 旧共享令牌残留：`SYNC_TOKEN` 已不参与鉴权；`.dev.vars`/`scripts/_sync-token.txt` 删否**待确认**
13. 路线图后续：PWA → Python 自动化（`Startup_A_Sketch.md`）

## 坑
- `scripts/_archive-log.mjs` 是旧的一次性脚本：**整篇覆盖** `DeveloperLogs/archive/NewFunctions-2026-10.md`，不是追加；别直接跑。本次误用后已用 `git show HEAD:` 恢复。
- 图片解混淆的 Sort/Random 把「列顺序」编进图片最后一行（高 16 位原列号 + 低 16 位 RGB565），这些像素 alpha 常常 < 255。Canvas 是预乘 alpha，透明像素 RGB 会被乘成 0，所以这两个算法**必须走 `src/lib/pngCodec.ts` 自己解码**，别改回 Canvas；导出时只要有一个像素不是全不透明也要走自写编码器。末行本身是 RGB565 有损，还原后只是近似（原库设计）。
- 图片混淆必须无损：JPG 重压缩、截图、缩放、转格式都会改像素，任何算法都还原不了；界面上已写提示。Sort/Random 尤其不能用 JPG。
- 非 ASCII 密钥和 Java 端可能对不上：原库 `(key+i).getBytes()` 用**系统默认编码**（中文 Windows 是 GBK），网页版固定 UTF-8；界面已提示 Block/RowPixel/PerPixel 尽量用英文 / 数字密钥。
- 浏览器实测脚本都是下划线开头、不进 git：`scripts/_image-obf-test.mjs`（Node 单测）、`_image-obf-e2e.mjs`（浏览器端到端）、`_image-obf-visual.mjs`（截图）。
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
不用 UI 框架；不写死颜色、不用 `dark:`；组件不直接碰存储/fetch（存储走 hooks，fetch 只在 `lib/auth.ts`、`lib/sync.ts`、`lib/fileCloud.ts`、`lib/userAdmin.ts`）；快照整包单行+乐观锁，按 `user_id` 隔离，PBKDF2-SHA256 10 万次；同步是加分项，离线照常可用；文件内容走 R2、目录树走 D1，本机 IndexedDB 只做缓存；文件分区用 `FileNode.scope`（缺省 private），池内节点在服务端是 `file_nodes.user_id = 0`，配额归上传者；访客只读两层（`isGuest()` 硬拦截+界面禁用），**登录成功必须清访客标记**；`refresh(id, { silent: true })` 不闪骨架屏；管理员接口一律 `requireAdmin`（401 和 403 分开），前端 `isAdmin` 只决定入口显不显示；配额接口传**整数字节**、界面用 MB 输入，默认配额只存在于代码常量里（无行=默认）。

## 最近提交
`ad0a4a9` 图片解混淆收尾 | `21ae12e` 图片解混淆 | `566167e` 公共文件池 | `98ca28b` 每账号配额 | `44d0d46` 用户组管理上线 | `275dc75` 用户组管理 | `8c67d1d` 文件管理上云 | `4af160f` 卡片详情按钮 | `57fc9ad` 日志归档

## 别读 / 别碰
`node_modules/`、`dist/`、`.pnpm-*`、`.wrangler/`、`.dsh/`、`.dsh-tmp/`、`.backup-before-google/`、`.dev.vars`（密钥）、`DeveloperLogs/archive/`（按需）、`scripts/_*`（临时）、`pnpm-lock.yaml`（除非改依赖）。
