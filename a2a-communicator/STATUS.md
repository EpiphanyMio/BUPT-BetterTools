# STATUS · 交流状态板

> 一眼看清：谁在等谁、有没有卡住。
> **每次处理完一条消息，回来更新对应那一行。**

最后更新：2026-10-18 23:31（`core` 已回复 `ui-001`）

---

## 待办

| # | 谁在等 | 等什么 | 消息 | 状态 |
|---|---|---|---|---|
| 1 | `ui` | `core` 确认**数据状态约定**（loading/empty/error 怎么判） | `inbox-core/2026-10-18-2325-ui-001-hello.md` | ✅ done |
| 2 | `ui` | `core` 给出 **auth / sync 的状态机与 Hook 返回值** | 同上 | ✅ done |
| 3 | `core` | `ui` 把文件模块「错误态」做好后，回来告诉 `core` 删掉过渡期的 `setNotice` | `inbox-ui/2026-10-18-2331-core-001-reply-ui-001.md` | 🟡 open |
| 4 | `core` | `ui` 决定首页卡片要不要抽成导出的 `HomeCard` 类型 | 同上 | 🟡 open |

## 双方最近动作

| 日期 | 谁 | 做了什么 |
|---|---|---|
| 2026-10-18 23:25 | `ui` | 建立 `a2a-communicator` 结构（README / CONTRACT / STATUS），发出第一条请求 |
| 2026-10-18 23:30 | `ui` | 写成 `HANDOFF-to-core.md` 交接文档，等用户转交给 `core` |
| 2026-10-18 23:31 | `core` | 回复 `ui-001`（新文件 `inbox-ui/2026-10-18-2331-core-001-reply-ui-001.md`）；补齐 `CONTRACT.md` 第 3、4、6 节 |
| 2026-10-18 23:31 | `core` | `FilesModule.tsx` 加 `listLoading` / `listError` / 根节点 `data-list-state`（只加逻辑，未动任何 className） |

## 阻塞项

（暂无）

---

## 怎么用这块板

- **`ui` 做完一件事**：把自己那行的状态改成 ✅ done，并在「双方最近动作」加一行
- **`core` 收到请求后**：把状态改成 🔵 doing，开始处理
- 状态图例：🟡 open（等人处理）· 🔵 doing（处理中）· ✅ done（已关闭）· 🔴 blocked（卡住了，见「阻塞项」）
