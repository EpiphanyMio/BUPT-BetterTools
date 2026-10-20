# New Functions

> 本文件记录每次新增功能的**简要说明**与**添加时间**。
> 维护约定：
> - 新条目追加到**顶部**（最新的在最上面）。
> - **小改动合并成一条**（例如新增分组、新增网站链接）。
> - **功能相近的改动合并进同一条，作为子项**（例如"编辑工具"的几种入口、跨分组移动的几种拖法）。
> - 只有**功能独立、体量较大**的才单独开一条（例如卡片拖动排序）。
> - **只留最近 5 条**：更早的移到 `DeveloperLogs/archive/`，文末留索引（避免每个新对话都整篇重读）。

---

## 2026-10-20 15:40 · 新增「图片解混淆」模块：把 Java 库 ObfuscationUtils 移植进浏览器

首页多了第三张入口卡「图片解混淆」：上传被混淆的图片 → 选算法 → 填密钥 → 下载还原后的 PNG。全部在浏览器本地计算，图片不上传，断网也能用。

### 为什么是重写，而不是直接跑原库

原库 `ExternalTools/ObfuscationUtils` 是 Java（Gradle + AWT），网页里没有 JVM，Cloudflare Workers 也跑不了。所以 8 种算法（PicEncrypt 行列 / 行、Tomato、Block、RowPixel、PerPixel、Sort、Random）全部逐行移植成 `src/lib/imageObfuscation.ts`；连 Java 的实现细节都照搬：MD5 洗牌、`java.util.Random` 的 48 位 LCG、`Math.floorDiv`、有符号 int 比较、`Math.round` —— 同一个密钥、同一张图，结果和原库一致。原库的 XuanObfuscation 是空壳（process 返回 null），没有移植。

### 坑：Canvas 会毁掉透明像素里的信息

Sort / Random 把「列顺序」编码进图片最后一行（高 16 位原列号 + 低 16 位 RGB565），而这些像素的 alpha 常常不是 255。浏览器 Canvas 内部是预乘 alpha：`putImageData` / `drawImage` 之后透明像素的 RGB 会被乘成 0，映射直接丢失，解出来是噪点。
所以新增 `src/lib/pngCodec.ts`：自己解 / 编 PNG（8 位、非隔行，支持 0/2/3/4/6 颜色类型和 tRNS），这两个算法不用 Canvas；导出时只要有像素不是全不透明，也走自写编码器保真。普通不透明图仍用 Canvas 导出，体积更小。

### 实现要点

- 引擎是纯函数 `processImage(算法, 方向, 密钥, {rgba,width,height})`，不碰 DOM，能直接在 Node 里单测。
- Block 会把宽高补齐到 32 的倍数（原库行为），输出尺寸可能变大；Sort / Random 的最后一行是有损 RGB565，还原后这一行只是近似 —— 都是算法本身的设计。
- 界面：拖拽 / 选择图片、算法说明、密钥类型提示、原图与结果并排、下载 PNG、错误中文提示；首页卡片列数改成按数量自适应（普通用户 3 张三列，管理员 4 张 2×2）。
- 访客可用：纯本地计算、不写任何数据，不做只读限制。
- 兼容性说明：原库对**非 ASCII 密钥**用「系统默认编码」做 MD5（中文 Windows 上是 GBK），网页版固定 UTF-8 —— 中文 / emoji 密钥可能和 Java 端对不上，界面已提示尽量用英文 / 数字；原库遇到非法数字密钥会静默改用默认值，网页版改成明确报错。用错算法解 Sort / Random 时最后一行映射会越界，这里报中文错误（原库是数组越界异常）。

### 验证

- Node 单测 82 项全过：MD5 与 `node:crypto` 对拍、`Random(42)` 已知随机序列、8 种算法加解密可逆、PNG 编解码含 `alpha=0` 逐字节一致。
- 浏览器实测 28 项全过：首页入口、默认参数、行列 / Tomato / Sort / Random 端到端还原（逐像素对比 0 差异）、自写 PNG 解码器与 Chrome 编码器对拍、非法密钥提示、混淆方向、返回首页。
- 渐变测试图解混淆后与原图逐字节一致；`pnpm build` exit 0（67 模块）。

*涉及文件：`src/lib/imageObfuscation.ts`（新增）、`src/lib/pngCodec.ts`（新增）、`src/modules/ImageDeobfuscateModule.tsx`（新增）、`src/components/Home.tsx`、`src/App.tsx`*

---

