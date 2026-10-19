# New Functions

> 本文件记录每次新增功能的**简要说明**与**添加时间**。
> 维护约定：
> - 新条目追加到**顶部**（最新的在最上面）。
> - **小改动合并成一条**（例如新增分组、新增网站链接）。
> - **功能相近的改动合并进同一条，作为子项**（例如"编辑工具"的几种入口、跨分组移动的几种拖法）。
> - 只有**功能独立、体量较大**的才单独开一条（例如卡片拖动排序）。
> - **只留最近 5 条**：更早的移到 `DeveloperLogs/archive/`，文末留索引（避免每个新对话都整篇重读）。

---

## 2026-10-19 10:35 · 访客预览模式：不登录也能看，但只能看

登录页多了一个「👀 访客预览，先随便看看」按钮。不登录也能进网站浏览工具和文件，
但**一切写操作都被挡住**，页面顶部常驻一条「只能查看，不能修改」的横幅。

### 为什么要有这个功能

之前是"不登录什么都看不到"。想给朋友看一眼或自己换台设备瞄一眼，都得先注册个账号 ——
门槛太高。但直接放开又等于谁都能改。所以拆成两件事：**看**不需要身份，**改**需要。

### 只读是怎么保证的：两层，谁都不依赖谁

**第一层（真正管用的）：数据层硬拦截。**
所有会写数据的函数，入口第一行就是 `if (isGuest()) return` —— 23 处，覆盖
工具增删改、分组、收藏、排序、通用设置、开发者参数、文件的新建/上传/改名/删除/移动，
以及"云端数据写回本地"那一个入口。文件相关的写操作直接**抛错**（比静默返回诚实）。

为什么不能只靠界面禁用按钮：**忘了禁用的地方是静默的** —— 用户点一下就把数据改了，
没有任何报错，也没有任何日志。漏一个就是一个洞。

**第二层（让人知道为什么点不动）：界面禁用 + 常驻横幅。**
按钮加 `disabled` + `title="访客预览模式不能修改"`；顶部横幅一直说明"只能查看"。
没有横幅的话，访客过一会儿就忘了自己没登录，只会以为网站坏了。

### 两个实现细节

**① 访客不走"等云端同步"那一步。** 原来的门禁是「没登录 → 登录页；登录了但云端没拉完 → 过渡页」。
访客没有会话，`syncNow` 本来就是空转，让他对着「正在同步你的云端数据…」干等最长 10 秒纯属莫名其妙。
所以判断顺序改成：先看登录态，再看到底是不是访客。

**② 登录成功后必须清掉访客标记。** 标记存在 localStorage（所以刷新后还在访客态）。
如果登录后不清，下次刷新、会话又刚好过期时，用户会被当成访客放进来、还挂着只读横幅 ——
明明登录过却什么也改不了，而且看不出原因。

### 验证

浏览器实测 11 项全过：

- 登录页有入口 → 点进去直接到主界面 + 顶部横幅 → localStorage 记下标记
- 访客点收藏 → 数据没变（0 → 0）
- 文件管理「新建文件夹」「上传文件」都是 `disabled`
- **刷新后仍在访客态**（不会弹回登录页）
- 点「去登录」→ 回到登录页 + 标记清除
- `pnpm build` exit 0（59 个模块）

### 顺手修的另一个 bug

`FilesModule` 的 `refresh()` 原来每次都把列表切成骨架屏，而上传/改名/删除/移动之后也会调它 ——
**上传一个文件就整页闪一下**，像是页面重载了。加了 `refresh(id, { silent: true })`，
只有"首次进入 / 切换文件夹"才显示骨架屏。

*涉及文件：`src/lib/guestMode.ts`（新增）、`src/hooks/useGuest.ts`（新增）、`src/components/GuestBanner.tsx`（新增）、`src/App.tsx`、`src/components/AuthScreen.tsx`、`src/hooks/useTools.ts`、`src/hooks/useFavorites.ts`、`src/hooks/useToolOrder.ts`、`src/hooks/useAppSettings.ts`、`src/hooks/useDevSettings.ts`、`src/lib/fileStore.ts`、`src/lib/syncData.ts`、`src/modules/ToolboxModule.tsx`、`src/modules/FilesModule.tsx`、`src/components/GeneralSettingsPanel.tsx`、`src/components/DevSettingsContent.tsx`*

---

## 2026-10-18 23:26 · AI 对话协作层 a2a-communicator

工作区里同时开着好几个 AI 对话，共用同一套文件。真实踩过一次：另一个对话往本文件顶部插条目时，
把刚写好的**条目标题整行覆盖**掉了，而且 `git diff` 还看不出来（那条改动本来就没提交过）。
所以建了一个专门给对话之间留消息的地方。

