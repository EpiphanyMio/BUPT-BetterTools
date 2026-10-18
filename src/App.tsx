// App.tsx：整个网站的"外壳"。
//
// 它做四件事：
//   ① 登录门禁：没登录只渲染登录界面，主界面一行都不渲染；
//   ② 记住当前打开的是哪个模块，把那个模块渲染出来；
//   ③ 管着「全局搜索」浮层的开关（Ctrl/⌘ + K 随时唤起）；
//   ④ 处理"从搜索结果跳到文件管理某个文件夹"这种跨模块跳转 ——
//      这类"要同时改动两个模块"的状态，只能放在它们共同的父级这里。
//
// 数据流（理解 React 的关键）：
//   useState 保存"当前在哪个模块" → 点入口卡片 setActive(...) → 重新渲染 → 切到对应界面

import { useEffect, useRef, useState } from 'react'
import Home, { type ModuleId } from './components/Home'
import ToolboxModule from './modules/ToolboxModule'
import FilesModule from './modules/FilesModule'
import GlobalSearch from './components/GlobalSearch'
import AuthScreen from './components/AuthScreen'
import { useAuth } from './hooks/useAuth'
import { syncSeedTools } from './hooks/useTools'
import { resetSyncState, setSnapshotApplier, setSyncSource, syncNow } from './lib/sync'
import { readSyncData, writeSyncData } from './lib/syncData'
import type { FileJumpRequest } from './types'

// 应用启动时先做一次「默认清单同步」：把 tools.json 里新增的工具补进浏览器本地数据。
//
// 放在模块顶层（而不是组件里）是有意的 —— 这样能保证它在**任何界面渲染之前**跑完，
// 否则首页读到的工具数量会是旧的。
syncSeedTools()

// 给同步引擎接上"数据从哪读"和"往哪写回"。
//
// 为什么放在模块顶层而不是某个 effect 里：这两个动作只是登记两个函数引用，
// 没登录时同步引擎根本不会发请求（状态停在 unauthenticated），提前接上没有副作用。
// 放进 effect 反而有坑：StrictMode 会把 effect 跑两遍，第一遍的清理函数可能在
// 一次正在进行的同步中途把接线拆掉。
setSyncSource(readSyncData)
setSnapshotApplier(writeSyncData)

