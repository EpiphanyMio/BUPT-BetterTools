// 「文件云同步」的界面入口：把 src/lib/fileSync.ts 的全局状态接到 React 上。
//
// 为什么不把逻辑写进组件：同步状态是全局唯一的（状态行、按钮、将来的角标都要读
// 同一份），各组件自己 useState 会各存一份、互不同步。
// 状态放在 fileSync.ts 的模块顶层，这里只负责订阅。
//
// 为什么用 useSyncExternalStore（照抄 src/hooks/useSync.ts）：
// useState + useEffect 订阅要等渲染完才拿到新值，会先闪一帧旧的；
// useSyncExternalStore 是 React 18 专为"外部全局状态"准备的钩子，
// 渲染前就能同步读到最新值，不会闪也不会漏更新。
//
// ⚠️ getFileSyncState 返回的是**同一个缓存对象**（fileSync.ts 里只在字段变化时
// 才换新对象），所以这里直接返回它即可，不要再包一层对象 —— 每次都新建对象
// 会被 React 判成"一直在变"，无限重渲染直到页面卡死。

import { useSyncExternalStore } from 'react'
import {
  getFileSyncState,
  subscribeFileSync,
  type FileSyncState,
} from '../lib/fileSync'

export function useFileSync(): FileSyncState {
  return useSyncExternalStore(subscribeFileSync, getFileSyncState)
}
