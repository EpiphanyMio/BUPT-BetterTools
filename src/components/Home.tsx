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

// Google 品牌四色。用在标题的四个字母和每张卡片的图标底座上 ——
// 这是 Google 设计里最容易被认出来的特征：四色只做"点"，不铺面。
const GOOGLE_COLORS = ['#4285f4', '#ea4335', '#fbbc04', '#34a853']

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
      // 每张卡片配一个品牌色，用"同色系的淡底 + 原色图标"来呼应，而不是把整块涂满
      accent: GOOGLE_COLORS[0],
    },
    {
      id: 'files' as ModuleId,
      icon: '📁',
      title: '文件管理',
      desc: '把 PDF、Word、图片等小文件存在浏览器里，随时打开',
      meta: fileInfo,
      accent: GOOGLE_COLORS[3],
    },
  ]

  return (
    <div className="min-h-screen bg-canvas text-fg">
      <div className="mx-auto max-w-3xl px-4 py-16">
        <header className="mb-12 text-center">
          {/* 标题用 Google 四色着色。
              为什么用 span 拆字母：CSS 没法给单个字母上不同颜色，
              只能把它们拆成独立元素。全角/半角混排问题这里不涉及，因为是拉丁字母。
              text-fg 打底是给不支持 background-clip 的浏览器兜底。 */}
          <h1 className="text-4xl font-normal tracking-tight text-fg sm:text-5xl">
            <span style={{ color: GOOGLE_COLORS[0] }}>B</span>
            <span style={{ color: GOOGLE_COLORS[1] }}>e</span>
            <span style={{ color: GOOGLE_COLORS[2] }}>t</span>
            <span style={{ color: GOOGLE_COLORS[0] }}>t</span>
            <span style={{ color: GOOGLE_COLORS[3] }}>e</span>
            <span style={{ color: GOOGLE_COLORS[1] }}>r</span>
            <span className="ml-3 font-medium">工具箱</span>
          </h1>
          <p className="mt-3 text-sm text-fg-muted">
            常用工具和个人文件，一处收纳，随时可用。
          </p>
        </header>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {cards.map((card, index) => (
            <button
              key={card.id}
              type="button"
              onClick={() => onOpen(card.id)}
              // animate-rise + animationDelay：两张卡片依次淡入上浮。
              // style 里传 animationDelay 而不是写死在 CSS 里，是为了让顺序由数据决定。
              style={{ animationDelay: `${index * 80}ms` }}
              className="card card-hover animate-rise group flex flex-col items-start p-6 text-left"
            >
              {/* 图标底座：Google 产品里图标都放在一个淡色圆角方块里，
                  比裸奔的 emoji 更有"体系感"。 */}
              <span
                className="flex h-12 w-12 items-center justify-center rounded-btn text-2xl"
                style={{ backgroundColor: `color-mix(in srgb, ${card.accent} 12%, transparent)` }}
                aria-hidden="true"
              >
                {card.icon}
              </span>

              <span className="mt-4 text-xl font-medium text-fg">{card.title}</span>
              <span className="mt-1 text-sm leading-relaxed text-fg-muted">{card.desc}</span>

              {/* 元信息用淡色药丸，颜色跟着卡片主色走 */}
              <span
                className="mt-4 rounded-full px-2.5 py-1 text-xs font-medium"
                style={{
                  backgroundColor: `color-mix(in srgb, ${card.accent} 10%, transparent)`,
                  color: card.accent,
                }}
              >
                {card.meta}
              </span>
            </button>
          ))}
        </div>

        <p className="mt-12 text-center text-xs text-fg-subtle">
          所有数据都存在这台电脑的浏览器里，没有上传到服务器 · 阶段 1
        </p>
      </div>
    </div>
  )
}