**结构**（`a2a-communicator/`）：

- `README.md` —— 协议：目录约定、消息格式、五条读写纪律
- `CONTRACT.md` —— 接口契约：从《数据接口文档》摘出 UI 侧速查表，定义数据状态语义，记录接口变更
- `STATUS.md` —— 状态板：谁在等谁、哪条还开着
- `inbox-ui/` `inbox-core/` —— 单向收件箱（各写各的，绝不混写）

**防覆盖的核心设计**：一条消息 = 一个独立文件（文件名带时间和序号），而不是往同一个文件里追加。
两个 agent 同时写同一文件必然互相覆盖，**独立文件天然免疫**。另外规定：只写自己方向的收件箱、
只改自己消息的状态、改契约要先发 `contract` 消息。

**给 UI 侧的实际收益**：`CONTRACT.md` 把「界面需要知道的」和「数据实际长什么样」对齐了 ——
Tool / FileNode 的字段、六个 Hook 的返回值、必须 `await` 的异步接口、哪些设计令牌可以复用；
还立了一条规矩：**登录/同步的错误应由后端给现成中文文案**，不让 UI 在组件里判错误码
（否则每加一个错误码都要回来翻组件）。

*涉及文件：`a2a-communicator/README.md`（新增）、`a2a-communicator/CONTRACT.md`（新增）、`a2a-communicator/STATUS.md`（新增）、`a2a-communicator/inbox-core/2026-10-18-2325-ui-001-hello.md`（新增）*

---

## 2026-10-18 23:45 · 多用户账号体系：用户名密码登录 + 邀请码注册 + 管理员面板

网站从「一个人的工具箱」变成了「有账号的工具箱」：打开先登录，注册要管理员发的邀请码。
每个账号有自己的云端数据，互相看不见。

### 为什么要做账号

之前是一串共享令牌 —— 谁拿到那串就能读写全部数据，而且只有一个人能用。
要支持"不同用户"，身份必须由服务端认定：浏览器没法自己证明"我是谁"。

### 三个关键设计

**① 密码只存哈希，且用定长时间比较。**
注册时：随机 16 字节盐 + PBKDF2-SHA256 迭代 10 万次 → 存 hash。
登录时用同样的盐和次数再算一遍。为什么不用 `a === b`：普通比较会在第一个不同字符处提前返回，
攻击者能从响应耗时里一位一位试出来。

**为什么是 10 万次而不是更高**：Workers 免费版每次请求只有 10ms CPU 预算，迭代越高越可能超时（1102）。
10 万是免费版上能跑的安全上限附近。次数存在 `users.iterations` 里 ——
以后升付费版可以直接提高，**老账号按自己那一行记的次数校验，不用重设密码**。

**② 会话令牌：服务端只存 sha256。**
登录返回 64 位 hex 令牌，库里只存它的 sha256。整张 sessions 表被拖走也拼不出能用的令牌。有效期 30 天。

**③ 邀请码"占码"靠数据库的原子性。**

```sql
UPDATE invites SET used_at = ? WHERE code = ? AND used_by IS NULL
```

只有 `changes === 1` 的请求才能继续建账号 —— 两个请求同时用同一个码只会有一个成功。
另外注册顺序刻意是「先查重名、再占码」：反过来的话，用户填个被占用的名字会**白烧掉一张邀请码**。

### 数据库迁移

旧库是单用户结构（`snapshot` 永远只有 id=1 一行），新结构每个用户一行（`user_id` 主键）。
SQLite 没有"有条件的 DDL"，所以迁移写成可重复执行的四步：
先按旧结构保证表存在 → 建 `snapshot_v2` → `INSERT OR IGNORE ... SELECT *`（两表都是 4 列同序）→
`DROP` 旧的 → `RENAME` 回去。**旧的 33 个工具 + GitHub 收藏全部挂到管理员名下，实测没丢。**

### 管理员与邀请码界面

- 管理员：`EpiphanyMio`（`users.is_admin = 1`）
- 邀请码管理放在「通用设置 → 开发者设置」里，**只有管理员才渲染**（非管理员连 DOM 都不存在）
- 前端故意留死：没有"把某人提升为管理员"的入口，要加只能改 SQL

### 验证

- 后端等价环境 **62 项断言全过**：未登录 401 / 登录 / 错误密码 / 权限 403 / 发码 / 复用码 403 /
  数据隔离 / 409 乐观锁 / 迁移幂等 / 大小写重名 / 各种边界
- 线上接口 **18 项实测全过**：管理员登录、**旧数据完整回来（33 工具 + GitHub 收藏）**、
  生成邀请码、用码注册、数据隔离、401/403、登出后令牌失效
