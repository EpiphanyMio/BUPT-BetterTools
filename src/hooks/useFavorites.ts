// 自定义 Hook：把"收藏"功能单独抽出来，让 App.tsx 保持干净。
// Hook 就是"以 use 开头的函数"，里面可以放状态和副作用。

import { useEffect, useState } from 'react'
import { DATA_CHANGED_EVENT } from '../lib/constants'
import { isGuest } from '../lib/guestMode'

// 键名导出给 src/lib/syncData.ts 用（云端同步要按同样的键写回）
export const FAVORITES_KEY = 'better-tools:favorites'

export function useFavorites() {
  // useState 的参数写成函数，表示"只在第一次渲染时算一次"。
  // 这里做的是：打开网页时，从浏览器本地读取之前收藏的 id。
  const [favorites, setFavorites] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(FAVORITES_KEY)
      return raw ? (JSON.parse(raw) as string[]) : []
    } catch {
      return []
    }
  })

  // useEffect：favorites 每次变化后，都写回浏览器本地。
  // 第二个参数 [favorites] 是"依赖数组"——只有它变了才重新执行。
  useEffect(() => {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites))
  }, [favorites])

  // 别处改了 localStorage（云端同步写回）时重新读，否则界面不会刷新
  useEffect(() => {
    function reload() {
      try {
        const raw = localStorage.getItem(FAVORITES_KEY)
        setFavorites(raw ? (JSON.parse(raw) as string[]) : [])
      } catch {
        setFavorites([])
      }
    }
    window.addEventListener(DATA_CHANGED_EVENT, reload)
    return () => window.removeEventListener(DATA_CHANGED_EVENT, reload)
  }, [])

  // 切换收藏：已经收藏就移除，没收藏就加进去。
  // setFavorites 传函数形式，能拿到"最新的旧值" prev，避免并发更新出错。
  function toggleFavorite(id: string) {
    // 访客预览是「只读」的：收藏也是一份数据，界面漏禁了也得在这里拦住。
    if (isGuest()) return
    setFavorites((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }

  function isFavorite(id: string) {
    return favorites.includes(id)
  }

  return { favorites, toggleFavorite, isFavorite }
}
