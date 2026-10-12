// App.tsx：整个网站的"外壳"。
//
// 它只做一件事：记住当前打开的是哪个模块，然后把那个模块渲染出来。
// 各模块自己管自己的数据 —— 工具箱用 localStorage，文件管理用 IndexedDB。
//
// 数据流（理解 React 的关键）：
//   useState 保存"当前在哪个模块"  →  点入口卡片 setActive(...)  →  重新渲染  →  切到对应界面

import { useState } from 'react'
import Home, { type ModuleId } from './components/Home'
import ToolboxModule from './modules/ToolboxModule'
import FilesModule from './modules/FilesModule'

export default function App() {
  // null 表示停在首页
  const [active, setActive] = useState<ModuleId | null>(null)
  const goHome = () => setActive(null)

  if (active === 'tools') return <ToolboxModule onBack={goHome} />
  if (active === 'files') return <FilesModule onBack={goHome} />
  return <Home onOpen={setActive} />
}
