# 交接：`ui` → `core`

> 这份文字可以直接粘贴给「基本页面功能开发」那个对话。
> 写完于 2026-10-18 23:30。如果你读到了这里，说明你需要了解 UI 侧的需求。

---

## 我是谁

我是**「创意网页UI视觉开发」**这个对话。我们共用同一个工作区
（`D:\Users\ROG\Desktop\Workflow\BetterTools`），所以：

- 我改的样式，你立刻能看到
- 你改的逻辑，我也立刻能看到
- **反过来也意味着，我们会互相踩**

这就是我建 `a2a-communicator/` 的原因。

## 先花两分钟读这两个文件

1. `a2a-communicator/README.md` —— **只记「读写纪律」那五条**，其他可以略过
2. `a2a-communicator/CONTRACT.md` —— 我已经把数据接口整理成速查表了，你只需要核对对不对

**最重要的一条纪律**：**一条消息 = 一个独立文件，绝不往已有文件里追加内容。**

理由说清楚：两个 agent 同时写同一个文件时，后写的会把先写的**整段覆盖**——
写入是"拿全文替换"，不是"末尾追加"。这个项目已经真实踩过一次：
另一个对话往 `New Functions.md` 顶部插条目，把刚写好的条目标题整行吃掉了，
而且 `git diff` 还看不出来（那条改动本来就没提交过）。

独立文件（`core-001.md`、`ui-002.md`）在物理上不可能撞。

## 我负责什么、不碰什么

| | 我（`ui`） | 你（`core`） |
|---|---|---|
| **改** | `src/google.css`、`src/ui.css`、各组件 `className`、动画、布局、视觉体系 | 数据逻辑、Hook 实现、存储读写、Worker、错误处理 |
| **不碰** | 任何 `.ts` 里的业务逻辑 | 样式、颜色、间距、动效 |

**需要你注意**：`ToolCard.tsx`、`Home.tsx`、`ToolboxModule.tsx`、
`GeneralSettingsPanel.tsx`、`FilesModule.tsx` 这几个文件我刚改过样式。
你要改它们里面的**逻辑**请只动逻辑部分，**别整段重写 `className`**——
重写会把深色模式、组件基类、卡片对齐一起弄回旧样子。

## 我要你做的三件事（按重要性排）

### ① 最重要：告诉我数据有哪几种状态

同一个列表，界面对五种状态要长得**完全不一样**：

| 状态 | 界面长什么样 |
|---|---|
| 加载中 | 骨架屏 / 占位块 |
| 有数据 | 正常列表 |
| 空（读取成功但一条都没有） | 空态提示 + 引导操作 |
| 出错 | 错误提示 + 重试按钮 |
| 数据可能是旧的 | 正常显示 + 轻量刷新提示 |

**现在的困境**：代码里我只能靠 `stats === null` 这种推断猜"是不是还在加载"。
猜错就会出现「空列表看起来像加载失败」，或者「一直转圈」。

请回答这三个问题（写在 `CONTRACT.md` 第 3 节，或回消息给我）：

1. **区分「加载中」和「空」用哪个字段？** `FilesModule` 现在靠 `stats === null`，这是最终约定吗？
2. **`error` 有统一形状吗？** UI 能不能拿到一句**可以直接显示给用户的中文**？
3. **`useSync()` 暴露哪些字段**，让 UI 能显示「已离线 / 同步中 / 冲突」？

> **这一条答了我就能立刻开始干活，另外两条有答案了再回也行。**

### ② `auth` / `sync` 的接口形状

工作区里已经有 `src/lib/auth.ts`、`src/hooks/useAuth.ts`、`src/components/AuthScreen.tsx`、
`src/hooks/useSync.ts`、`src/components/SyncSettings.tsx`。

我需要三样：

1. **状态机**：登录有哪几种状态、怎么流转
   （未登录 / 登录中 / 已登录 / 邀请码错误 / 密码错误 / 网络失败 …）
2. **Hook 返回值清单**：`useAuth()` / `useSync()` 各返回什么字段
3. **错误码 → 中文文案对照表**

**第 3 条请务必给。** 我不想在组件里写 `if (code === 'INVALID_INVITE')` 这种判断——
你给现成文案，我只负责排版。这样你以后加错误码，改一处就够，不用回来翻组件。

另外我需要知道：**怎么判断当前用户是管理员**（哪个字段）。
注册页要放邀请码输入框，「开发者设置」里的邀请码管理入口要按角色显隐，都得靠这个。

### ③ `HomeCard` 的字段形状

`Home.tsx` 里的 `cards` 数组现在是内联写的。首页卡片的视觉完全由它决定，
所以我想知道每一项有哪些字段（除了 `icon` / `title` / `desc` / `meta` 还有别的吗）？
如果它就是个内联对象、没有类型定义，确认一下就行，我按现状设计。

## 你写新组件时，请用我的设计令牌

**不要写死颜色**（`bg-white`、`text-slate-700` 这种），否则深色模式会花掉。
用这套语义类名：

| 用途 | 类名 |
|---|---|
| 表面 / 文字 / 描边 | `bg-surface` `bg-surface-2` `bg-surface-3` `text-fg` `text-fg-muted` `text-fg-subtle` `border-line` `border-line-soft` |
| 主色 | `bg-primary` `text-primary` `bg-primary-soft` `bg-primary-layer` |
| 功能色 | `text-danger` `bg-danger-bg` `text-warn` `text-success` |
| 按钮 | `.btn` + `.btn-primary` `.btn-neutral` `.btn-outline` `.btn-text` `.btn-danger` `.btn-icon` `.btn-sm` |
| 输入框 | `.field`（填充式·Google 风）/ `.field-boxed`（描边式）/ `.check`（复选框） |
| 容器 | `.card` `.card-hover` `.chip` `.chip-active` `.scrim` `.modal-panel` |
| 阴影 | `shadow-e1` ~ `shadow-e5`（越往上浮得越高） |
| 圆角 | `rounded-btn` `rounded-field` `rounded-card` `rounded-panel` |
| 动画 | `.animate-rise`（入场淡入上浮） |

定义在 `src/google.css`（令牌）和 `src/ui.css`（组件基类），**都有中文注释**。

## 现在界面是什么样（免得你按旧印象写）

- 整站已经是 **Google / Material Design** 风格
- 支持**跟随系统**的深浅色，靠 CSS 变量 + `<html data-theme>`
  ⚠️ **别用 Tailwind 的 `dark:` 前缀**——这套方案里没有它，写了也不生效
- 工具卡片：等高等宽、简介最多两行（超出省略）、分组药丸钉在底部
- 卡片右上角：`ⓘ` 详情 + `☆` 收藏；右下角：`✎` 编辑菜单
- 字体：Roboto + Noto Sans SC，本地托管在 `public/fonts/`

## 怎么回我

在 `a2a-communicator/inbox-ui/` 里**新建一个文件**，命名：

```
2026-10-19-0900-core-001-reply-ui-001.md
```

开头写 frontmatter：

```yaml
---
id: core-001
from: core
to: ui
type: reply
about: data-api
status: open
created: 2026-10-19 09:00
---
```

然后顺手把 `a2a-communicator/STATUS.md` 里对应那行状态改一下。

---

**一句话总结：最需要你做的是第 ① 件（数据状态怎么判）。**
**其他两件有答案了再回我也行，不用一次答完。**
