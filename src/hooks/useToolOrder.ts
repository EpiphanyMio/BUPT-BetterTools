// 自定义 Hook：记录"工具的显示顺序"，并保存到浏览器本地。
// 和收藏一样，刷新页面、关掉再打开，顺序都还记得。

import { useCallback, useEffect, useState } from 'react'
import { DATA_CHANGED_EVENT } from '../lib/constants'
import { isGuest } from '../lib/guestMode'

// 键名导出给 src/lib/syncData.ts 用（云端同步要按同样的键写回）
export const ORDER_KEY = 'better-tools:order'

export function useToolOrder(allIds: string[]) {
  // 注意这里没直接把 useState 的 setter 叫 setOrder：
  // 下面会另包一个带访客守卫的 setOrder 对外导出，
  // 而 hook 内部自己要调的（把新增工具补进顺序那几处）必须绕过守卫，
  // 所以内部一律用 applyOrder 这个名字，两个用途一眼能分开。
  const [order, applyOrder] = useState<string[]>(() => {
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
  // 这里用 applyOrder：补顺序属于本机一致性维护，不算用户改内容，访客也要补。
  useEffect(() => {
    applyOrder((prev) => {
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
        applyOrder([...valid, ...missing])
      } catch {
        applyOrder(allIds)
      }
    }
    window.addEventListener(DATA_CHANGED_EVENT, reload)
    return () => window.removeEventListener(DATA_CHANGED_EVENT, reload)
  }, [allIds])

  // 对外暴露的 setOrder：访客预览时直接返回，拖拽排序改不动任何东西。
  // 为什么用 useCallback 包一层（而不是直接把 useState 的 setter 抛出去）：
  //   ① 需要一处能插守卫的地方；
  //   ② 组件会把它放进依赖数组，引用必须稳定，否则每次渲染都是新函数，
  //      依赖它的 effect / useCallback 会跟着反复重建。
  // 依赖只放 applyOrder —— 它是 useState 的 setter，引用永远不变，所以实际也永远稳定。
  const setOrder = useCallback(
    (next: string[] | ((prev: string[]) => string[])) => {
      // 访客只读：拦在这里，拖拽排序对本地数据不起作用
      if (isGuest()) return
      applyOrder(next)
    },
    [applyOrder],
  )

  return { order, setOrder }
}
