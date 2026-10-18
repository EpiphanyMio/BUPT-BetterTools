// 「登录 / 注册」的界面入口：把 src/lib/auth.ts 的全局状态接到 React 上。
//
// 为什么不把逻辑写进组件：登录状态是**全局唯一**的 —— 登录门禁、设置里的账号信息、
// 开发者设置里的邀请码区块读的必须是同一份。各组件自己 useState 就会各存一份，
// 在登录页登录成功，App 那边却还以为没登录。
//
// 为什么用 useSyncExternalStore（和 useSync.ts 同一个理由）：
//   状态在模块顶层，React 在渲染前就能同步读到最新值，不会先闪一帧旧的，
//   也不会漏掉"订阅之前就发生的更新"。
//   ⚠️ getSnapshot 必须返回同一个对象引用，否则每次比较都判定"变了"，会无限重渲染 ——
//   auth.ts 的 getAuthState() 返回的是缓存好的 state，只有字段真的变了才换新对象。

import { useEffect, useSyncExternalStore } from 'react'
import {
  ensureAuthStarted,
  getAuthState,
  login,
  logout,
  register,
  subscribeAuth,
} from '../lib/auth'

export function useAuth() {
  // 启动校验（有令牌就 GET /api/auth/me）在这里触发：
  // 放在 useAuth 里而不是 App 里，是为了"任何用到登录状态的组件都能保证它启动过"。
  // StrictMode 会把 effect 跑两遍，ensureAuthStarted 内部有 started 标记兜住。
  useEffect(() => {
    ensureAuthStarted()
  }, [])

  const state = useSyncExternalStore(subscribeAuth, getAuthState)

  return {
    status: state.status,
    user: state.user,
    // 只认服务器给的 isAdmin。它是登录 / 注册 / /me 响应里的值，没有落盘，
    // 改 localStorage 伪造不出来；真正的写权限也由服务端 403 兜底。
    isAdmin: state.user?.isAdmin === true,
    lastError: state.lastError,
    // 下面几个是模块级函数，引用永远不变，不需要 useCallback 包一层，
    // 直接拿去当 onSubmit / onClick 也不会导致子组件重渲染。
    login,
    register,
    logout,
  }
}
