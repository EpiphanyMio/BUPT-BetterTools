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

## 3. 数据状态约定 ⬜ 待 `core` 确认

**这是 `ui` 最需要的一条**：同一个数据有五种状态，界面对每种都要有**不同的长相**。
如果不知道当前属于哪种，就只能瞎猜，结果就是「转圈转到天荒地老」或「空列表看起来像加载失败」。

请 `core` 确认 / 补充下表：

| 状态 | 含义 | 界面上应该长什么样 | 判定依据 |
|---|---|---|---|
| `loading` | 首次读取中 | 骨架屏或占位块 | 异步请求未返回 |
| `ready` | 有数据 | 正常列表 | 返回数组且长度 > 0 |
| `empty` | 读取成功，但**一条都没有** | 空态提示 + 引导操作 | 返回数组长度为 0 |
| `error` | 读取失败 | 错误提示 + 重试按钮 | Promise reject / 非 2xx |
| `stale` | 有数据但可能是旧的 | 正常显示 + 轻量刷新提示 | 同步失败但本地有缓存 |

**待确认的三个细节：**

1. **区分 `loading` 和 `empty` 的字段是什么？**（`FileStats` 里没有这类字段，`FilesModule` 现在靠 `stats === null` 判加载中。这是最终约定吗？）
2. **`error` 有统一形状吗？** 是 `{ error: string }` 还是直接抛异常？UI 需要知道能不能拿到**可读的中文提示**。
3. **云端同步的离线态**：`useSync()` 会暴露什么字段让 UI 显示「已离线 / 同步中 / 冲突」？

## 4. 页面模块注册约定 ⬜ 待 `core` 确认

现在加一个模块要改三处（文档第 11 节）：

```
Home.tsx 的 cards 数组 → ModuleId 类型 → App.tsx 渲染分支
```

`ui` 关心的是：**`cards` 里每一项的形状**（`icon` `title` `desc` `meta` 从哪来），
因为首页卡片的视觉完全由它决定。

请 `core` 在下方补一条 `HomeCard` 的类型定义（或者确认现在就是内联写的、没有类型）。

## 5. 接口变更记录（双方都写，新的在上面）

> 规则：**改了任何数据形状、键名、Hook 返回值，必须在这里加一行**，并给 `ui` 发一条 `notify`。

| 日期 | 谁 | 改了什么 | 对 UI 的影响 |
|---|---|---|---|
| 2026-10-18 | ui | 建立本契约，从 `数据接口文档.md` 摘出速查表 | 无（只是整理） |
<!-- 新记录加在这行上面 -->

## 6. 账号与同步：已有实现，接口形状待补充 ⬜

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

**仍缺、需要 `core` 补齐的三样**（写在 `CONTRACT.md` 或回消息给我）：

1. **状态机**：登录/同步各有哪些状态（未登录 / 登录中 / 已登录 / 邀请码错误 / 密码错误 /
   网络失败 / 同步中 / 离线 / 冲突…），怎么流转
2. **Hook 返回值清单**：`useAuth()` / `useSync()` 各返回什么字段
3. **错误码 → 中文文案对照表**

第 3 条尤其重要：**UI 不该在组件里写 `if (code === 'INVALID_INVITE')` 这种判断**，
应该由 `core` 给一句现成的中文文案，`ui` 只负责把它排版上去。
这样以后加新错误码，改一处就够，不用回来翻组件。

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