## 2026-10-19 15:52 · 文件管理新增「公共文件池」：所有用户共享，配额记在上传者头上

文件管理顶部多了「我的文件 / 公共文件池」切换。池内是**一棵所有人共享的目录树**：任何登录用户都能新建文件夹、上传、改名、移动、删除，池内文件所有人可下载；上传消耗从**上传者自己的**个人配额里扣。

### 怎么实现（不加表、不跑线上迁移）

- 复用 `file_nodes`，用保留的 `user_id = 0` 表示池内节点（真实账号从 1 开始，AUTOINCREMENT 不会发 0）。线上不需要执行 schema —— 避开了上次 `user_quotas` 那种「先跑表再 push」的部署顺序风险。
- 池内内容 R2 key 用 `p/{nodeId}`，上传时写 `customMetadata.uploader`；删除 / 换人重传时按它把字节退给真正的上传者，所以配额账始终对得上。
- 客户端 `FileNode.scope`（缺省 private）区分区域；`listChildren/getStats/searchNodes` 按 scope 过滤；跨区拖动被 `moveNode` 拒绝（返回 `cross`）。
- 池内文件不开放免登录分享链接（本来所有登录用户可见），分享按钮禁用。

### 验证

- `pnpm build` exit 0。
- `_files-e2e.mjs` 32/32：新增 12 项覆盖跨账号可见、配额记上传者、换人重传退款、删除退款、墓碑、非法 scope。
- 浏览器实测：切区域 / 规则说明 / 新建文件夹 / 上传后同步 / bob 换浏览器可见 / 我的文件不混入 / 池内分享禁用。

*涉及文件：worker/index.ts、worker/r2.ts、worker/schema.sql（仅注释）、src/lib/fileCloud.ts、src/lib/fileStore.ts、src/lib/fileSync.ts、src/modules/FilesModule.tsx、src/components/GlobalSearch.tsx、src/App.tsx、src/types.ts、DeveloperLogs/数据接口文档.md*

---

## 2026-10-19 15:31–15:47 · 用户组管理：全员用量/登录 IP + 每账号配额与 10GB 上限

管理员登录后首页多一张「用户组管理」卡片（和常用工具、文件管理并列），进去能看到所有注册账号的**云盘用量、最近登录时间、IP、注册时间、文件/文件夹/分享数量**；普通用户没有这个入口，但首页会显示自己的一条「我的网盘用量」（已用 / 配额 + 进度条）。访客两者都看不到。

### 数据从哪来

- 用量：直接读 `file_usage`（和 `/api/files/usage` 同一个数，按 R2 对象真实大小维护），不每次 SUM 整棵树。
- 登录信息：新建 `login_records`（`user_id` 主键），登录 / 注册成功时 upsert。IP 优先取 `cf-connecting-ip`（Cloudflare 边缘写入、客户端伪造不了），本地 / 代理环境没有这个头时为空串。
- 文件数 / 文件夹数 / 分享数：三个相关子查询分别数 —— 不把两张一对多的表直接 JOIN，否则行数相乘、`COUNT` 会成倍虚高，而且很难第一眼看出错在哪。

### 为什么单独建一张表

