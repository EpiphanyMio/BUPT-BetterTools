# CONTRACT · 数据接口契约

> **双方共识文件。** `ui` 依据这份清单设计界面；`core` 负责让它保持准确。
> 改这里之前先在 `inbox-*/` 发一条 `type: contract` 的消息。
> 最后更新：2026-10-18 23:25（`ui` 初版，待 `core` 确认第 3、4 节）

---

## 1. 权威文档在哪

**下面这份是唯一事实来源，不在这里重复抄写**（抄一份就会有两份，迟早不同步）：

📄 [`DeveloperLogs/数据接口文档.md`](../DeveloperLogs/数据接口文档.md)

本文档只做三件事：
- 列出 `ui` 设计时**最常查的接口速查**（第 2 节）
- 记录**接口变更历史**（第 5 节，双方都要维护）
- 约定**数据状态的含义**（第 3 节，直接影响空态/骨架屏/错误提示长什么样）

## 2. 数据接口速查（`ui` 视角）

### 2.1 数据形状

```ts
interface Tool {
  id: string
  name: string
  url: string
  description: string
  category: string
  icon?: string          // emoji，可能没有 → 界面要有兜底（现在用 🔗）
}

interface FileNode {
  id: string
  name: string
  kind: 'folder' | 'file'
  parentId: string       // '' = 根目录（不是 null）
  size: number
  mime: string
  createdAt: number
  updatedAt: number
}

interface FileStats { fileCount: number; folderCount: number; bytes: number }
interface SearchHit { node: FileNode; pathNames: string[] }
```

### 2.2 响应式数据（Hook，一变界面自动重渲染）

| Hook | 给 UI 的关键返回 | UI 拿它渲染什么 |
|---|---|---|
| `useTools()` | `tools` `groups` `missingSeedCount` | 卡片网格、分组标签、缺省工具提示 |
| `useFavorites()` | `favorites` `isFavorite(id)` | 星标状态 |
| `useToolOrder(allIds)` | `order` `setOrder(ids)` | 卡片显示顺序（`tools` 本身是无序的，必须按 `order` 排） |
| `useAppSettings()` | `settings.defaultCategory` | 默认选中的分组 |
| `useDevSettings()` | `settings.*`（4 个调试参数） | 开发者设置面板的控件 |
| `useTheme()` | `mode` `setTheme` `resolved` | 主题按钮的当前态与图标 |
| `useSync()` | 同步引擎状态 | 云端同步的状态显示（详见第 6 节） |

> ⚠️ **UI 侧的硬规则**：`tools` 里的顺序不是显示顺序。
> 必须 `useToolOrder` 给 `order`，再按 `order` 排一遍。排序逻辑在 `ui` 这边不能自己发明。

### 2.3 一次性读取 / 纯函数

| 函数 | 来源 | 用途 |
|---|---|---|
| `readTools()` | `hooks/useTools` | 不订阅变化，读一次（全局搜索用） |
| `readToolCounts()` | `hooks/useTools` | 首页显示「N 个工具 · N 个分组」 |
| `formatBytes(n)` | `lib/fileUtils` | `1536` → `1.5 KB` |
| `formatTime(ts)` | `lib/fileUtils` | 时间戳 → `10-12 13:20` |
| `iconFor(name, kind)` | `lib/fileUtils` | 按扩展名猜 emoji |
| `canPreview(name)` | `lib/fileUtils` | 决定是否显示「打开」按钮 |
| `highlight(text, kw)` | `lib/search` | 返回 `[{text, hit}]`，用于高亮（**不要用 innerHTML**） |

### 2.4 异步接口（必须 `await`）

文件管理全部走 `src/lib/fileStore.ts`，全是 `Promise`：

```ts
listChildren(parentId), getPath(folderId), createFolder(name, parentId),
addFile(file, parentId, overrideName?), renameNode(id, name),
deleteNode(id), deleteNodes(ids), getBlob(id), getStats(), getQuota(),
requestPersistentStorage(), moveNode(id, targetParentId),
uniqueName(name, taken), searchNodes(keyword)
```

