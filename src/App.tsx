// App.tsx：整个网站的"外壳"。
//
// 它做三件事：
//   ① 记住当前打开的是哪个模块，把那个模块渲染出来；
//   ② 管着「全局搜索」浮层的开关（Ctrl/⌘ + K 随时唤起）；
//   ③ 处理"从搜索结果跳到文件管理某个文件夹"这种跨模块跳转 ——
//      这类"要同时改动两个模块"的状态，只能放在它们共同的父级这里。
//
// 数据流（理解 React 的关键）：
//   useState 保存"当前在哪个模块" → 点入口卡片 setActive(...) → 重新渲染 → 切到对应界面

import { useEffect, useState } from 'react'
import Home, { type ModuleId } from './components/Home'
import ToolboxModule from './modules/ToolboxModule'
import FilesModule from './modules/FilesModule'
import GlobalSearch from './components/GlobalSearch'
import { syncSeedTools } from './hooks/useTools'
import type { FileJumpRequest } from './types'

// 应用启动时先做一次「默认清单同步」：把 tools.json 里新增的工具补进浏览器本地数据。
//
// 放在模块顶层（而不是组件里）是有意的 —— 这样能保证它在**任何界面渲染之前**跑完，
// 否则首页读到的工具数量会是旧的。
syncSeedTools()

export default function App() {
  // null 表示停在首页
  const [active, setActive] = useState<ModuleId | null>(null)

  // 「全局搜索」浮层开着没有
  const [searchOpen, setSearchOpen] = useState(false)

  // 最近一次"跳到某个文件夹"的请求，null 表示没有
  const [fileJump, setFileJump] = useState<FileJumpRequest | null>(null)

  const goHome = () => setActive(null)

  // 全局快捷键。
  // 为什么挂在 window 上而不是某个输入框上：
  //   这样不管焦点在哪、当前在哪个模块，按下去都生效。
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
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
  }, [])

  // 全局搜索点到文件夹 → 切到文件管理，并把目标文件夹告诉它
  function jumpToFolder(folderId: string) {
    // seq 用时间戳：同一个文件夹连点两次，值也不同，FilesModule 那边才知道要再跳一次
    setFileJump({ folderId, seq: Date.now() })
    setActive('files')
  }

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