- 线上浏览器实测：管理员能看到并生成邀请码；
  **用邀请码注册的普通账号在开发者设置里完全看不到邀请码区块**（连标题都没有）
- `pnpm build` exit 0（56 个模块）

### 顺手修掉的两处过期文案

页脚原来写"工具和文件只存在这台设备的浏览器里，不会上传"、分组编辑器里写"不会上传到服务器" ——
加了账号体系之后这两句已经不符合事实，改成"登录后会同步到你的账号云端，文件只存在这台设备"。

*涉及文件：`worker/index.ts`、`worker/auth.ts`（新增）、`worker/d1.ts`（新增）、`worker/schema.sql`、`worker/README.md`、`src/lib/auth.ts`（新增）、`src/hooks/useAuth.ts`（新增）、`src/components/AuthScreen.tsx`（新增）、`src/components/InviteAdmin.tsx`（新增）、`src/lib/sync.ts`、`src/components/SyncSettings.tsx`、`src/components/DevSettingsContent.tsx`、`src/components/Home.tsx`、`src/components/GroupEditor.tsx`、`src/App.tsx`、`src/types.ts`*

---

## 2026-10-18 22:46 · 多端数据同步：Cloudflare Worker + D1 后端 + 前端同步引擎

手机和电脑现在可以共用同一份数据了。在「通用设置 → 云端同步」里填一次令牌，
之后工具增删改、分组、收藏、排序、默认分组都会自动同步，另一台设备打开就能看到。

### 为什么必须要有后端

浏览器的安全模型就是不让一个站点的 localStorage 流向另一台设备。要跨设备共享，
必须有一个双方都能访问的中间人 —— 那就是后端。没有"纯前端"的做法。

### 三个关键设计

**① 整包快照，不做字段级合并。** 云端 D1 里只有一张表、一行数据（`snapshot` 的 id 永远是 1）。
全部数据才十几 KB、又是单用户；拆表就要处理"两台设备各改一条"的合并规则，
而合并规则写错是**静默**的 —— 数据被揉在一起，用户不知道从哪一步开始错的。
单行快照把冲突简化成一个数字比较，行为可预测。

**② 乐观锁：版本号塞进 WHERE，而不是"先查再改"。**

```sql
UPDATE snapshot SET revision = revision + 1, ... WHERE id = 1 AND revision = ?baseRevision
```

别人先写过 → 这行匹配不到 → `changes === 0` → 回 409 并带回当前快照。
为什么不能先 SELECT 再 UPDATE：查完到改之间别的请求可能已经写进去了，
那个空档就是数据被覆盖的地方。判断和写入由数据库一句完成，中间没有缝。

**③ 离线优先：同步是加分项，不是运行前提。**

点收藏 → 立刻写 localStorage（界面马上响应）→ 后台防抖 1.5 秒再推。
网络断了、服务器挂了，网站照常完整可用；恢复网络后自动补一次。

### 鉴权与安全

- 一个人用的服务，不做注册登录：一个长随机串当令牌，只走 `wrangler secret put`
- **先鉴权再解析 body**：没令牌的请求连 256KB 都不该让我们解析（Worker 按调用计费）
- 令牌用**定长时间比较**：直接 `a === b` 会在第一个不同字符处提前返回，
  攻击者能从响应耗时差里一位一位试出令牌

### 两个容易踩的坑

**① SPA 回落会抢在 Worker 前面。** `assets` 里配了"找不到文件就回落 index.html"，
这条规则会把 `/api/snapshot` 也吃掉，浏览器拿到一整页 HTML，前端 `res.json()` 只抛一句看不懂的语法错误。
修法是在 assets 里加 `"run_worker_first": ["/api/*"]`，让接口路径先交给 Worker。
（本地测试走 Vite 代理、不经过静态资源层，所以这个问题只有真正部署才会暴露。）

**② 这台机器上 `wrangler dev` / `d1 execute` 起不来。** workerd 建不了自己的临时目录
（`kj/filesystem CreateDirectory: 拒绝访问`），是环境限制不是代码问题 ——
`wrangler deploy --dry-run` 能正常打包（读 116 个资源文件、识别 D1 绑定）。
所以验证改用 `scripts/_sync-e2e.mjs`：真 HTTP + 真 `node:sqlite` + 直接 import 真实的 `worker/index.ts`
（`scripts/_*` 已 gitignore，不进仓库）。

### 验证

- **接口层 12 项断言全过**：401 / 空云端 / 首次写入 / 数据一致 / 409 冲突 / 过期版本写入 /
  形状非法 / 超 500 条 / 未知路径 404 / OPTIONS 204 / 方法不支持 405
- **浏览器端到端 6 项全过**：填令牌 → 状态变「已同步」→ 33 个工具推上云端 → 收藏后自动上传 →
  **清空本地模拟换设备 → 数据从云端恢复，界面也真的变回「已收藏」**
