// 「访客预览」模式的界面入口：把 src/lib/guestMode.ts 的全局开关接到 React 上。
//
// 为什么用 useSyncExternalStore：和 useAuth / useSync 同一个理由 ——
// 开关是全局唯一的，但顶部的只读横幅、各个"禁用"按钮、登录页的入口按钮
// 读的必须是同一份。各自 useState 就会各存一份，登录页点了没人知道。

import { useSyncExternalStore } from 'react'
import { enterGuestMode, exitGuestMode, getGuestSnapshot, subscribeGuest } from '../lib/guestMode'

export function useGuest() {
  const guest = useSyncExternalStore(subscribeGuest, getGuestSnapshot)

  return {
    /** 当前是不是访客（只读）模式 */
    isGuest: guest,
    enterGuest: enterGuestMode,
    exitGuest: exitGuestMode,
  }
}