# AGENTS.md — BetterTools 项目开发约定

> 这份文件会被 DSH（`@deepseek-ai/dsh-agent-instructions`）在**每个新对话的首次请求**自动注入，
> 目的：新开对话不必重新交代背景与习惯。

---

## 1. 沟通与讲解

- **用中文回复。**
- 我是**编程初学者**（电脑操作熟练）。讲解关键代码时说明**变量、函数、事件、数据流向**，让我能大致看懂 JS/TS 逻辑即可。
- **要适当讲解底层原理**：凡是「为什么必须这么写」的地方（浏览器存储与渲染机制、React 何时重渲染、事件冒泡与默认行为、依赖安装与打包解析等），用**几句话讲清机制和因果关系**，让我知道背后发生了什么、不这么写会出什么问题。
- 分寸：讲**与当前这段代码直接相关**的那一层即可，点到为止——不展开成教程，不引入无关的复杂设计模式，不长篇大论。
- 改完代码用一两句话说明「改了什么、为什么这么改」。

## 2. 项目概况

- 目标：**个人工具箱** —— 聚合常用工具和网站，电脑和手机都能用。
- 路线：网页 → PWA → Python 自动化 → 后端同步 → C/WASM。**当前已跨过后端同步这一阶段**：
  有 Cloudflare Worker + D1 的真实后端（`worker/`），支持多用户登录与按账号隔离的云端同步。
- 技术栈：**Vite + React 19 + TypeScript + Tailwind CSS 4 + @dnd-kit**；后端 **Cloudflare Workers + D1**。
- 数据：本机存 localStorage，登录后同步到自己的账号下；`src/data/tools.json` 只是首次使用的**种子数据**。
- 账号体系：用户名 + 密码登录，**注册需要管理员发的邀请码**。管理员账号 `EpiphanyMio`，
  只有管理员能在「通用设置 → 开发者设置」里看到并管理邀请码。
- 完整计划见 `DeveloperLogs/Startup_A_Sketch.md`。

## 3. 环境与命令（务必先读）

**pnpm 直接敲就行**：2026-10-16 起全局装好了（`npm i -g pnpm@11.7.0`，装在 `%APPDATA%\npm`，已经在 PATH 上）。
Node 用的是系统那份 `C:\Program Files\nodejs`（v24.21.0）。

**兜底**（换了台机器、或全局 pnpm 不见了）——DSH 自带的那份在这里，用的时候记得把 node 的 bin 加进 `$env:PATH`：

- node：`C:\Users\ROG\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`
- pnpm：`C:\Users\ROG\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs`
- 调用：`& <node> <pnpm.mjs> <子命令>`

**沙箱**：受限（workspace-write）模式会逐个拦截文件操作，导致 `pnpm install/build` 极慢甚至卡死；**安装与构建一律用完全权限**（`danger-full-access`）运行，速度差上百倍。这**不是网络问题，不需要 VPN**。

**命令**：`pnpm dev` / `pnpm build`（含 `tsc --noEmit`）/ `pnpm preview`。

**预览**：<http://localhost:5173/> —— Vite 绑的是 IPv6，必须用 `localhost`，不能用 `127.0.0.1`。

**Git**：仓库已接入 GitHub，`origin` → <https://github.com/EpiphanyMio/BUPT-BetterTools>，分支 `main`。
**推上去就会自动部署**到 <https://bupt-bettertools.yuesu76.workers.dev/>（Cloudflare Workers 静态托管，构建命令 `pnpm build`，产物目录 `dist/`）。
所以不需要手动传 `dist/`，`git push` 之后等一两分钟就行。
联网的 git 命令（`fetch` / `pull` / `push` / `ls-remote`）在受限沙箱下会因 TLS 被拦截（报 `schannel: SEC_E_NO_CREDENTIALS`），**必须用完全权限**运行；凭据已缓存，通常不会再弹登录框。

**改完必须验证**：`pnpm build` 必须通过；必要时再用开发服务器确认新模块能编译。

**浏览器端验证一律用 `scripts/browser-verify.mjs`，不要每次重写无头 Chrome 的 CDP 样板。**
之前同一个对话里重写了八九遍「启动 Chrome → 连调试端口 → 发命令 → 轮询判断」，纯浪费 token。

```js
import { openBrowser, createChecks } from './browser-verify.mjs'

const page = await openBrowser({ url: 'http://localhost:5173/', port: 9400 })
const t = createChecks()
await page.waitText('登录')                       // 等页面出现某段文字（比 sleep 可靠）
t.ok('能打开', await page.has('登录'))            // 断言
await page.clickText('访客预览')                  // 按文字点按钮
await page.fillByPlaceholder('用户名', 'abc')     // 填输入框（React 受控组件也能用）
await page.storage('better-tools:tools')          // 读 localStorage 并 JSON.parse
await page.storageRaw('better-tools:guest-mode')  // 读原始字符串（标记类用它）
page.reload() / page.setViewport(414, 896, true) / page.screenshot('x.png')
t.report()                                        // 有失败会 exitCode=1
await page.close()
```

- 跑**线上站点**必须加代理：`openBrowser({ url: SITE, proxy: 'http://127.0.0.1:7897' })`
  —— 本机 DNS 对 `*.workers.dev` 有污染，直连必超时。
