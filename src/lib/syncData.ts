// 云端同步的数据桥：在「同步引擎要求的数据形状」和「浏览器本地存储」之间来回转换。
//
// 为什么要有这一层：
//   同步引擎（src/lib/sync.ts）只认识 SyncData 这个形状，不该知道 localStorage 键名长什么样；
//   各个 Hook 只关心自己那一份数据，也不该知道"整包同步"这件事。
//   中间这层负责两头对接，键名统一从各 Hook 导出，这里不写死任何字符串。
//
// ⚠️ 注意这里 lib/ 反过来 import hooks/ 是**有意的**：
//   它本质上是"接线层"，必须同时认识两边。hooks 不会回头 import 它，所以不存在循环依赖。

import { DATA_CHANGED_EVENT } from './constants'
import { isGuest } from './guestMode'
import { APP_SETTINGS_KEY, DEFAULT_APP_SETTINGS } from '../hooks/useAppSettings'
import { FAVORITES_KEY } from '../hooks/useFavorites'
import { GROUPS_KEY, TOOLS_KEY, readGroups, readTools } from '../hooks/useTools'
import { ORDER_KEY } from '../hooks/useToolOrder'
import type { SyncData } from '../types'

/** 把当前浏览器里的数据打包成要上传的形状。 */
export function readSyncData(): SyncData {
  let defaultCategory = DEFAULT_APP_SETTINGS.defaultCategory
  try {
    const raw = localStorage.getItem(APP_SETTINGS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as { defaultCategory?: unknown }
      if (typeof parsed.defaultCategory === 'string') defaultCategory = parsed.defaultCategory
    }
  } catch {
    // 数据坏了就用默认值，不影响同步其它字段
  }

  return {
    tools: readTools(),
    groups: readGroups(),
    favorites: readList(FAVORITES_KEY),
    order: readList(ORDER_KEY),
    appSettings: { defaultCategory },
  }
}

/**
 * 把云端来的数据写回本地，并广播一声让各个 Hook 重新读。
 *
 * 为什么写完必须广播：各 Hook 用 useState 初始化，只在挂载时读一次 localStorage。
 * 光写存储界面不会变 —— 这也是"同步完看起来没反应"的典型原因。
 */
export function writeSyncData(data: SyncData): void {
  // 访客没有会话，同步本来就不会跑；但这是「云端数据覆盖本地数据」的唯一入口，
  // 加一道闸更保险：是访客就直接返回 —— 不写存储，也不 dispatch DATA_CHANGED_EVENT。
  // 连广播都要跳过，因为广播会让各 Hook 立刻重读一遍，等于承认了这次"写入"。
  if (isGuest()) return
  localStorage.setItem(TOOLS_KEY, JSON.stringify(data.tools))
  localStorage.setItem(GROUPS_KEY, JSON.stringify(data.groups))
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(data.favorites))
  localStorage.setItem(ORDER_KEY, JSON.stringify(data.order))

  // 设置项可能是"老数据 + 新字段"的混合，和 useAppSettings 的读取逻辑保持一致：用默认值兜底
  const settings = { ...DEFAULT_APP_SETTINGS, ...(data.appSettings ?? {}) }
  localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(settings))

  // 标记"这次是云端写回来的变化"。下面的 seq 会变，界面上那个"数据一变就上传"的
  // 监听器据此跳过 —— 否则同步下来的数据会被立刻当成"本地改动"再推上去，
  // 两台设备就会互相把版本号 +1，白白多跑请求。
  remoteApplySeq += 1

  window.dispatchEvent(new Event(DATA_CHANGED_EVENT))
}

// 「云端刚写回本地」的计数器。工具模块会在每次渲染后对比它，发现变了就跳过这次上传。
let remoteApplySeq = 0

/** 供界面判断：当前这个数字如果比上次记的大，说明这次变化来自云端同步。 */
export function getRemoteApplySeq(): number {
  return remoteApplySeq
}

/** 读一个"字符串数组"型的键，坏了就当空数组。 */
function readList(key: string): string[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []
  } catch {
    return []
  }
}