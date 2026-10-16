// 主题（浅色 / 深色 / 跟随系统）管理器。
//
// ---------------------------------------------------------------- 原理
//
// ① 颜色是怎么变的？
//    CSS 变量（见 google.css）里写的是：
//        --token-canvas: light-dark(#f8f9fa, #131314)
//    这个 light-dark() 会自己看"当前 color-scheme 是浅还是深"来取值。
//    而 color-scheme 默认写成 `light dark` 就表示"跟随系统"。
//    所以"跟随系统"这个需求，一行 CSS 就够了，不需要 JS 参与。
//
// ② 那 JS 干什么？
//    只处理"用户手动指定深浅"这一种情况：
//    把 <html> 的 color-scheme 显式设成 'light' 或 'dark'，就覆盖了系统的判断；
//    清空它，又回到跟随系统。三个状态的映射关系就三行代码。
//
// ③ 为什么用 useSyncExternalStore 而不是普通的 useState？
//    因为"当前主题"是**全局唯一**的状态：头部的切换按钮和设置弹窗里的三个选项
//    都要读它、都要改它。如果各自用 useState，就会出现"弹窗里显示浅色、
//    按钮却显示深色"的错位。
//    useSyncExternalStore 是 React 18 专门为这种"外部全局状态"准备的 Hook：
//    所有组件订阅同一份数据，谁改了都会立刻通知全部订阅者重新渲染。
//
// ---------------------------------------------------------------- 存储
//
// localStorage 里存的是"模式"（system / light / dark），不是"当前是深是浅"。
// 为什么？因为用户选的是"跟随系统"这个**意图**。
// 如果只存"当前是浅色"，那么第二天用户把系统改成深色，网页就不会跟着变了。
// 存意图，才能让"跟随系统"长期有效。

import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'better-tools:theme'

export type ThemeMode = 'system' | 'light' | 'dark'

/** 设置面板里的三个选项 */
export const THEME_OPTIONS: { value: ThemeMode; label: string; icon: string }[] = [
  { value: 'system', label: '跟随系统', icon: '🖥' },
  { value: 'light', label: '浅色', icon: '☀️' },
  { value: 'dark', label: '深色', icon: '🌙' },
]

/** 把模式应用到页面。
 *
 * 要做两件事，缺一不可：
 *   ① 设 data-theme 属性 —— 真正决定颜色的是它。
 *      google.css 里有 :root[data-theme='dark'] { ... } 这样的规则直接覆盖颜色变量。
 *      为什么不能只靠 ②：CSS 规范里 color-scheme 不会反向改变
 *      prefers-color-scheme 媒体查询的结果，而构建工具生成的兼容写法正是靠媒体查询
 *      判断深浅的，所以只改 color-scheme 手动切换会失效（详见 google.css 的说明）。
 *   ② 设 color-scheme —— 它管的是"浏览器自带的部件"，比如滚动条、
 *      表单控件、以及 <input type="date"> 的日历弹层配色。
 *      'system' 时清空，回到 CSS 里声明的 light dark（跟随系统）。
 */
function applyMode(mode: ThemeMode) {
  const root = document.documentElement
  root.style.colorScheme = mode === 'system' ? '' : mode

  if (mode === 'system') {
    root.removeAttribute('data-theme')
  } else {
    root.setAttribute('data-theme', mode)
  }
}

/** 从 localStorage 读模式。读到坏数据就退回"跟随系统"。 */
function readStoredMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  } catch {
    // 隐私模式下 localStorage 会直接抛错，忽略即可
  }
  return 'system'
}

/** 读网址参数 ?theme=xxx。
 *
 * 它只在**首次渲染前**参与"初始值"的推断，不会被写进 localStorage ——
 * 也就是说它是一次性的临时覆盖：把参数去掉刷新，就回到用户原本的持久设置。
 *
 * ⚠️ 这里必须和 index.html 里的内联防闪烁脚本读同一个参数。
 *   内联脚本负责"抢在首次绘制前"把颜色定下来（避免闪白），
 *   而本文件负责"React 接管之后"继续维持同一个值。
 *   两边如果读的不是同一个来源，React 一挂载就会把颜色改回去 ——
 *   这正是之前踩过的 bug：内联脚本设了浅色，React 却按默认的 system 又抹掉了。
 */
