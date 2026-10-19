# New Functions 归档 · 2026-10

> 旧条目正文放在这里，**需要查历史时按需打开**，不要在新对话里整篇读。
> 主文件（只留最近 5 条）：[`../New Functions.md`](../New%20Functions.md)

## 目录

1. 2026-10-18 23:26 · AI 对话协作层 a2a-communicator
2. 2026-10-18 22:46 多端数据同步：Cloudflare Worker + D1 后端 + 前端同步引擎
3. 2026-10-18 22:00 修复手机端标题与按钮的排版冲突
4. 2026-10-18 21:44 · 部署上线到 Cloudflare Workers + 页脚小字改写
5. 2026-10-16 16:22 · 运行环境整理：pnpm 配置搬家 + 启动脚本去掉写死的 DSH 路径
6. 2026-10-16 16:10 · 工具卡片对齐修复 + 详情面板（ⓘ）
7. 2026-10-16 16:01–16:22 · 全局搜索：一个关键词同时搜「工具」和「文件」
8. 2026-10-15 18:40 · Google 风格视觉改版 + 跟随系统的深浅模式
9. 2026-10-15 08:18 · 「通用设置」面板 + 打开时的默认分组
10. 2026-10-15 08:10 · 默认清单自动同步 + 新增 3 个工具
11. 2026-10-12 14:13–14:18 · 多模块架构 + 文件管理
12. 2026-10-12 13:39 · 教务链接新增与「补充默认清单」
13. 2026-10-12 13:01 · 分组标签拖拽排序
14. 2026-10-10 11:07–11:09 · 「开发者设置」面板
15. 2026-10-10 10:49–11:03 · 「编辑分组」与工具管理
16. 2026-10-10 10:36 · 工具卡片拖动排序
17. 2026-10-10 10:15–10:19 · 小改动合并：新增「教务」分组 +「学习」加入洛谷

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

## 2026-10-18 21:44 · 部署上线到 Cloudflare Workers + 页脚小字改写

网站现在已经发布到公网：

**<https://bupt-bettertools.yuesu76.workers.dev/>**

托管方式是 Cloudflare Workers 的静态资源托管 —— 把 `pnpm build` 出来的 `dist/` 整个目录传上去就行。
没有后端、没有数据库，传上去的就是几个静态文件。

### 为什么页脚那句话必须改

原来写的是：

> 所有数据都存在这台电脑的浏览器里，没有上传到服务器 · 阶段 1

这句话在**没上线**时没问题。上线之后它有了歧义：读者会把"没有上传到服务器"理解成**整个网站**，
而网站现在明明就在服务器上。原意其实只在说**你的数据**（工具清单、上传的文件）没有上传。

所以改成把两件事分开讲：

> 网站托管在 bupt-bettertools.yuesu76.workers.dev · 工具和文件只存在这台设备的浏览器里，不会上传

顺带两处小修：

- 「这台电脑」→「这台设备」：这个站手机也要用，原先的说法把手机用户排除在外了；
- 去掉「· 阶段 1」：那是开发期的内部标注（对应路线图第一阶段），对来访者没有意义，
  而且阶段信息本来就记在 `AGENTS.md` 和 `README.md` 里，不必在界面上重复。

*涉及文件：`src/components/Home.tsx`*

---


## 2026-10-16 16:22 · 运行环境整理：pnpm 配置搬家 + 启动脚本去掉写死的 DSH 路径

起因是查一个"pnpm 和 npm 的设置问题"，查出四件事叠在一起。

### pnpm 的专有配置从 .npmrc 搬到 pnpm-workspace.yaml

`.npmrc` 是 npm 和 pnpm **共用**的配置文件，而 `store-dir` / `cache-dir` / `nodeLinker` 是 pnpm 专有的。
结果每次在项目里跑 npm 都会连报三条 `npm warn Unknown project config`，并提示"npm 12 起会直接报错"。

搬到新建的 `pnpm-workspace.yaml`（pnpm 10 起官方推荐的设置位置，npm 根本不读这个文件），键名相应改成驼峰。
顺带把写死的绝对路径 `store-dir=D:/Users/ROG/.../BetterTools/.pnpm-store` 改成相对路径 `storeDir: .pnpm-store`
—— 实测 `pnpm store path` 仍解析到原来的位置，没有重复下载，但项目以后挪地方也不会失效。

