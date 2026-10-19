// 管理"工具列表"和"分组列表"，并保存到浏览器本地。
//
// 数据来源分两步：
//   1. 第一次打开时，用 src/data/tools.json 作为"种子数据"；
//   2. 之后你在页面上做的任何增删改，都会保存到 localStorage，
//      从此以浏览器里存的为准。（想回到初始状态，用弹窗里的"恢复默认数据"）

import { useCallback, useEffect, useMemo, useState } from 'react'
import seedToolsData from '../data/tools.json'
import { DATA_CHANGED_EVENT, SEED_VERSION } from '../lib/constants'
import { isGuest } from '../lib/guestMode'
import type { Tool, ToolDraft } from '../types'

// 键名导出给 src/lib/syncData.ts 用 —— 云端同步要按同样的键写回本地。
// 让所有地方共用这一个常量，避免"两处各写一遍字符串、改一处忘一处"。
export const TOOLS_KEY = 'better-tools:tools'
export const GROUPS_KEY = 'better-tools:groups'
const SEED_VERSION_KEY = 'better-tools:seed-version'

const seedTools = seedToolsData as Tool[]

// 默认分组：先放"教务"，再把种子数据里出现过的分类按顺序补上
const seedGroups = (() => {
  const set = new Set<string>(['教务'])
  seedTools.forEach((tool) => set.add(tool.category))
  return [...set]
})()

// 从浏览器本地读；读不到或格式坏了，就用默认值
function loadFromStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