打开/下载在 `src/lib/fileActions.ts`：`openFileNode(node)` / `downloadFileNode(node)`。

### 2.5 设计系统（`ui` 自己的地盘，列在这里方便 `core` 引用）

`core` 写新组件时**直接用这些类名**，不要写死颜色，否则深色模式会花：

| 类别 | 类名 |
|---|---|
| 表面/文字/描边 | `bg-surface` `bg-surface-2` `bg-surface-3` `text-fg` `text-fg-muted` `text-fg-subtle` `border-line` `border-line-soft` |
| 主色 | `bg-primary` `text-primary` `bg-primary-soft` `hover:bg-primary-layer` |
| 功能色 | `text-danger` `bg-danger-bg` `text-warn` `text-success` |
| 按钮 | `.btn` + `.btn-primary` `.btn-neutral` `.btn-outline` `.btn-text` `.btn-danger` `.btn-icon` `.btn-sm` |
| 输入 | `.field`（填充式）/ `.field-boxed`（描边式）/ `.check`（复选框） |
| 容器 | `.card` `.card-hover` `.chip` `.chip-active` `.scrim` `.modal-panel` |
| 阴影 | `shadow-e1` ~ `shadow-e5` |
| 圆角 | `rounded-btn` `rounded-field` `rounded-card` `rounded-panel` |
| 动效 | `.animate-rise`（入场）、缓动见 `google.css` |

定义在 `src/google.css`（令牌）和 `src/ui.css`（组件基类）。

## 3. 数据状态约定 ✅ 已由 `core` 确认（2026-10-18 23:31）

### 3.1 文件列表（`FilesModule`）

`core` 已在代码里加了两个显式状态，**不要再靠 `items.length` 或 `stats === null` 推断**：

```ts
const [listLoading, setListLoading] = useState(true)   // 首次就是 true
const [listError, setListError] = useState('')          // 中文；空串 = 没失败
```

| 状态 | 判定依据 | 界面上应该长什么样 |
|---|---|---|
| `loading` | `listLoading === true` | 骨架屏 / 占位块 |
| `ready` | `!listLoading && !listError && items.length > 0` | 正常列表 |
| `empty` | `!listLoading && !listError && items.length === 0` | 空态提示 + 引导操作 |
| `error` | `listError !== ''` | 错误提示 + 重试按钮 |
| ~~`stale`~~ | **文件模块不存在这个状态** | 不适用 |

另外模块根节点上挂了 `data-list-state="loading|empty|ready|error"`，
**也可以用纯 CSS 的方式挂样式**（`[data-list-state="loading"] .xxx`），组件里不写判断。

> ⚠️ 为什么废掉 `stats === null`：`stats` 是全局统计，**切换文件夹时不会重新变 null**，
> 那一段读不到 loading 信号，会闪一下上个文件夹的旧列表。
> 而 `items` 初始是 `[]`、空文件夹也是 `[]`、读取失败还停在 `[]` —— 光看长度分不出三件事。

### 3.2 其他数据源

| 数据 | 有没有 loading | 说明 |
|---|---|---|
| 工具 / 分组 / 收藏 / 排序 / 默认分组 | **没有** | 同步读 localStorage，首帧就有值 |
| 文件列表 | 有（`listLoading`） | IndexedDB 是异步的 |
| 邀请码列表（`InviteAdmin`） | 有 | **标准范例**：`loading` / `error` / `invites` 三件套，照抄即可 |
| 云端同步 | 有 | 见 `useSync().status`，第 6 节 |

### 3.3 `error` 的统一形状

- **文件模块**：`listError: string`，已是可直接显示的中文（形如 `读取数据失败：xxx`）
- **auth 接口**：`AuthError` 异常，`message` 永远是中文；用 `authErrorMessage(err)` 取（见 6.3）
- **同步**：`useSync().lastError`，中文，空串表示没错误

统一原则：**数据层永远给中文文案，UI 不判错误码、不做翻译。**