`package.json` 里补了 `"packageManager": "pnpm@11.7.0"`，和 DSH 内部用的版本一致。

**意外发现**：pnpm 9 之后默认开启"按 `packageManager` 字段自动切换版本"。测试时把它临时改成 `pnpm@9.0.0`，
pnpm 真的去下载了 9.0.0 并用它来跑（在 `.pnpm-store` 里能看到）。好处是不管全局装的是哪个 pnpm，
这个项目都会用声明的那一版，不会再出现"我这边能构建、你那边报错"。

### 启动脚本不再写死 DSH 的路径

以前 Node 和 pnpm 都不在 PATH 上，脚本里写死了：

```
C:\Users\ROG\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe
C:\Users\ROG\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs
```

DSH 客户端一升级、安装目录一变，桌面快捷方式就找不到运行环境。现在全局装了 pnpm，
脚本直接用 PATH 上的 `pnpm.cmd`，找不到时弹窗提示"先执行 npm i -g pnpm"。
项目目录也从 `$PSScriptRoot` 推出来，不再写死。

**顺带修掉一个真实隐患**：加了 `--strictPort`。以前 5173 被别的程序占用（比如另一个没关掉的开发服务器），
Vite 会**悄悄换到 5174**，而脚本和浏览器用的都还是 5173 —— 两边对不上。
现在端口被占会当场弹窗说清楚，而不是白等 90 秒超时。

**为什么这个脚本必须是 UTF-8 带 BOM**：快捷方式是用 Windows PowerShell 5.1 跑的，
它读没有 BOM 的 `.ps1` 会按系统 ANSI 编码解码，中文注释会变乱码、甚至破坏语法。

*涉及文件：`.npmrc`、`pnpm-workspace.yaml`（新增）、`package.json`、`scripts/open-toolbox.ps1`*

---


## 2026-10-16 16:10 · 工具卡片对齐修复 + 详情面板（ⓘ）

### 卡片对齐：简介行数不再影响排版

原来同一行的卡片高低不一、分组药丸参差不齐 —— 根因是**卡片内部没有撑开**：
网格虽然会把卡片拉到等高的外框，但卡片里那个 `<a>` 还是内容高度（`display: block`），
所以简介一行、两行、三行的卡片，底部的药丸和留白都落在不同高度上。

修法是三条配合（缺一条都会重新错位）：

1. 卡片根元素改 `flex flex-col h-full` —— 纵向排列，并撑满网格给的高度；
2. 中间那个 `<a>` 加 `flex-1` —— 把剩余高度全部吃掉，空白被推到最底；
3. 分组药丸加 `mt-auto` —— 钉在卡片底部，于是不管上面简介几行，药丸都在同一条水平线上。

另外简介加 `line-clamp-2`（最多两行，超出显示省略号）+ `min-h-10`（固定两行高度），
这样简介是一行还是两行，占的高度都一样 —— 这是等高的另一半保证。

**实测验证**（无头浏览器测量每张卡片的像素坐标，33 张卡片 / 11 行）：
卡片底边差 **0px**、药丸顶边差 **0px**、卡片高度差 **0px**，全部完全对齐。

顺带修了一个连带问题：详情/收藏按钮原来占掉了卡片名右侧一大片宽度（`pr-20`），
导致「现代 JavaScript 教程」「freeCodeCamp 中文」这类长名提前折行、把名称行撑成两行高。
改成按钮下移到图标行下方（`top-11`）、名称独占整行宽度后，**33 张卡片的名称全部单行显示**。

### 新增：卡片右上角 ⓘ 打开详情面板

卡片位置有限，简介被截成两行、网址只是个可点链接。新增**详情面板**负责"看全"：

- 完整图标 / 名称 / 所属分组 / 收藏状态；
- **完整简介**（详情页里不做行数限制）；
- **完整网址**，等宽字体、可整段选中，配一个「复制」按钮（复制成功后按钮短暂变成「✓ 已复制」）；
- 底部主操作「打开链接 ↗」。

**职责划分**：详情面板只负责"看"和两个最常用动作（打开、复制），
编辑 / 删除仍然留在卡片右下角的 ✎ 菜单里，两边不重叠。
面板同样支持按 Esc 关闭、点遮罩关闭、打开时锁住背景滚动（与项目里其它弹窗行为一致）。