// 生成一个不容易重复的 id
function createId() {
  try {
    return 'tool-' + crypto.randomUUID()
  } catch {
    return 'tool-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  }
}

// 判断两个网址是不是"同一个链接"：忽略首尾空白、结尾斜杠和大小写差异
function normalizeUrl(url: string) {
  return url.trim().replace(/\/+$/, '').toLowerCase()
}

export function useTools() {
  const [tools, setTools] = useState<Tool[]>(() =>
    loadFromStorage(TOOLS_KEY, [...seedTools]),
  )
  const [groups, setGroups] = useState<string[]>(() =>
    loadFromStorage(GROUPS_KEY, [...seedGroups]),
  )

  // 每次变化就写回浏览器本地
  useEffect(() => {
    localStorage.setItem(TOOLS_KEY, JSON.stringify(tools))
  }, [tools])

  useEffect(() => {
    localStorage.setItem(GROUPS_KEY, JSON.stringify(groups))
  }, [groups])

  // 别处直接改了 localStorage（典型场景：云端同步把远端数据写回本地）时，重新读一遍。
  // 为什么必须显式监听：useState 的初始值**只在首次挂载时算一次**，
  // 之后 localStorage 变了它根本不知道，界面会一直显示旧数据。
  useEffect(() => {
    function reload() {
      setTools(loadFromStorage<Tool[]>(TOOLS_KEY, [...seedTools]))
      setGroups(loadFromStorage<string[]>(GROUPS_KEY, [...seedGroups]))
    }
    window.addEventListener(DATA_CHANGED_EVENT, reload)
    return () => window.removeEventListener(DATA_CHANGED_EVENT, reload)
  }, [])

  // ---------- 分组 ----------
  const addGroup = useCallback((name: string) => {
    // 访客预览是「只读」的：界面上把按钮禁掉只是提示，总会有漏禁的地方，
    // 真正的保证在数据层 —— 每个写操作入口都先问一次 isGuest()，是访客就直接返回，
    // 状态一个字节都不变。下面每个写函数都照这个格式加了一道，原因相同。
    if (isGuest()) return
    const clean = name.trim()
    if (!clean) return
    setGroups((prev) => (prev.includes(clean) ? prev : [...prev, clean]))
  }, [])

  const removeGroup = useCallback((name: string) => {
    // 访客只读：删分组会连带删掉组里的工具，更不能放行
    if (isGuest()) return
    setGroups((prev) => prev.filter((group) => group !== name))
    // 分组没了，组里的工具也一起删掉
    setTools((prev) => prev.filter((tool) => tool.category !== name))
  }, [])

  // 调整分组的排列顺序（拖动分组标签时调用）
  //
  // 这里不需要额外存一份"顺序表"：groups 数组本身就有顺序，
  // 数组里靠前的分组，标签就排在前面。所以"排序"就是把数组元素换个位置。
  const reorderGroups = useCallback((from: number, to: number) => {
    // 访客只读：拖动分组改顺序也算改内容
    if (isGuest()) return
    setGroups((prev) => {
      // 原地不动或下标越界：返回原数组。
      // 返回同一个引用，React 就知道"没变化"，不会触发多余的重新渲染。
      if (from === to) return prev
      if (from < 0 || to < 0 || from >= prev.length || to >= prev.length) return prev

      const next = [...prev] // 先复制一份，不要直接改原数组
      const [moved] = next.splice(from, 1) // 把自己从原位置取出来
      next.splice(to, 0, moved) // 插到新位置
      return next
    })
  }, [])

  // ---------- 工具 ----------
  const addTool = useCallback((category: string, draft: ToolDraft) => {
    // 访客只读：不许新增工具
    if (isGuest()) return
    setTools((prev) => [
      ...prev,
      {
        id: createId(),
        name: draft.name,
        url: draft.url,
        icon: draft.icon || undefined,
        description: draft.description,
        category,
      },
    ])
  }, [])

  const updateTool = useCallback((id: string, draft: ToolDraft) => {
    // 访客只读：不许改工具信息
    if (isGuest()) return
    setTools((prev) =>
      prev.map((tool) =>
        tool.id === id
          ? {
              ...tool,
              name: draft.name,
              url: draft.url,
              icon: draft.icon || undefined,
              description: draft.description,
            }
          : tool,
      ),
    )
  }, [])

  // 把某个工具移到另一个分组
  const moveTool = useCallback((id: string, category: string) => {
    // 访客只读：换分组也是写
    if (isGuest()) return
    setTools((prev) =>
      prev.map((tool) => (tool.id === id ? { ...tool, category } : tool)),
    )
  }, [])

  const removeTool = useCallback((id: string) => {
    // 访客只读：不许删工具
    if (isGuest()) return
    setTools((prev) => prev.filter((tool) => tool.id !== id))
  }, [])

  const resetAll = useCallback(() => {
    // 访客只读：恢复默认会覆盖掉本地数据，是最危险的一个写操作
    if (isGuest()) return
    setTools([...seedTools])
    setGroups([...seedGroups])
  }, [])

  // 把「默认清单」里还没有的内容补充进来（只做加法，返回补了几个工具）。
  //
  // 为什么需要这个操作：src/data/tools.json 只在"浏览器里还没有任何数据"时才会被采用。
  // 一旦你在页面上改过东西，数据就存进 localStorage 了 —— 之后默认清单再更新，
  // 你的浏览器也不会自动看到。这个操作把缺的补上，已经有的和你自己加的一概不动。
  const mergeSeed = useCallback(() => {
    // 访客只读：合并默认清单会往本地加数据，属于写。
    // ⚠️ 它有返回值（补了几个工具），所以返回 0 而不是 undefined ——
    // 界面拿这个数字弹提示，返回 undefined 会显示成 NaN。
    if (isGuest()) return 0
    const existingUrls = new Set(tools.map((tool) => normalizeUrl(tool.url)))
    const missingTools = seedTools.filter(
      (tool) => !existingUrls.has(normalizeUrl(tool.url)),
    )

    if (missingTools.length > 0) {
      // 复制一份再加进去，不要直接改 seedTools 本身
      setTools((prev) => [...prev, ...missingTools.map((tool) => ({ ...tool }))])
    }

    const missingGroups = seedGroups.filter((group) => !groups.includes(group))
    if (missingGroups.length > 0) {
      setGroups((prev) => [...prev, ...missingGroups])
    }

    return missingTools.length
  }, [tools, groups])

  // 默认清单里有、但当前数据里还没有的工具数量。
  // 界面用它在「编辑分组」弹窗顶部显示一条提示，用户不用往下滚就能看到。
  const missingSeedCount = useMemo(() => {
    const existingUrls = new Set(tools.map((tool) => normalizeUrl(tool.url)))
    return seedTools.filter((tool) => !existingUrls.has(normalizeUrl(tool.url))).length
  }, [tools])

  return {
    tools,
    groups,
    addGroup,
    removeGroup,
    reorderGroups,
    addTool,
    updateTool,
    moveTool,
    removeTool,
    mergeSeed,
    missingSeedCount,
    resetAll,
  }
}

/**
 * 应用启动时调用一次：把默认清单里新增的工具补进本地数据。
 *
 * 为什么需要：默认清单只在"浏览器里还没有任何数据"时才会被采用，
 * 所以往 tools.json 里加了新工具，已经在用的浏览器不会自动看到 ——
 * 以前得手动点「补充默认清单」按钮，很容易忘。
 * 这里用 SEED_VERSION 做标记：本地记的版本比当前低就补一次，然后记上新版本。
 * 只做加法：已经有的、以及你自己添加或改过的一概不动。
 *
 * ⚠️ 它必须是**普通函数**而不是 Hook 里的 useEffect ——
 * 因为 useTools 这个 Hook 只在「常用工具」模块挂载，
 * 停在首页时根本不会执行，首页读到的数量就会是旧的。
 */
export function syncSeedTools(): void {
  try {
    const stored = Number(localStorage.getItem(SEED_VERSION_KEY) ?? 0)
    if (stored >= SEED_VERSION) return

    const currentTools = loadFromStorage<Tool[]>(TOOLS_KEY, [...seedTools])
    const existingUrls = new Set(currentTools.map((tool) => normalizeUrl(tool.url)))
    const missingTools = seedTools.filter((tool) => !existingUrls.has(normalizeUrl(tool.url)))

    const currentGroups = loadFromStorage<string[]>(GROUPS_KEY, [...seedGroups])
    const missingGroups = seedGroups.filter((group) => !currentGroups.includes(group))

    if (missingTools.length > 0) {
      localStorage.setItem(
        TOOLS_KEY,
        JSON.stringify([...currentTools, ...missingTools.map((tool) => ({ ...tool }))]),
      )
    }
    if (missingGroups.length > 0) {
      localStorage.setItem(GROUPS_KEY, JSON.stringify([...currentGroups, ...missingGroups]))
    }
    localStorage.setItem(SEED_VERSION_KEY, String(SEED_VERSION))
  } catch {
    // 浏览器禁用了本地存储时静默跳过，不影响其它功能
  }
}

/**
 * 给「全局搜索」用：直接读一次本地存着的工具列表。
 *
 * 为什么不用 useTools() 这个 Hook：
 *   Hook 会订阅数据变化并触发重新渲染。搜索浮层每次打开读一次就够了，
 *   没必要常驻一份状态 —— 何况浮层挂在 App 上，用 Hook 等于让整个应用跟着重渲染。
 */
export function readTools(): Tool[] {
  return loadFromStorage<Tool[]>(TOOLS_KEY, [...seedTools])
}

/** 给「云端同步」用：直接读一次分组列表，不订阅变化。 */
export function readGroups(): string[] {
  return loadFromStorage<string[]>(GROUPS_KEY, [...seedGroups])
}

/**
 * 给首页用：不挂载整个工具箱，只读一次本地数据算个数量。
 * 这样首页不必依赖工具箱模块内部的状态。
 */
export function readToolCounts() {
  const storedTools = loadFromStorage<Tool[]>(TOOLS_KEY, [...seedTools])
  const storedGroups = loadFromStorage<string[]>(GROUPS_KEY, [...seedGroups])
  return { toolCount: storedTools.length, groupCount: storedGroups.length }
}
