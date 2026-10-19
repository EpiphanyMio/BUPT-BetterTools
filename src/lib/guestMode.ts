// 「访客预览」模式：不登录也能进来看看，但**一切写操作都挡掉**。
//
// ---------------------------------------------------------------- 为什么要单独一个模块
//
// "只读"这件事必须只有一个判据。如果每个组件自己存一个 `readOnly` state，
// 就会出现"这里禁用了、那里忘了禁用" —— 而且忘了的那处是**静默**的，
// 用户点一下就把数据改了，没有任何报错。
//
// 所以开关放在模块顶层，组件通过 useGuest() 订阅它，
// 数据层的写函数则在入口处直接问 isGuest() —— **两处都查，谁也不依赖谁**。
//
// ---------------------------------------------------------------- 为什么放 localStorage
//
// 访客点了刷新（F5）应该还在访客模式里，否则一刷新就被弹回登录页，
// 体验上像是"预览被打断了"。退出访客模式的唯一方式是点「去登录」或登录成功。

export const GUEST_KEY = 'better-tools:guest-mode'

// 订阅者集合：组件通过 subscribeGuest 挂进来，状态一变就被通知。
// 和 src/lib/auth.ts / sync.ts 是同一套路（配合 useSyncExternalStore）。
const listeners = new Set<() => void>()

function readInitial(): boolean {
  try {
    return localStorage.getItem(GUEST_KEY) === '1'
  } catch {
    // 隐私模式下 localStorage 可能直接抛异常。这时当成"不是访客"，
    // 因为如果连标记都存不住，访客模式本身也没法可靠维持。
    return false
  }
}

let guest = readInitial()

function emit(): void {
  for (const listener of listeners) listener()
}

function persist(next: boolean): void {
  try {
    if (next) localStorage.setItem(GUEST_KEY, '1')
    else localStorage.removeItem(GUEST_KEY)
  } catch {
    // 存不住就算了，内存里的状态仍然是对的 —— 只是刷新后会回到登录页。
  }
}

/** 当前是不是访客（只读）模式。数据层的写函数全部在入口处查这一个函数。 */
export function isGuest(): boolean {
  return guest
}

/** 进入访客预览模式。 */
export function enterGuestMode(): void {
  if (guest) return
  guest = true
  persist(true)
  emit()
}

/** 退出访客模式（登录成功、或点「去登录」时调用）。 */
export function exitGuestMode(): void {
  if (!guest) return
  guest = false
  persist(false)
  emit()
}

/** 给 useSyncExternalStore 用：返回 boolean，天然是稳定值，不会像对象那样每次比较都不等。 */
export function getGuestSnapshot(): boolean {
  return guest
}

export function subscribeGuest(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}