**按钮样式选择**：用圆形 ⓘ 图标按钮（Google 产品里右上角那一排就是这种圆形图标按钮），
悬停时淡主色底 + 主色文字。ⓘ 是"信息"的标准符号，比写"详情"两个字省地方，
也不会在窄卡片上挤压名称。收藏按钮紧挨在它右边，两个按钮尺寸统一（32×32），视觉成对。

*涉及文件：`src/components/ToolCard.tsx`、`src/components/ToolDetailModal.tsx`（新增）、`src/modules/ToolboxModule.tsx`*

---


## 2026-10-16 16:01–16:22 · 全局搜索：一个关键词同时搜「工具」和「文件」

以前找东西得先想清楚"它在工具箱还是文件管理里"，再进对应模块、用那个模块自己的搜索框。
现在多了一个**跨模块的搜索浮层**：任意界面按 `Ctrl+K`（Mac 是 `⌘K`）或 `/` 就能唤起，首页顶部也放了一个显眼的入口。输入一个关键词，工具和文件的结果一起出来。

**为什么做成浮层**：搜索是"突然想起来有个东西、想马上找到"的临时操作，找到就走。做成常驻页面的话，用户得先退回首页、搜完再回到原来的地方。

**搜什么**：工具匹配名称、备注、分组名、网址四个字段（数据在 localStorage，打开浮层时读一次）；文件按文件名匹配，文件夹也算在内（数据在 IndexedDB，异步查，防抖 140ms —— IndexedDB 每次查询要把整张表读出来，打字时不能每敲一个字查一次）。

**排序用打分**：名称以关键词开头（0 分）< 名称包含（1 分）< 分组（2 分）< 网址（3 分）< 备注（4 分）。为什么不用"匹配上就行"：搜 `git` 时，名字叫「GitHub」的应该排在"备注里提到 github"的前面。用一个数字表示命中在哪个字段，排序就成了一行代码。

**高亮不拼 HTML**：命中的字用 `<mark>` 标出来。实现是把文字切成 `[{text, hit}]` 数组交给 React 渲染，而不是拼一段 HTML 配 `dangerouslySetInnerHTML` —— 后者遇到名字里带 `<script>` 的文件就会执行。切成数组，文字永远只是文字。

**键盘**：`↑` `↓` 在"工具 + 文件"拼成的**平铺列表**里前后移动（到底绕回开头），`Enter` 打开，`Esc` 关闭。两组结果共用一个 `activeIndex`，不必分别记"工具组选到第几个、文件组选到第几个"。

### 子项 · 三个入口

| 位置 | 触发方式 |
| --- | --- |
| 任意界面 | `Ctrl+K` / `⌘K`，或直接按 `/` |
| 首页 | 顶部一个"看起来像输入框"的按钮 |
| 工具箱 / 文件管理 | 头部 🔍 按钮 |

`/` 只在焦点不在输入框里时才生效 —— 否则用户想在备注里打个斜杠都打不出来。

### 子项 · 文件结果能直接打开，文件夹能跳过去

- 能预览的（图片、PDF、文本…）→ 新标签页打开
- 不能预览的（Word、压缩包…）→ 直接下载，免得开出一个空白页
- 每行右侧另有 `⬇` 单独下载
- **文件夹** → 切到文件管理并直接打开那个目录

跨模块跳转用了一个带序号（`seq`）的请求对象放在 `App.tsx` 上：同一个文件夹连点两次，只有 `seq` 变了，`FilesModule` 才知道"又收到一次新请求"。

**顺手做的重构**：打开 / 下载文件的代码原本只写在 `FilesModule` 里，现在抽到 `src/lib/fileActions.ts` 给两处共用。其中有个容易踩的坑 —— `blob:` 地址不能马上 `revokeObjectURL`，新标签页还在按它加载内容，得留 60 秒。这种细节复制两份迟早会改漏一处。

### 子项 · 16:22 Esc 的分层处理

搜索浮层随时能唤起，用户可能正开着「工具详情」时按 Ctrl+K，屏幕上就叠了两层。
两个弹窗各自都在 window 上监听 Esc 来关自己 —— 一个按键会被**所有**监听者收到，
结果是按一下 Esc 两层一起关掉，可用户想关的只是最上面那层。