SQLite 没有 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`，而 `schema.sql` 必须能重复执行：给 `users` 加列第二次跑就报 duplicate column。单独 `CREATE TABLE IF NOT EXISTS` 天然幂等。

### 安全与容错

- `GET /api/admin/users` 走 `requireAdmin`：未登录 401、普通用户 403；前端的 `isAdmin` 只决定入口显不显示，真正的权限在服务端。
- 写 `login_records` 整体 catch：代码先上线、建表还没跑时，登录 / 注册照常成功（否则全员登不进来）。代价是那段时间管理员接口会 500 —— **部署顺序必须先执行 schema.sql 再 push**。
- 响应里没有任何密码 / 哈希字段，查询只 SELECT 展示需要的列。

### 验证

- 后端等价环境 22 项断言全过：401/403/405、字段类型、IP 写入与更新、从未登录是 `null` 不是 0、用量与三项计数、表缺失时登录容错、schema 重复执行。
- 浏览器实测 23 项全过：管理员三卡三列 + 列表数据正确；普通用户有自己用量、无管理员入口；访客两者都没有；窄屏切换成卡片布局。
- `pnpm build` exit 0（64 模块）。

### 每账号配额 + 全站 10GB 上限（15:42 追加）

「开发者设置」里可以给每个账号单独设配额（单位 MB，0–10240），不设就用默认 500MB；「恢复默认」等于删掉覆盖行。全站总配额是 10GB —— 这是 Cloudflare R2 的免费额度，超出会按量计费，所以它同时是**实际用量的硬上限**，不只是页面上的一个数字。

- **存哪**：`user_quotas(user_id 主键, quota_bytes, updated_at)`。没有行 = 用默认值 —— 不把默认值存成行，将来调整默认值时，没自定义过的账号会自动跟着变。
- **上传两层校验**：个人 `used + delta ≤ 账号配额`、全站 `SUM(file_usage.bytes) + delta ≤ 10GB`；收流前按 `Content-Length`、收流后按 R2 真实大小各查一次；`delta ≤ 0`（重传更小文件 / 覆盖）不拦，否则超额账号连减小占用都做不到。
- **全站用量只 SUM `file_usage`**：`file_nodes.size` 里既有墓碑、又有客户端上传前猜的大小，拿它求和只会偏大。
- **接口**：`GET /api/admin/users` 返回 `{ defaultQuota, siteQuota, users[].quota }`；`PUT/DELETE /api/admin/users/{id}/quota` 修改 / 恢复，全部 `requireAdmin`。超个人 `413 quota-exceeded`（文案带该账号真实上限），超全站 `413 site-quota-exceeded`。
- **已分配额度之和超过 10GB 时只警告、不拦配置**：额度是上限不是预留，真正触发拒绝的是实际用量。管理员把某人配额调到低于已用量也不会删文件，只拦后续增长。
- ⚠️ `user_quotas` 表缺失时上传会 500（这一点比 `login_records` 严格），**必须先执行 schema.sql 再 push**。

验证：后端 65 项断言（含配额 PUT/DELETE、非法值、个人/全站超限、schema 幂等）+ 文件接口回归 22 项；浏览器 37 项全过（10GB 概览、保存/恢复默认/非法输入、普通用户读到新配额、窄屏）。`pnpm build` exit 0（64 模块）。

*涉及文件：`worker/schema.sql`、`worker/index.ts`、`src/types.ts`、`src/lib/userAdmin.ts`（新增）、`src/modules/UserAdminModule.tsx`（新增）、`src/components/Home.tsx`、`src/App.tsx`、`src/lib/fileCloud.ts`、`DeveloperLogs/数据接口文档.md`*

---

## 2026-10-19 14:55 · 文件管理上云：R2 存内容 + D1 存目录树 + 公开分享链接

文件管理从「只存在这台电脑的浏览器里」变成「登录后自动同步到云端」，并支持给单个文件生成公开分享链接。换设备登录同一账号能看到全部文件和目录；断网时照常新建 / 改名 / 移动 / 删除，联网后自动补传。

### 三层各管什么

| 层 | 存什么 | 为什么 |
| --- | --- | --- |
| R2（`bupt-bettertools-files`） | 文件内容（二进制），key = `u/{userId}/{nodeId}` | 出站流量免费、容量够，二进制不该塞进数据库 |
| D1（`file_nodes` / `file_usage` / `file_shares`） | 目录树名册、每人已用字节、分享 token | 目录树不放进快照：快照是整包 256KB 覆盖，改一个文件名要重传全部 |
| IndexedDB | 本机缓存 + 待上传队列（`outbox`） | 离线优先，本地永远先落盘，云端只是"稍后传一份" |

桶**不公开**：读、写、删都过 `/api/files/*`，鉴权复用现有会话令牌。

### 同步怎么做

- 写操作先写 IndexedDB，再往 `outbox` 排一条；`online` / 页面活动时按顺序推。
- 拉取是整棵目录树（含**墓碑**）：别的设备删掉的东西，本机下次拉树时才知道"它没了"，否则会被当成本地新增又传回去，删了又活。
- 冲突只可能发生在同一节点被两台设备改：服务端按到达顺序 LWW，客户端收到就覆盖本地；不做字段级合并（合并出错是静默的）。
- 首次登录会把本机**登录前就有的老文件**自动迁移上去（本地有、云端没有 → 重新入队，父节点先传、内容跟着传）。

### 两个必须记住的坑

**① 配额不能信客户端报的 size。** 客户端在传内容之前会先推一份"猜测的大小"用于列表显示。第一版上传接口拿 `node.size` 算差值，结果第一次上传永远算出负增量，`file_usage` 一直记 0。改成以 **R2 对象真实大小**为准（上传前 `head` 旧对象、删除时 `head` 再退字节）之后才对。这个 bug 只有真的跑过接口才会暴露出来。

**② 换账号必须清本机缓存。** IndexedDB 是按浏览器存的、不按账号。A 退出 B 登录后，A 的文件会被当成"本地孤儿"直接上传进 B 的账号（静默泄漏）。所以 `localStorage` 记一个 `better-tools:files-owner`，主人变了先 `resetFileStore()`；第一次没有标记**不清**，那正好是迁移老文件。

### 分享链接

`POST /api/files/shares` 生成 32 位 hex token，公开地址 `/api/share/{token}`，无需登录。安全上做了三件事：**类型白名单**决定 inline 还是 attachment（HTML / SVG 一律强制下载，避免同源 XSS）；`x-content-type-options: nosniff`；`content-security-policy: default-src 'none'; sandbox`。删除节点会顺带撤销它的分享，链接立即失效。

### 部署前必须先做（不然 deploy 会失败）

1. 建 R2 桶：`npx wrangler r2 bucket create bupt-bettertools-files`（或控制台创建）。
2. 对线上库执行新表：`npx wrangler d1 execute bupt-bettertools-sync --remote --file=worker/schema.sql`。
   顺序不能反：先建桶再 push，否则自动构建在 `wrangler deploy` 这一步失败（线上会停在上一版，不会挂，但改动上不去）。

*涉及文件：`worker/index.ts`、`worker/schema.sql`、`worker/r2.ts`、`worker/d1.ts`、`wrangler.jsonc`、`src/lib/fileCloud.ts`、`src/lib/fileSync.ts`、`src/lib/fileStore.ts`、`src/hooks/useFileSync.ts`、`src/modules/FilesModule.tsx`、`src/App.tsx`*

## 2026-10-19 14:37 · 修复卡片「详情/收藏」按钮压住备注文字

卡片右上角的 ⓘ 和 ☆ 是绝对定位浮在卡片上的（`top-11 right-2`），而备注紧跟在图标行下面开始排，第一行文字正好从按钮底下穿过去，被挡住一半。

### 怎么改的

给备注 `<p>` 加 `pr-16`（右侧预留 64px），文字到按钮左边缘前就折行/截断，不再钻到按钮下面。备注仍是 `line-clamp-2` + `min-h-10`，两行截断和卡片等高这两条都不受影响。

### 为什么不动按钮位置

按钮原来特意放在图标行**下方**（`top-11`），就是为了让标题独占整行宽度、长标题不提前换行。把按钮挪回标题行能解决重叠，但会把长标题挤成两行 —— 捡了芝麻丢西瓜。只给备注留空是影响面最小的改法。

*涉及文件：`src/components/ToolCard.tsx`*

## 📚 历史归档

> 更早的 19 条已移到 [`archive/NewFunctions-2026-10.md`](archive/NewFunctions-2026-10.md)。
> 需要查历史时再打开，不要每次读完。

- 2026-10-19 10:35 · 访客预览模式：不登录也能看，但只能看
- 2026-10-18 23:45 · 多用户账号体系：用户名密码登录 + 邀请码注册 + 管理员面板
- 2026-10-18 23:26 · AI 对话协作层 a2a-communicator
- 2026-10-18 22:46 多端数据同步：Cloudflare Worker + D1 后端 + 前端同步引擎
- 2026-10-18 22:00 修复手机端标题与按钮的排版冲突
- 2026-10-18 21:44 · 部署上线到 Cloudflare Workers + 页脚小字改写
- 2026-10-16 16:22 · 运行环境整理：pnpm 配置搬家 + 启动脚本去掉写死的 DSH 路径
- 2026-10-16 16:10 · 工具卡片对齐修复 + 详情面板（ⓘ）
- 2026-10-16 16:01–16:22 · 全局搜索：一个关键词同时搜「工具」和「文件」
- 2026-10-15 18:40 · Google 风格视觉改版 + 跟随系统的深浅模式
- 2026-10-15 08:18 · 「通用设置」面板 + 打开时的默认分组
- 2026-10-15 08:10 · 默认清单自动同步 + 新增 3 个工具
- 2026-10-12 14:13–14:18 · 多模块架构 + 文件管理
- 2026-10-12 13:39 · 教务链接新增与「补充默认清单」
- 2026-10-12 13:01 · 分组标签拖拽排序
- 2026-10-10 11:07–11:09 · 「开发者设置」面板
- 2026-10-10 10:49–11:03 · 「编辑分组」与工具管理
- 2026-10-10 10:36 · 工具卡片拖动排序
- 2026-10-10 10:15–10:19 · 小改动合并：新增「教务」分组 +「学习」加入洛谷