## 4. 页面模块注册约定 ⬜ 待 `core` 确认

现在加一个模块要改三处（文档第 11 节）：

```
Home.tsx 的 cards 数组 → ModuleId 类型 → App.tsx 渲染分支
```

`ui` 关心的是：**`cards` 里每一项的形状**（`icon` `title` `desc` `meta` 从哪来），
因为首页卡片的视觉完全由它决定。

### `HomeCard` 形状 ✅ 已由 `core` 确认

**确认：目前没有导出类型，就是 `Home.tsx` 第 44 行起的内联数组。** 实际字段只有 5 个：

```ts
// 尚未抽成导出类型；如果 ui 需要，让 core 抽出来即可（两分钟的活）
interface HomeCard {
  id: ModuleId          // 'tools' | 'files'
  icon: string          // emoji 字符串
  title: string
  desc: string
  meta: string          // 一行统计，长度会变（如「33 个工具 · 6 个分组」）
}
```

没有 `href`、没有 `disabled`、没有权限字段。渲染时 `map` 还用了 `index` 做入场动画延迟。

## 5. 接口变更记录（双方都写，新的在上面）

> 规则：**改了任何数据形状、键名、Hook 返回值，必须在这里加一行**，并给 `ui` 发一条 `notify`。

| 日期 | 谁 | 改了什么 | 对 UI 的影响 |
|---|---|---|---|
| 2026-10-18 23:31 | core | 确认第 3、4、6 节；`FilesModule` 新增 `listLoading` / `listError` 与根节点 `data-list-state` | **可以直接做骨架屏/空态/错误态了**；文件模块的 `stats === null` 不再是加载判据 |
| 2026-10-18 | ui | 建立本契约，从 `数据接口文档.md` 摘出速查表 | 无（只是整理） |
<!-- 新记录加在这行上面 -->

## 6. 账号与同步 ✅ 已由 `core` 补齐（2026-10-18 23:31）

**背景（按项目最新状态）**：本项目已跨过「后端同步」阶段，后端是 Cloudflare Worker + D1，
支持多用户登录、按账号隔离的云端同步。所以这几个模块是**已经存在的**，不是"将来做"：

| 层 | 文件 |
|---|---|
| 认证 | `src/lib/auth.ts`、`src/hooks/useAuth.ts`、`src/components/AuthScreen.tsx` |
| 同步 | `src/lib/sync.ts`、`src/hooks/useSync.ts`、`src/components/SyncSettings.tsx` |
| 后端 | `worker/auth.ts`、`worker/d1.ts`、`worker/index.ts` |

**已从项目约定得知的业务事实**（这些直接决定界面怎么设计）：

- 登录方式：**用户名 + 密码**
- 注册：**需要管理员发的邀请码** —— 所以注册页必须有一个邀请码输入框，不能只放用户名密码
- 管理员账号固定是 `EpiphanyMio`，只有管理员能看到「邀请码管理」入口
  → 界面上需要一个**按角色显隐**的入口，`ui` 需要知道"怎么判断当前用户是管理员"这个字段

### 6.1 `useAuth()`

```ts
const { status, user, isAdmin, lastError, login, register, logout } = useAuth()

status: 'loading' | 'anonymous' | 'authenticated'
user:   { id: number; username: string; isAdmin: boolean } | null
isAdmin: boolean        // = user?.isAdmin === true，来自服务器响应，不落盘
lastError: string       // 中文；空串 = 没错误
login(username, password): Promise<AuthUser>
register(username, password, inviteCode): Promise<AuthUser>
logout(): Promise<void>
```

**状态机只有三条**：

```
本地没有令牌 ──────────────► anonymous（首帧就是它，不会闪 loading）
本地有令牌 ── 问服务器 ──► loading ── 200 ──► authenticated
                                └── 401 ──► anonymous（并清掉令牌）
```

⚠️ `loading` **只在"本地有令牌、正在向服务器确认"时出现**。没登录过的人打开页面第一帧就是 `anonymous`。