修法：搜索浮层的 Esc 改挂在 window 的**捕获阶段**，处理完调用 `stopPropagation()`。
捕获阶段是事件往下走的路上最先经过 window 的时机，在这里掐断传播，下面的监听者就收不到了。
搜索浮层永远渲染在最后一个（见 `App.tsx`），它就是最上面那层，理应由它先处理。

为什么不用 `stopImmediatePropagation`：它只能挡住**同一个节点、同一阶段**的其它监听者，
而详情弹窗的监听器在 window 的**冒泡**阶段 —— 跟捕获阶段不是同一批，挡不住。

**验证**：`pnpm build` 通过。用无头 Chrome 跑了四轮真实浏览器测试共 30 项：首页入口、输入框自动聚焦、
两组结果、关键词高亮、`↑↓` 选择、两个模块的头部按钮、输入框里按 `/` 不被抢走、点文件夹跳转定位、
下载真的落盘、以及"详情弹窗与搜索浮层叠在一起时 Esc 只关最上面那层"。

*涉及文件：`src/components/GlobalSearch.tsx`（新增）、`src/lib/search.ts`（新增）、`src/lib/fileActions.ts`（新增）、`src/App.tsx`、`src/components/Home.tsx`、`src/modules/ToolboxModule.tsx`、`src/modules/FilesModule.tsx`、`src/hooks/useTools.ts`、`src/types.ts`*

---


## 2026-10-15 18:40 · Google 风格视觉改版 + 跟随系统的深浅模式

整站视觉换成 Google / Material Design 观感，并支持深浅色。**功能逻辑一行没改**（拖拽、收藏、编辑、文件管理全部保持原样），只动样式层。

先在独立副本 `BetterTools-Google` 上开发验证，确认无误后再合并回主项目 —— 这样改坏了也不影响主项目。

### 字体：换成正牌 Google 开源字体

引入 **Roboto**（拉丁）+ **Noto Sans SC**（中文）。字体文件**下载到本地** `public/fonts`（110 个 woff2 分片，4.5MB），不依赖 fonts.googleapis.com，断网也能正常显示。

- 中文被切成 101 个分片是 Google Fonts 的正常做法：每个 `@font-face` 带一段 `unicode-range`，浏览器只下载页面上**真正出现**的那几个字所在的分片，首屏实际通常只加载 2~3 片。
- 字体栈里仍保留 `Google Sans` 首选 —— 那是 Google 的闭源品牌字体，官方不对外分发，只能"如果用户装了就优先用"。
- 用 `<link>` 引入字体 CSS 而不是 `@import`：那份 CSS 有 300KB 文字，打进主样式包会让首屏 CSS 大十倍（实测 29.7KB → 314KB）。

### 主题：三层设计令牌

新增 `src/google.css`（令牌）和 `src/ui.css`（组件基类），样式分三层：

1. `--g-*` 原始色板（这个颜色"是什么"）
2. `--token-*` 语义角色（这个颜色"用在哪"：surface 表面色、fg 文字、primary 主色……）
3. `@theme inline` 登记给 Tailwind，生成 `bg-surface` / `text-fg-muted` 这类工具类

分层的意义：组件只写"用途"，不写死颜色。全站 306 处 `slate-*` / `sky-*` 类名批量迁移成语义令牌后，深浅两套主题由变量自动切换，**组件里一个 `dark:` 前缀都不用写**。

### 深浅模式：跟随系统 + 手动覆盖

- **跟随系统**：CSS 里写 `color-scheme: light dark`，颜色用 `light-dark(浅, 深)`，浏览器自动按系统设置取色 —— 这一层**不需要任何 JS**。
- **手动指定**：工具箱页头部加了主题按钮（跟随系统 → 浅色 → 深色循环），设置面板里也有三选一的分段控件。
- 存进 localStorage 的是**模式**（`system`/`light`/`dark`），不是"当前是深是浅"。存"意图"才能让"跟随系统"长期有效 —— 存"当前颜色"的话，用户第二天改系统设置网页就不跟着变了。
- `index.html` 里有一段内联脚本，在页面解析时就把主题设好，**抢在首次绘制之前**，避免深色用户看到刺眼的白屏闪烁。
- 主题用 `useSyncExternalStore` 做成**全局单例**：头部按钮和设置弹窗读同一份状态，不会出现"弹窗显示浅色、按钮显示深色"的错位。

