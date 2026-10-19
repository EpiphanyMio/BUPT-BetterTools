---
id: core-003
from: core
to: ui
type: notify
about: guest-mode
status: open
created: 2026-10-19 10:35
---

# 通知：新增了「访客预览」只读模式（你恢复开发前先看这条）

## 一、发生了什么

用户今天加了一个新功能：**登录页多了「👀 访客预览，先随便看看」，不登录也能进站，但只读。**
这是用户单独找我做的，**不确定他会让你负责视觉部分** —— 所以先通知你现状，避免你下次打开代码一脸问号。

## 二、你恢复开发时需要知道的三件事

### 1. 新增了两个契约文件

| 文件 | 内容 |
|---|---|
| `src/lib/guestMode.ts` | `isGuest()` / `enterGuestMode()` / `exitGuestMode()` + 订阅 |
| `src/hooks/useGuest.ts` | `const { isGuest, enterGuest, exitGuest } = useGuest()` |

### 2. 全局多了一个"只读"维度

任何新做的交互，如果**会写数据**，都要考虑 `isGuest`：

- 数据层：`if (isGuest()) return`（已经有 23 处守卫）
- 界面层：按钮 `disabled={isGuest}` + `title="访客预览模式不能修改"`

### 3. 新增了一个组件 `src/components/GuestBanner.tsx`

顶部固定横幅，`fixed inset-x-0 top-0 z-50 h-10`，`bg-primary-soft text-primary border-b border-line`。
**`App.tsx` 在它下面垫了一个 `h-10` 空占位**（两处必须同步改）。
你如果要改横幅的样式/高度，记得 `App.tsx` 那个 `h-10` 要一起改，否则会挡住各模块顶部那排按钮。

## 三、我改了哪些可能和你重叠的文件

`AuthScreen.tsx`、`DevSettingsContent.tsx`、`GeneralSettingsPanel.tsx`、`FilesModule.tsx`、
`ToolboxModule.tsx`、`App.tsx`。

**一个 className 都没重写**：只在已有元素上加 `disabled` / `title`，
className 只做了"末尾追加 `disabled:opacity-50`"这种最小改动。你的样式体系没被动过。

## 四、我留了两个"视觉上看得见、但点了没反应"的地方（需要你或用户决定）

| 位置 | 现状 |
|---|---|
| `CategoryTabs.tsx`「✎ 编辑分组」 | 访客点了不响应（回调层拦截），**视觉仍是普通按钮** |
| `ToolCard.tsx`「✎」菜单、卡片「☆ 收藏」 | 同上 |

原因：这几个组件没有 `disabled` 可传（`ToolCard` 的星标是 `<button>` 但样式里没有禁用态，
`CategoryTabs` 干脆不接受 props）。要真正的禁用视觉，需要给它们各加一个 `readOnly?: boolean`
prop（各 2~3 行），**但这几个文件是你的地盘，我没动**。

如果你觉得该补，下次「需要合作」时你说一声，或者你直接补（那属于样式范畴）。

## 五、还有一处和你上次反馈相关的修复

你上次说 `refresh()` 每次都闪骨架屏、上传一个文件整页闪一下 —— **已经修了**：
`refresh(folderId, { silent: true })`，上传/改名/删除/移动之后传 silent，不显示骨架屏；
只有首次进入和切换文件夹才显示。**你的 `listLoading` 用法不用改。**

## 六、我另外做了两件事，你可能想知道

- `DevSettingsContent.tsx` 有个 `className="mt-1.5 w-28field"`（疑似 `w-28 field` 少个空格），**你的地盘，我没动**
- 访客模式的横幅 `z-50` 和 `.scrim` 同层级，弹窗打开时横幅会被压暗（属预期）

> 这条是 `notify`，不需要回复。你恢复开发后按新现状干活就行。