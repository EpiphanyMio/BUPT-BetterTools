// 全局常量与拖拽相关的 id 工厂

// "全部"是一个虚拟分组，不属于真实数据
export const ALL = '全部'

// ---- 拖拽投放区的 id 前缀 ----
// dnd-kit 靠 id 区分"谁是谁"。给不同用途的目标加上前缀，判断起来最简单。
export const TAB_PREFIX = 'tab:'            // 主页面的分组标签
export const GROUP_PREFIX = 'group:'        // 编辑弹窗里的分组区块
export const EDITOR_TOOL_PREFIX = 'editor:' // 编辑弹窗里的工具行

// 默认清单（src/data/tools.json）的版本号。
// 每往默认清单里新增或修改工具，就把它 +1。
//
// 为什么需要它：默认清单只在"浏览器里还没有任何数据"时才会被采用，
// 所以往清单里加新工具，已经在用的浏览器不会自动看到。
// 有了它，应用启动时就能发现"本地记的是第 1 版、现在是第 2 版"，
// 从而把新增的工具自动补进去（见 useTools 里的自动补充逻辑）。
export const SEED_VERSION = 2

// 「某处直接改了浏览器本地数据」的广播事件名。
//
// 为什么需要它：各个 Hook 只在挂载时从 localStorage 读一次（useState 的初始值只算一次）。
// 云端同步把远端数据写回 localStorage 之后，界面不会自己刷新 ——
// 所以要主动广播一声，让挂在监听上的 Hook 重新读一遍。
// 用 window 事件而不是引入状态库：这里只需要"通知一下"，不值得为它加依赖。
export const DATA_CHANGED_EVENT = 'better-tools:data-changed'

export const tabId = (category: string) => TAB_PREFIX + category
export const groupId = (group: string) => GROUP_PREFIX + group
export const editorToolId = (toolId: string) => EDITOR_TOOL_PREFIX + toolId