### 视觉细节（Material 语言）

- **状态层**：悬停不是换个颜色，而是叠一层半透明的当前色（用 `background-image` 渐变实现），这样同一个按钮放在任何底色上都不显脏；
- **海拔分级**：阴影分 e1~e5 五档，卡片悬停时"升一档"而不是放大；
- **填充式输入框**：浅底、无四周描边、底部一条线，聚焦时底线变蓝加粗（比四周描边框更像 Google）；
- **首页**：标题四色着色，卡片图标放进品牌色淡底圆角方块，两张卡片依次淡入；
- **工具卡片**：图标加底座、分组名做成同色系药丸，卡片错峰入场；
- **四色点缀**：整体仍以灰白为主，Google 四色只用在标题和模块图标上，不大面积铺。

### 子项 · 网址参数 `?theme=`

支持 `?theme=light` / `dark` / `system` 临时指定主题，只影响本次打开、不写入 localStorage。用途是排查"某个主题下的样式问题"，或直接把链接给别人看某个主题的样子。用户一旦手动切主题，参数会被 `history.replaceState` 清掉，免得刷新后又盖掉他的选择。

### 踩过的两个坑（值得记）

**① `light-dark()` 的手动覆盖会失效。**
构建时 Lightning CSS 会把 `light-dark()` 编译成兼容降级写法，降级版本判断深浅**只看媒体查询** `prefers-color-scheme`。而 CSS 规范里 `color-scheme` 属性**不会**反向影响该媒体查询的结果（浏览器刻意如此设计，否则页面能骗过系统设置）。结果就是：跟随系统正常，手动切换纹丝不动。修法是手动选定的主题用 `[data-theme]` 属性直接覆盖变量值，绕开媒体查询。

**② 脚本不能用 `process.cwd()` 定位文件。**
批量迁移脚本第一版用 `process.cwd()` 找 `src/`，而它的工作目录是主项目，于是把主项目的 13 个文件误改了。修复分两步：先按规则反向替换还原，再对仍有歧义的文件（`text-slate-500` 与 `text-slate-400` 都映射到同一个令牌，反向分不清）直接拿副本原文件覆盖。教训：脚本一律从命令行传入**绝对路径**，不依赖运行目录。

*涉及文件：`src/google.css`（新增）、`src/ui.css`（新增）、`src/hooks/useTheme.ts`（新增）、`src/index.css`、`index.html`、`src/main.tsx`、`public/fonts/*`（新增，111 个字体文件）、`src/components/Home.tsx`、`src/components/ToolCard.tsx`、`src/components/GeneralSettingsPanel.tsx`、`src/components/SearchBar.tsx`、`src/components/CategoryTab.tsx`、`src/components/CategoryTabs.tsx`、`src/components/ToolForm.tsx`、`src/components/ToolEditModal.tsx`、`src/components/GroupEditor.tsx`、`src/components/GroupEditorList.tsx`、`src/components/DevSettingsContent.tsx`、`src/modules/ToolboxModule.tsx`、`src/modules/FilesModule.tsx`、`.gitignore`*

---


## 2026-10-15 08:18 · 「通用设置」面板 + 打开时的默认分组

原本右上角的「⚙ 开发者设置」按钮改成「⚙ **通用设置**」，面板做成**两级结构**：

- **第一级 · 通用设置** —— 日常选项（目前是"打开工具箱时的默认分组"）
- **第二级 · 开发者设置** —— 点「开发者设置 ›」进入，左上角 ← 或按 Esc 返回上一级

分两级是因为调试参数属于"调一次就很少再动"的东西，和日常选项混在一页会让人不知道该看哪儿。Esc 键做了分层处理：在二级窗口时先返回上一级，只有在第一级时才关闭整个面板。

**新增设置项「打开工具箱时的默认分组」**：下拉选择某个分组后，每次进入「常用工具」都会自动选中它，省去手动切换。存在 localStorage 的 `better-tools:app-settings`，与开发者设置分开两份，互不干扰。

**几个实现细节**：

- `useAppSettings()` 必须写在 `useState(appSettings.defaultCategory)` **之前** —— 初始分组要读它的值；
- 改动在**下次打开工具箱时**生效，不会当场把界面跳走（正在浏览时突然换分组很突兀）；
- 选中的分组如果之后被删掉了，会自动退回「全部」（下拉和实际选中都做了兜底）。