- `pnpm build` exit 0（52 个模块）

### 已经真正部署上线

- D1 库 `bupt-bettertools-sync`（`0fc7584c-…`），表已建
- `SYNC_TOKEN` 已设进 Cloudflare secret（48 位十六进制；**只写在 `scripts/_sync-token.txt`，已 gitignore**）
- Worker 已部署：<https://bupt-bettertools.yuesu76.workers.dev/>
- 线上实测：不带令牌 → 401；带令牌 → 200 且 `data: null`；`content-type: application/json`
  （证明 `run_worker_first` 生效，`/api/*` 没被 index.html 顶掉）

**上线时踩到的两个坑**：

1. 有个并行对话往 `wrangler.jsonc` 里加**第二个 D1 绑定**（`binding: bupt_bettertools_sync`），
   而原来那个 `DB` 还是占位 id —— 多绑了个没人用的库，部署照样失败。已整理成单绑定。
2. 第一次生成令牌用了 `[RandomNumberGenerator]::GetBytes` + `[Convert]::ToHexString`，
   这个 PowerShell 里**两个方法都不存在**，`$token` 是空串 → secret 被设成空值 →
   Worker 是 fail-closed 的，于是所有请求 401。改用 `node -e "crypto.randomBytes"` 重新生成并覆盖。

### 跨设备实测（线上站点，两个全新浏览器配置）

- 设备 A（桌面尺寸）：填令牌 → 已同步 → 33 个工具上云（revision 1）→ 收藏「GitHub」→ 自动上传（revision 2）
- 设备 B（手机尺寸、全新配置、初始无收藏）：填令牌 → **收藏自动写回本地，界面里 GitHub 真的显示「已收藏」**

*涉及文件：`worker/index.ts`（新增）、`worker/schema.sql`（新增）、`worker/README.md`（新增）、`wrangler.jsonc`、`src/lib/sync.ts`（新增）、`src/lib/syncData.ts`（新增）、`src/hooks/useSync.ts`（新增）、`src/components/SyncSettings.tsx`（新增）、`src/types.ts`、`src/App.tsx`、`src/hooks/useTools.ts`、`src/hooks/useFavorites.ts`、`src/hooks/useToolOrder.ts`、`src/hooks/useAppSettings.ts`、`src/lib/constants.ts`、`src/modules/ToolboxModule.tsx`、`src/components/GeneralSettingsPanel.tsx`、`vite.config.ts`、`package.json`、`pnpm-workspace.yaml`、`.gitignore`*

---

## 2026-10-18 22:00 · 修复手机端标题与按钮的排版冲突

手机上进入「常用工具」后，标题「🔗 常用工具」被压成一条竖线，右边那排按钮还撑出了屏幕。

**根因**是 flex 布局的一个基本行为：头部是 `flex justify-between`，左右两块并排；
右边那组按钮写了 `shrink-0`（**不许收缩**），于是空间不够时，压缩的只有左边 ——
标题从 6 个字被挤到只剩 40px 宽、逐字换行；而按钮行本身要 319px，
在 320px 的屏上直接溢出 88px。

修复前实测（375px 视口）：`h1` 宽 **40px**、`header` 的 scrollWidth 376 > clientWidth 343、
按钮行右边界跑到 392（超出屏幕）。

**修法**：窄屏上下排列，宽屏才左右分栏。

- 容器：`flex items-start justify-between` → `flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between`
- 标题块：加 `min-w-0` —— flex 子项默认 `min-width: auto`，不加还是会被内容顶住、不肯缩到内容以下；
- 按钮行：`shrink-0` 换成 `flex-wrap`，宽屏时才 `sm:shrink-0`，这样最窄的屏上按钮会折成两行而不是溢出。

「文件管理」的头部结构一模一样，在 320px 下标题同样被挤（`h1` 只有 121px、折成两行），一并改掉。

**修复后实测**（320 / 375 / 1280 三档 × 两个模块，共 16 项全部通过）：

| 视口 | 标题尺寸 | 按钮 | 横向溢出 | 排列 |
| --- | --- | --- | --- | --- |
| 320 | 288×36（占满一行） | 折成 2 行 | 无 | 上下 |
| 375 | 343×36 | 1 行 | 无 | 上下 |
| 1280 | — | 1 行 | 无 | 左右分栏（桌面不受影响） |

*涉及文件：`src/modules/ToolboxModule.tsx`、`src/modules/FilesModule.tsx`*

---

## 📚 历史归档

> 更早的 14 条已移到 [`archive/NewFunctions-2026-10.md`](archive/NewFunctions-2026-10.md)。
> 需要查历史时再打开，不要每次读完。

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