export default function App() {
  const { status } = useAuth()

  // null 表示停在首页
  const [active, setActive] = useState<ModuleId | null>(null)

  // 「全局搜索」浮层开着没有
  const [searchOpen, setSearchOpen] = useState(false)

  // 最近一次"跳到某个文件夹"的请求，null 表示没有
  const [fileJump, setFileJump] = useState<FileJumpRequest | null>(null)

  // 云端数据是否已经落地。登录后要先拉一次快照，拉完才显示主界面 ——
  // 否则用户会先看到本机残留（或种子数据），再被云端数据覆盖着跳一下。
  const [cloudReady, setCloudReady] = useState(false)

  // 同一段登录态里只启动一次同步。StrictMode 会把 effect 跑两遍，
  // 没有这个标记就会打两次请求（第二次还会把界面提前放行）。
  const booted = useRef(false)

  useEffect(() => {
    // 还在向服务器确认令牌的时候什么都别动：这时 dirty / revision 都是上一次
    // 会话留下的有效状态，动它会把"还没推上去的改动"抹掉。
    if (status === 'loading') return

    if (status !== 'authenticated') {
      booted.current = false
      setCloudReady(false)
      // 回到未登录：内存里的 revision / 脏标记可能还是**上一个人**的。
      // 拿它和下一个人的云端比大小，会把"云端更新"误判成"本地更新"，
      // 反过来用本地数据覆盖人家的云端 —— 这种事故是静默的，所以这里必须对齐一次。
      resetSyncState()
      return
    }

    if (booted.current) return
    booted.current = true

    // 登录成功：先把云端那份拉下来再放行主界面。
    //
    // 为什么要加超时：syncNow 内部全 catch，断网会很快失败，不会卡在这一屏；
    // 但"网还在、就是不通"的情况（弱网、代理挂住）下 fetch 可能几十秒都不返回，
    // 用户会一直盯着"正在同步"。最多等 BOOT_SYNC_TIMEOUT_MS，到点先放行 ——
    // 晚到的云端数据会由 writeSyncData 广播事件，界面自己会跟着刷新。
    void (async () => {
      try {
        await Promise.race([syncNow(), wait(BOOT_SYNC_TIMEOUT_MS)])
      } finally {
        setCloudReady(true)
      }
    })()
  }, [status])

  const goHome = () => setActive(null)

  // 全局快捷键。
  // 为什么挂在 window 上而不是某个输入框上：
  //   这样不管焦点在哪、当前在哪个模块，按下去都生效。
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // 没登录时主界面根本没渲染，快捷键也不该起作用
      if (status !== 'authenticated') return

      // Ctrl+K / ⌘K：打开或收起搜索。这是各类工具里"快速跳转"的通用约定。
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setSearchOpen((open) => !open)
        return
      }

      // 单独按 / 也打开搜索（很多网站的习惯）。
      // ⚠️ 但正在输入框里打字时绝不能抢 —— 否则用户想在备注里打个斜杠都打不出来。
      if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const target = event.target as HTMLElement | null
        const tag = target?.tagName
        const typing =
          tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable === true
        if (!typing) {
          event.preventDefault()
          setSearchOpen(true)
        }
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [status])

  // 全局搜索点到文件夹 → 切到文件管理，并把目标文件夹告诉它
  function jumpToFolder(folderId: string) {
    // seq 用时间戳：同一个文件夹连点两次，值也不同，FilesModule 那边才知道要再跳一次
    setFileJump({ folderId, seq: Date.now() })
    setActive('files')
  }

  // ---- 登录门禁 ----
  //
  // 三种情况各有一套界面，且都在"渲染主界面"之前返回：
  //   loading       本地存着令牌，正在问服务器它还有效吗（通常几十毫秒）
  //   anonymous     没登录 → 只有 AuthScreen，主界面一行都不渲染
  //   !cloudReady   登录成功了，但云端那份数据还没落地 → 等它
  if (status === 'loading') return <BootScreen text="正在检查登录状态…" />
  if (status === 'anonymous') return <AuthScreen />
  if (!cloudReady) return <BootScreen text="正在同步你的云端数据…" />

  return (
    <>
      {active === 'tools' && (
        <ToolboxModule onBack={goHome} onSearch={() => setSearchOpen(true)} />
      )}
      {active === 'files' && (
        <FilesModule
          onBack={goHome}
          onSearch={() => setSearchOpen(true)}
          jump={fileJump}
        />
      )}
      {active === null && <Home onOpen={setActive} onSearch={() => setSearchOpen(true)} />}

      {/* 搜索浮层放在最外层：任何模块下按 Ctrl+K 都能用 */}
      <GlobalSearch
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onOpenFolder={jumpToFolder}
      />
    </>
  )
}

// 登录后等云端数据的最长时间。超过就先放行，别让人对着过渡页干等。
const BOOT_SYNC_TIMEOUT_MS = 10000

/** 一个"到点就结束"的 Promise，只给上面的 Promise.race 当计时器用。 */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 门禁期间的过渡页：检查登录状态、拉云端数据时要有个交代。
 *
 * 为什么要它：这两步都要等网络。没有过渡页的话，用户会先看到一片空白、
 * 或者上一屏的残留，然后内容突然跳出来 —— 分不清是"在加载"还是"卡住了"。
 */
function BootScreen({ text }: { text: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-6 text-fg">
      <div className="flex flex-col items-center gap-3 text-center">
        {/* 一个"转圈的环"：只写材质和尺寸，颜色用语义令牌，深浅主题自动跟着变 */}
        <span
          aria-hidden="true"
          className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-primary"
        />
        <p className="text-sm text-fg-muted">{text}</p>
      </div>
    </div>
  )
}