- 该文件用 `stdio: 'ignore'` 启动 Chrome（受限沙箱禁止管道，用 pipe 会 spawn EPERM）。

## 4. 代码约定

- 注释与界面文案一律**中文**；注释解释「为什么这么做」。
- 目录：`src/components/` 组件；`src/hooks/` 自定义 Hook（`useTools` 工具数据、`useFavorites` 收藏、`useToolOrder` 排序、`useDevSettings` 开发者设置）；`src/lib/` 常量与工具函数。
- 新功能/改动完成后，**要更新 `DeveloperLogs/New Functions.md`**。
- **要读写数据前先看 `DeveloperLogs/数据接口文档.md`**：里面列了所有 localStorage 键名、各 Hook 的签名、
  `fileStore` 的每个异步函数。**不要绕过 `src/lib` / `src/hooks` 直接操作浏览器存储** ——
  将来接后端时，要换的就是那一层。

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
- **合理使用子智能体**：任务里如果有彼此独立、边界清晰的部分（后端 / 前端 / 调研 / 文档），
  主动拆给 subagent 并行做，自己做整合、复核和端到端验证。拆之前先把**接口契约定死**，
  并在给每个子智能体的任务里写清"只准碰哪些文件"，避免互相覆盖。
- **Git：小改动自动 push，重大改动先问我。**
  - **小改动 → 直接提交并推送**：文案 / 注释 / 拼写、样式与布局微调、修一个范围明确的 bug、
    文档与日志、增删一个工具链接或分组。
  - **重大改动 → 先停下问我要不要 push**：新增功能模块或新页面、改数据结构
    （localStorage / IndexedDB 的字段、key、版本号）、增删或升级依赖、改构建与部署配置
    （`vite.config.ts`、`wrangler.jsonc`、`.npmrc`、`pnpm-workspace.yaml`、`scripts/`）、
    重构（大面积改名 / 拆文件 / 删文件）、任何会删掉我数据的改动。
  - **拿不准就按「重大」处理，先问。**
  - 提交信息用中文，说明这次改了什么。**推上去就会自动部署**，所以 push 前 `pnpm build` 必须先过。

## 8. 多对话协作（同一工作区里会同时开着好几个对话）

这个工作区经常同时开着多个对话（比如「创意网页UI视觉开发」「学习网页架构与开发流程」），
它们**共用同一套文件**，谁的改动其他人立刻就能看见 —— 但也意味着会互相踩。

已经真实发生过一次：另一个对话往 `New Functions.md` 顶部插自己的条目时，
把本对话刚写好的**条目标题整行覆盖**掉了。正文还在、标题没了，而且 `git diff` 里看不出来
（那条改动本来就没提交过，diff 比对的是上一次提交）。

所以：

- **动手前先 `git status`**：看清工作区里已经有哪些改动、分别是谁的、有没有你要改的文件。
- **改别人也改过的文件要格外小心**。用 `edit` 时挑一段**独一无二**的文字当锚点 ——
  拿 `---` 这种满篇都有的行做锚点，很容易插错位置、或者把别人的内容吃掉。
- **改完回读一遍**刚写的那段，确认没覆盖掉别人的东西。
- **只读角色**：如果某个对话只是来"看"的（读代码、读别的对话的记录、学架构），
  就让它保持只读，别给写权限。切换方式：**在那个对话里**发一条

  ```
  /permission read-only
  ```

  界面上那个权限下拉里它叫「仅可查看」。权限是**按会话**记的，改完立刻生效、
  下一次发言就起作用，不用重启对话。想看当前是哪个预设，发一条空的 `/permission`。

---

## 9. 协作触发词：「需要合作」

工作区里会同时开着多个对话，按角色分工（协议原文见 `a2a-communicator/README.md`）：

| 代号 | 负责 | 不碰 |
|---|---|---|
| `core` | 数据逻辑、Hook、存储、Worker、错误处理 | 样式、颜色、间距、动效 |
| `ui` | 样式、布局、动效、视觉体系 | 任何 `.ts` 里的业务逻辑 |

**平时各干各的** —— 不要互相等，也不要去翻对方的收件箱。

只有我（用户）说出下面这句话时，才进入协作模式：

> ### 需要合作

听到这四个字，**先不要改任何代码**，按顺序把公共文件读一遍：

1. `a2a-communicator/README.md` —— 读写纪律
   （最关键一条：**一条消息 = 一个独立文件，绝不往已有文件里追加内容**）
2. `a2a-communicator/STATUS.md` —— 谁在等谁、有没有卡住
3. `a2a-communicator/CONTRACT.md` 的**第 5 节「接口变更记录」** —— 对方这段时间改了什么（不用通读全文）
4. **自己收到的**消息目录里所有 `status: open` 的文件：
   - `core` 读 `inbox-core/`（`ui` 写给你的）
   - `ui` 读 `inbox-ui/`（`core` 写给你的）

读完之后**先回一句**「我是 `core`（或 `ui`），当前有 N 条待处理」，说清你打算做什么，再动手。

处理完一条消息：

1. 在**对方的**收件箱里**新建**一个文件回复（`type: reply`，`id` 里写清回的是哪条）
2. 更新 `STATUS.md` 里对应那一行

⚠️ **网页开发当前处于暂停状态。** 没有「需要合作」这句话，就不要主动推进任何开发工作。