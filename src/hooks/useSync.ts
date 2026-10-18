// 「云端同步」的界面入口：把 src/lib/sync.ts 的全局状态接到 React 上。
//
// ---------------------------------------------------------------- 为什么不把逻辑写进组件
//
// 同步状态是**全局唯一**的：顶栏那个小圆点、设置面板里的按钮，读的必须是同一份。
// 每个组件各自 useState 的话就会各存一份、互不同步 ——
// 在设置面板里填了令牌，顶栏却还显示"未配置"。
// 所以状态放在 sync.ts 的模块顶层，这里只负责"订阅 + 翻译成组件能用的形状"。
//
// ---------------------------------------------------------------- 为什么用 useSyncExternalStore
//
// useState + useEffect 订阅的写法要等渲染完成才拿到新值，中间会先闪一帧旧的；
// useSyncExternalStore 是 React 18 专为"外部全局状态"准备的钩子，
// React 在渲染前就能同步读到最新值，不会闪，也不会漏掉订阅期间的更新。
//
// ⚠️ 关键点：getSnapshot 必须返回**同一个对象引用**。
//   React 用 Object.is 比较前后两次结果，每次返回新对象会被判成"一直在变"，
//   于是不停重渲染，直到页面卡死。sync.ts 的 getSyncState() 返回的是缓存好的
//   state，只有字段真的变了才换新对象 —— useTheme.ts 也是同一个套路。

import { useSyncExternalStore } from 'react'
import { getSyncState, setToken, subscribeSync, syncNow } from '../lib/sync'

export function useSync() {
  const state = useSyncExternalStore(subscribeSync, getSyncState)

  return {
    status: state.status,
    revision: state.revision,
    lastSyncedAt: state.lastSyncedAt,
    lastError: state.lastError,
    // 判据用状态机而不是再读一次令牌：两者是同一件事，
    // 但用状态能保证"界面显示"和"状态机"永远一致，不会出现一处已连接、一处说未配置。
    isConfigured: state.status !== 'unconfigured',
    // 下面两个是模块级函数，引用永远不变，不需要 useCallback 包一层，
    // 直接拿去当 onClick 也不会导致子组件重渲染。
    // syncNow 内部全 catch 过，不需要 .catch()，也不会把异常抛到事件处理里。
    syncNow,
    setToken,
  }
}
