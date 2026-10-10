// 全局常量与拖拽相关的 id 工厂

// "全部"是一个虚拟分组，不属于真实数据
export const ALL = '全部'

// ---- 拖拽投放区的 id 前缀 ----
// dnd-kit 靠 id 区分"谁是谁"。给不同用途的目标加上前缀，判断起来最简单。
export const TAB_PREFIX = 'tab:'            // 主页面的分组标签
export const GROUP_PREFIX = 'group:'        // 编辑弹窗里的分组区块
export const EDITOR_TOOL_PREFIX = 'editor:' // 编辑弹窗里的工具行

export const tabId = (category: string) => TAB_PREFIX + category
export const groupId = (group: string) => GROUP_PREFIX + group
export const editorToolId = (toolId: string) => EDITOR_TOOL_PREFIX + toolId