⚠️ **登录 / 注册失败不会改 `status`**：函数会 throw（错误信息已是中文），同时写 `lastError`。
两种写法都行：`try/catch` + `authErrorMessage(err)`（推荐），或直接读 `lastError`。

### 6.2 `useSync()`

```ts
const { status, revision, lastSyncedAt, lastError, isConfigured, syncNow, setToken } = useSync()

status: 'unauthenticated' | 'unconfigured' | 'idle' | 'syncing' | 'synced' | 'error' | 'offline'
revision: number        // 本地记住的云端版本号
lastSyncedAt: number    // 本机上次同步成功的时间戳；0 = 这次打开还没成功过
lastError: string       // 中文；空串 = 没错误
syncNow(): Promise<void>  // 内部全 catch，不会抛
```

| `status` | 含义 | 界面建议 |
|---|---|---|
| `unauthenticated` | 没登录 / 登录失效 | 不显示同步状态，或灰点「未登录」 |
| `unconfigured` | **历史遗留，现在不会出现** | 忽略 |
| `idle` | 有未上传改动，等防抖 1.5 秒 | 「待同步」 |
| `syncing` | 正在上传 / 下载 | 「同步中…」 |
| `synced` | 刚同步成功 | 「已同步」+ 上次时间 |
| `error` | 服务端拒绝 / 数据问题 | 「同步出错」+ `lastError` + 「重试」 |
| `offline` | 断网 / 连不上服务器 | 「离线，改动先存本地」（**不是错误，别用红色**） |

⚠️ 两个坑：
- **`isConfigured` 是历史遗留**（原来是"填了共享令牌没有"），恒等于 `status !== 'unconfigured'`。
  **判断登录请用 `useAuth().status`**。
- **`setToken` 已废弃**（登录体系取代共享令牌），现在是空实现，**不要接 UI**。

### 6.3 错误码 → 中文文案（`src/lib/auth.ts`）

**推荐用法：不判 code，直接取文案。**

```ts
import { authErrorMessage } from '../lib/auth'
catch (err) { setMsg(authErrorMessage(err)) }   // 永远得到一句能直接显示的中文
```

| `code` | 中文文案 | 建议交互 |
|---|---|---|
| `invalid-credentials` | 用户名或密码不对 | 清空密码、聚焦密码框 |
| `invalid-invite` | 邀请码无效，或已经被用过了 | 高亮邀请码框 |
| `username-taken` | 这个用户名已经被注册了，换一个试试 | 聚焦用户名框 |
| `forbidden` | 只有管理员能做这个操作 | 收起管理员入口 |
| `unauthorized` | 登录已失效，请重新登录 | 跳登录页 |
| `bad-request` | 服务端给的具体原因；没有则是「提交的内容不合规」 | 原样显示 |
| `not-found` | 要操作的记录已经不存在了 | 刷新列表 |
| `network` | 连不上服务器，请检查网络后重试 | 显示「重试」 |
| `server` | 服务器出错了（5xx），稍后再试 | 显示「重试」 |
| `bad-response` | 服务器返回的数据看不懂 | 当异常上报 |
| `unknown` | 服务器返回 N | 原样显示 |

> **以后加新错误码只改 `auth.ts` 那一处映射，`ui` 不用改组件。**

### 6.4 怎么判断管理员

```ts
const { isAdmin } = useAuth()   // boolean
```

值来自服务器响应（登录 / 注册 / `/api/auth/me`），**不落盘** —— 改 localStorage 伪造不出来，
真正的写权限由服务端 403 兜底。参考现有写法：`{isAdmin && <InviteAdmin />}`。

## 7. 我要一个新接口，怎么提

发给 `inbox-core/`，`type: request`，正文按这个模板：

```md
### 背景
（我在做哪个界面，缺什么）

### 需要的接口
- 函数名 / Hook 名（建议）
- 输入、输出（TypeScript 形状）
- 什么时候会调用

### 如果没有，我现在的降级方案
（比如先写死占位、或复用现有接口 —— 让对方知道不做的后果）
```
