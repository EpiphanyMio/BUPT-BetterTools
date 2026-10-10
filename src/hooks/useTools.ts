// 管理"工具列表"和"分组列表"，并保存到浏览器本地。
//
// 数据来源分两步：
//   1. 第一次打开时，用 src/data/tools.json 作为"种子数据"；
//   2. 之后你在页面上做的任何增删改，都会保存到 localStorage，
//      从此以浏览器里存的为准。（想回到初始状态，用弹窗里的"恢复默认数据"）

import { useCallback, useEffect, useState } from 'react'
import seedToolsData from '../data/tools.json'
import type { Tool, ToolDraft } from '../types'

const TOOLS_KEY = 'better-tools:tools'
const GROUPS_KEY = 'better-tools:groups'

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

  // ---------- 分组 ----------
  const addGroup = useCallback((name: string) => {
    const clean = name.trim()
    if (!clean) return
    setGroups((prev) => (prev.includes(clean) ? prev : [...prev, clean]))
  }, [])

  const removeGroup = useCallback((name: string) => {
    setGroups((prev) => prev.filter((group) => group !== name))
    // 分组没了，组里的工具也一起删掉
    setTools((prev) => prev.filter((tool) => tool.category !== name))
  }, [])

  // ---------- 工具 ----------
  const addTool = useCallback((category: string, draft: ToolDraft) => {
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
    setTools((prev) =>
      prev.map((tool) => (tool.id === id ? { ...tool, category } : tool)),
    )
  }, [])

  const removeTool = useCallback((id: string) => {
    setTools((prev) => prev.filter((tool) => tool.id !== id))
  }, [])

  const resetAll = useCallback(() => {
    setTools([...seedTools])
    setGroups([...seedGroups])
  }, [])

  return {
    tools,
    groups,
    addGroup,
    removeGroup,
    addTool,
    updateTool,
    moveTool,
    removeTool,
    resetAll,
  }
}