**重构**：`DevSettingsPanel` 拆成 `DevSettingsContent`（只保留内容、去掉弹窗外框），这样它才能作为二级窗口嵌进通用设置里；原来的独立面板文件已删除。

*涉及文件：`src/hooks/useAppSettings.ts`（新增）、`src/components/GeneralSettingsPanel.tsx`（新增）、`src/components/DevSettingsContent.tsx`（新增，由 DevSettingsPanel 拆出）、`src/components/DevSettingsPanel.tsx`（已删除）、`src/modules/ToolboxModule.tsx`*

---


## 2026-10-15 08:10 · 默认清单自动同步 + 新增 3 个工具

**新增 3 条工具**（来自桌面 `URLs` 文件夹里的三个 Edge 应用快捷方式）：⌨️ AKKO Drivers HUB（实用）、🐋 DeepSeek 开放平台（AI）、🤖 OpenAI Platform（AI）。默认清单从 30 条增至 33 条。

提取过程有个坑值得记：这三个 `.lnk` 的目标都是 `msedge_proxy.exe`（Edge 的"安装为应用"快捷方式），**真正的网址不在"目标"里，而在"参数"里** —— 形如 `--app-url=https://hub.akkogear.com/`。只读 `TargetPath` 只能拿到 Edge 的 exe 路径，必须连 `Arguments` 一起读。

**默认清单改为自动同步**。以前往 `tools.json` 加工具后，浏览器里的旧数据不会自动更新，得手动点「补充默认清单」按钮 —— 很容易忘。现在引入 `SEED_VERSION`（数据版本号，加工具就 +1）：应用启动时发现本地记的版本低于当前版本，就自动把缺的工具补进去，并记上新版本。只做加法，已有的和你自己改过的一概不动，不会重复累加。手动按钮保留作为兜底。

**踩到的坑**：第一版把这个同步写在 `useTools` 的 `useEffect` 里，结果**首页完全不生效** —— 因为 `useTools` 这个 Hook 只在「常用工具」模块挂载，停在首页时根本不会执行，首页读到的数量仍是旧的。改成普通函数 `syncSeedTools()`，在 `App.tsx` 的**模块顶层**调用，保证它在任何界面渲染之前跑完。

*涉及文件：`src/data/tools.json`、`src/lib/constants.ts`、`src/hooks/useTools.ts`、`src/App.tsx`*

---


## 2026-10-12 14:13–14:18 · 多模块架构 + 文件管理

网站从「单页工具箱」改成**多模块应用**：新增首页，原工具箱整体搬进「🔗 常用工具」模块，新增「📁 文件管理」模块，两者各是一张入口卡片，进去后右上角有「← 返回首页」。以后加新模块只要三步：首页 `cards` 加一张卡片、`ModuleId` 加一个名字、`App.tsx` 加一条渲染分支。

**文件管理功能**：新建文件夹、上传文件（可多选）、进入文件夹（面包屑导航）、重命名、删除（删文件夹会连同里面的内容一起删）、打开与下载。

**存储方案：IndexedDB**（不是 localStorage）。localStorage 只能存字符串、上限约 5 MB，图片转 base64 还要膨胀约三分之一；IndexedDB 是浏览器专为二进制大块数据设计的数据库。数据分两张表：`nodes` 存文件名册、`blobs` 存实际内容 —— 打开文件夹时只读名册，不必把所有文件内容读进内存。删除文件夹时用广度优先遍历收集整棵子树，避免留下"占着空间却谁也找不到"的孤儿数据。

**⚠️ 固有限制（已写进界面）**：没有后端，文件只存在**这台电脑的这个浏览器**里，换设备、换浏览器、清除浏览数据都会丢失。进入模块时会调 `navigator.storage.persist()` 申请持久化存储，避免浏览器在磁盘紧张时自动回收。

**子项 · 14:18 文件管理的四项增强**：

