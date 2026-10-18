// 自定义 Hook：记录"工具的显示顺序"，并保存到浏览器本地。
// 和收藏一样，刷新页面、关掉再打开，顺序都还记得。

import { useEffect, useState } from 'react'
import { DATA_CHANGED_EVENT } from '../lib/constants'

// 键名导出给 src/lib/syncData.ts 用（云端同步要按同样的键写回）
export const ORDER_KEY = 'better-tools:order'

export function useToolOrder(allIds: string[]) {
  const [order, setOrder] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(ORDER_KEY)
      const saved = raw ? (JSON.parse(raw) as string[]) : []
      // 只保留"现在还存在"的工具；新加进来的工具补到末尾
      const valid = saved.filter((id) => allIds.includes(id))
      const missing = allIds.filter((id) => !valid.includes(id))
      return [...valid, ...missing]
    } catch {
      return allIds
    }
  })

  // 工具被新增或删除后，同步一次顺序：
  // 删掉的工具不留残影，新加的工具排到最后。
  useEffect(() => {
    setOrder((prev) => {
      const valid = prev.filter((id) => allIds.includes(id))
      const missing = allIds.filter((id) => !valid.includes(id))
      // 没有变化就返回原数组，避免无限循环
      if (valid.length === prev.length && missing.length === 0) return prev
      return [...valid, ...missing]
    })
  }, [allIds])

  useEffect(() => {
    localStorage.setItem(ORDER_KEY, JSON.stringify(order))
  }, [order])

  // 别处改了 localStorage（云端同步写回）时重新读。
  // 依赖里带上 allIds：读到的顺序要按"当前实际存在的工具"重新对齐一次。
  useEffect(() => {
    function reload() {
      try {
        const raw = localStorage.getItem(ORDER_KEY)
        const saved = raw ? (JSON.parse(raw) as string[]) : []
        const valid = saved.filter((id) => allIds.includes(id))
        const missing = allIds.filter((id) => !valid.includes(id))
        setOrder([...valid, ...missing])
      } catch {
        setOrder(allIds)
      }
    }
    window.addEventListener(DATA_CHANGED_EVENT, reload)
    return () => window.removeEventListener(DATA_CHANGED_EVENT, reload)
  }, [allIds])

  return { order, setOrder }
}