function readUrlMode(): ThemeMode | null {
  try {
    const raw = new URLSearchParams(window.location.search).get('theme')
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  } catch {
    // 某些环境下 URLSearchParams 可能不可用，忽略即可
  }
  return null
}

/** 初始模式：网址参数优先于本地保存值 */
function readInitialMode(): ThemeMode {
  return readUrlMode() ?? readStoredMode()
}

// ------------------------------------------------------------- 全局状态

// 当前模式。模块级变量 = 整个应用只有这一份。
// 初值考虑网址参数，否则 React 一挂载就会覆盖掉 index.html 里内联脚本设好的主题。
let currentMode: ThemeMode = readInitialMode()

// 所有订阅者的回调。谁调用了 useTheme，谁就在这个集合里。
const listeners = new Set<() => void>()

// 当前系统是深还是浅，只用来在界面上显示一行状态文字
let systemDark =
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-color-scheme: dark)').matches

// 缓存一份快照对象。
// ⚠️ 为什么必须缓存？React 用 Object.is 比较"上次的快照"和"这次的快照"，
// 如果每次调用 getSnapshot 都新建一个对象，引用永远不同，
// React 会认为数据一直在变，从而导致无限重渲染。
let snapshot = { mode: currentMode, systemDark }

function emit() {
  snapshot = { mode: currentMode, systemDark }
  listeners.forEach((notify) => notify())
}

/** 切换模式：改变量 → 应用到页面 → 存盘 → 通知所有订阅者 */
export function setThemeMode(next: ThemeMode) {
  currentMode = next
  applyMode(next)
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // 存不进去也不影响本次使用
  }

  // 用户一旦手动选了主题，就把网址里的 ?theme= 参数去掉。
  // 否则下次刷新时"参数优先"的规则会让他的手动选择看起来没生效 ——
  // 用户会觉得"我明明选了深色，刷新又变回去了"。
  // 用 replaceState 而不是 pushState：不产生新的历史记录，浏览器"后退"行为不变。
  try {
    const url = new URL(window.location.href)
    if (url.searchParams.has('theme')) {
      url.searchParams.delete('theme')
      window.history.replaceState(null, '', url.pathname + url.search + url.hash)
    }
  } catch {
    // 改不了网址也不影响主题本身
  }

  emit()
}

// 页面加载时先把保存的模式应用一次。
// （index.html 里还有一份内联脚本做同样的事，目的是抢在首次绘制前执行、避免闪白。
//   这里再执行一次是幂等的，不会有副作用。）
applyMode(currentMode)

// 监听系统深浅变化：这样用户选"跟随系统"时，改系统设置页面会立刻跟着变；
// 界面上的状态文字也能保持准确。
// addEventListener('change') 比定时轮询好：浏览器只在真正变化时通知一次，零开销。
if (typeof window !== 'undefined') {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
    systemDark = event.matches
    emit()
  })
}

/** 订阅函数，交给 useSyncExternalStore 用 */
function subscribe(notify: () => void) {
  listeners.add(notify)
  return () => listeners.delete(notify)
}

/** 快照函数：返回同一份缓存对象，保证引用稳定 */
function getSnapshot() {
  return snapshot
}

// ------------------------------------------------------------- 对外 Hook

export function useTheme() {
  const { mode, systemDark: dark } = useSyncExternalStore(subscribe, getSnapshot)

  return {
    mode,
    setTheme: setThemeMode,
    // 当前"实际显示出来"的是深还是浅（跟随系统时就是系统那个值）
    resolved: (mode === 'system' ? (dark ? 'dark' : 'light') : mode) as 'light' | 'dark',
    systemDark: dark,
  }
}