- **拖拽移动**：按住行左侧的 ⠿ 拖到别的文件夹上松手即可移入；面包屑上的「🏠 根目录」也是投放目标，用来把东西移回最外层。会拦住两种非法操作 —— 移进它现在所在的文件夹（等于没动），以及把文件夹移进它自己的子孙里（会形成死环，那段数据从此谁也走不到）。
- **同名冲突提示**：上传遇到重名会自动改成「名字 (2).后缀」并明确告知改了什么（**保留两者，不覆盖**）；重命名和新建文件夹遇到重名则先弹窗询问。判重统一转成小写比较 —— Windows 文件系统不区分大小写，`A.txt` 和 `a.txt` 其实会互相覆盖。
- **文件搜索**：顶部搜索框按文件名**全库**搜索（不只是当前文件夹），结果里用「在 课件 / 大三上」标出它所在的位置。
- **批量选择删除**：每行左侧有勾选框，选中任意一项后出现操作条，可「全选当前列表 / 取消选择 / 删除选中」；删除同样会把文件夹的整棵子树一起带走。

*涉及文件：`src/App.tsx`（改为外壳）、`src/components/Home.tsx`、`src/modules/ToolboxModule.tsx`、`src/modules/FilesModule.tsx`、`src/lib/fileStore.ts`、`src/lib/fileUtils.ts`、`src/hooks/useTools.ts`*

---


## 2026-10-12 13:39 · 教务链接新增与「补充默认清单」

**新增 6 条教务链接**（提取自 `网课及常用链接汇总.docx`，全部是北邮校内服务）：安全教育平台（超星）、智慧树在线学堂、北邮信息门户、北邮 3DG 平台、北邮云盘、TruFar 平台。默认清单从 24 条增至 30 条，「教务」分组首次有了内容。

**同时新增「补充默认清单」操作**（在「编辑分组」弹窗**顶部**；有缺失时以蓝色提示条出现，写明"默认清单里有 N 个工具你还没有"，点一下补齐后提示条自动消失）。放在顶部是有意的 —— 初版放在弹窗最底部，要滚动才能看到，结果被忽略了。原因：默认清单 `src/data/tools.json` 只在"浏览器里还没有任何数据"时才会被采用 —— 一旦在页面上改过东西，数据就存进了 localStorage，之后默认清单再更新，浏览器也不会自动看到。这个操作把缺的补上，**只做加法**：按网址判断是否已存在（忽略结尾斜杠和大小写），已有内容和用户自己添加的一概不动，执行后提示补了几个。

*涉及文件：`src/data/tools.json`、`src/hooks/useTools.ts`、`src/components/GroupEditor.tsx`、`src/App.tsx`*

---


## 2026-10-12 13:01 · 分组标签拖拽排序

顶部的**分组标签**现在可以按住直接拖动，松开即调整分组的先后顺序，顺序自动保存到浏览器本地、刷新后保持。点击切换分组的功能不受影响（按住不动仍是点击，位移超过激活距离才开始拖动）。

**「全部」固定钉在最前面**，不参与排序 —— 它是虚拟分组，没有对应的真实数据。

**实现要点**：分组顺序**不需要单独存一份顺序表**。`groups` 本身就是有序数组，数组里靠前的分组标签就排在前面，所以"排序"就是把数组元素换个位置（`splice` 取出、再插回新位置）。这样以后增删分组时，也不会出现"顺序表和实际数据对不上"的问题。

**拖拽分流**：同一个拖拽环境里现在有三种拖法，靠"正在拖的是什么"来分流 ——

- 拖**分组标签** → 只在标签之间找落点，调整分组顺序；
- 拖**卡片**到标签上 → 移进该分组（原有功能）；
- 拖**卡片**到卡片上 → 调整卡片顺序（原有功能）。

因此碰撞检测里加了一层判断：拖标签时先把可投放区**过滤到只剩标签**，否则标签会被算进卡片格里去。

*涉及文件：`src/hooks/useTools.ts`、`src/components/CategoryTab.tsx`、`src/components/CategoryTabs.tsx`、`src/App.tsx`*

---


## 2026-10-10 11:07–11:09 · 「开发者设置」面板

主页面**右上角**新增「⚙ 开发者设置」按钮，打开弹窗集中放置调试参数（都已接上真实行为）。最初放了两个示例参数：

- **拖动激活距离（px）**：调整"按住手柄后移动多少像素才算开始拖动"（默认 6）；
- **拖拽时自动滚动**：开关拖到边缘时的自动滚动（默认开）。

底部还有「参数恢复默认值」和「清空本地数据」（清空本工具在浏览器里的全部数据）两个调试操作。

