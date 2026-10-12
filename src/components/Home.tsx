// 首页：把各个功能模块列成入口卡片。
//
// 以后要加新模块，只要三步：
//   ① 在这里的 cards 数组里加一张卡片；
//   ② 在下面的 ModuleId 类型里加上它的名字；
//   ③ 在 App.tsx 里加一条渲染分支。

import { useEffect, useState } from 'react'
import { getStats } from '../lib/fileStore'
import { formatBytes } from '../lib/fileUtils'
import { readToolCounts } from '../hooks/useTools'

// 所有模块的名字集中在这里，App.tsx 也用它
export type ModuleId = 'tools' | 'files'

interface HomeProps {
  onOpen: (module: ModuleId) => void
}

export default function Home({ onOpen }: HomeProps) {
  // 工具的个数直接从浏览器本地读一次，不需要挂载整个工具箱
  const [toolCounts] = useState(() => readToolCounts())
  const [fileInfo, setFileInfo] = useState('读取中…')

  // 文件数量要从 IndexedDB 查，是异步的
  useEffect(() => {
    getStats()
      .then((stats) =>
        setFileInfo(
          stats.fileCount > 0
            ? stats.fileCount + ' 个文件 · ' + formatBytes(stats.bytes)
            : '还没有文件',
        ),
      )
      .catch(() => setFileInfo('暂时读不到'))
  }, [])

  const cards = [
    {
      id: 'tools' as ModuleId,
      icon: '🔗',
      title: '常用工具',
      desc: '收藏的网站和顺手的小工具，可拖动排序、按分组管理',
      meta: toolCounts.toolCount + ' 个工具 · ' + toolCounts.groupCount + ' 个分组',
    },
    {
      id: 'files' as ModuleId,
      icon: '📁',
      title: '文件管理',
      desc: '把 PDF、Word、图片等小文件存在浏览器里，随时打开',
      meta: fileInfo,
    },
  ]

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800">
      <div className="mx-auto max-w-3xl px-4 py-16">
        <header className="mb-10 text-center">
          <h1 className="text-4xl font-bold tracking-tight text-slate-900">🧰 我的工具箱</h1>
          <p className="mt-2 text-sm text-slate-500">常用工具和个人文件，一处收纳，随时可用。</p>
        </header>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {cards.map((card) => (
            <button
              key={card.id}
              type="button"
              onClick={() => onOpen(card.id)}
              className="group flex flex-col items-start rounded-2xl border border-slate-200 bg-white p-6 text-left shadow-sm transition hover:-translate-y-1 hover:border-sky-300 hover:shadow-lg"
            >
              <span className="text-4xl" aria-hidden="true">
                {card.icon}
              </span>
              <span className="mt-4 text-xl font-semibold text-slate-900 group-hover:text-sky-700">
                {card.title}
              </span>
              <span className="mt-1 text-sm leading-relaxed text-slate-500">{card.desc}</span>
              <span className="mt-4 rounded-md bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
                {card.meta}
              </span>
            </button>
          ))}
        </div>

        <p className="mt-10 text-center text-xs text-slate-400">
          所有数据都存在这台电脑的浏览器里，没有上传到服务器 · 阶段 1
        </p>
      </div>
    </div>
  )
}