**框架设计**：以后新增参数只需改三处 —— ① `useDevSettings.ts` 的 `DEFAULT_DEV_SETTINGS` 加默认值；② `DevSettingsPanel.tsx` 的 `FIELDS` 加界面描述；③ 在用到它的组件里读取。参数存 localStorage，且读取时用默认值兜底，所以新增字段不会让老数据报错。

**子项 · 11:09 自动滚动参数可调**：把「自动滚动触发区」（`threshold`，默认 0.2）和「自动滚动加速度」（`acceleration`，默认 12）也做成可调参数。两处拖拽环境（主页 + 编辑弹窗）通过 `buildAutoScroll()` 共用同一份配置，改一处两边同时生效。

*涉及文件：`src/hooks/useDevSettings.ts`、`src/components/DevSettingsPanel.tsx`、`src/lib/autoScroll.ts`、`src/components/GroupEditor.tsx`、`src/components/GroupEditorList.tsx`、`src/App.tsx`*

---


## 2026-10-10 10:49–11:03 · 「编辑分组」与工具管理

分组标签行**最右侧**新增「编辑分组」按钮（右对齐），点击打开弹窗，支持：

- **添加新分组**：输入名称一键新建；
- **管理组内工具**：在任意分组下添加或删除工具；
- **自定义工具信息**：名称、图标（emoji，带快捷选择）、网址链接、备注；
- **删除分组**：连同组内工具一起删除，有二次确认；
- **恢复默认数据**：一键还原成初始清单。

数据架构升级：工具/分组从「写死的 tools.json」改为「可编辑状态」，保存在浏览器本地（localStorage）；`tools.json` 退化为首次使用的种子数据。

**子项 · 10:53 卡片右下角快速编辑**：每张工具卡片右下角新增 ✎ 按钮，点开是「编辑 / 删除」小菜单；选「编辑」直接打开该工具的表单，选「删除」有二次确认。点击菜单以外的任意位置会自动收起。

**子项 · 11:00 跨分组移动工具**：提供两种拖法 ——

- 主页：按住卡片手柄拖到顶部分组标签上松手即可移入（悬停时标签放大高亮），拖到「全部」无效；
- 编辑弹窗：每个工具行左侧新增 ⠿ 拖拽条，按住拖到目标分组区块即可（区块会高亮）。

**子项 · 11:03 拖拽自动滚动**：拖动时只要靠近滚动区域（编辑弹窗的工具列表）或视口上下边缘，容器就会自动滚动，不必先手动滚到目标位置。编辑弹窗同时改用 `DragOverlay` 漂浮副本 —— 拖动时原行留在原地变淡、副本跟随鼠标，因此不会被 `overflow` 裁剪，也不会在容器滚动时跑偏。

*涉及文件：`src/hooks/useTools.ts`、`src/hooks/useToolOrder.ts`、`src/components/GroupEditor.tsx`、`src/components/GroupEditorList.tsx`、`src/components/ToolForm.tsx`、`src/components/ToolEditModal.tsx`、`src/components/CategoryTab.tsx`、`src/components/CategoryTabs.tsx`、`src/components/ToolCard.tsx`、`src/lib/constants.ts`、`src/App.tsx`、`src/types.ts`*

---


## 2026-10-10 10:36 · 工具卡片拖动排序

每张工具卡片左上角新增 ⠿ 拖动手柄，按住即可拖动调整顺序；顺序自动保存到浏览器本地，刷新页面后依然保持。同时支持鼠标和手机触摸，点击链接、点收藏均不受影响。

- **10:44 修复**：拖动过程中禁用 CSS 过渡（transition）并加上 `will-change`，解决拖动时卡片慢半拍、不跟手的问题。

*涉及文件：`src/hooks/useToolOrder.ts`、`src/components/ToolCard.tsx`、`src/App.tsx`*

---


## 2026-10-10 10:15–10:19 · 小改动合并：新增「教务」分组 +「学习」加入洛谷

- **新增「教务」分组**：顶部标签栏加入，位置在「全部」之后；分组内暂无链接也会一直显示，方便后续添加常用网址。
- **「学习」加入洛谷**：「学习」分组新增 <https://www.luogu.com.cn/>，排在力扣 LeetCode 之后。

*涉及文件：`src/App.tsx`、`src/data/tools.json`*
