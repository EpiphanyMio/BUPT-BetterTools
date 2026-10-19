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
import { fetchUsage, type CloudUsage } from '../lib/fileCloud'
import { useAuth } from '../hooks/useAuth'

// 所有模块的名字集中在这里，App.tsx 也用它
export type ModuleId = 'tools' | 'files' | 'admin'

interface HomeProps {
  onOpen: (module: ModuleId) => void
  /** 打开「全局搜索」浮层（真正的输入和结果都在那个浮层里） */
  onSearch: () => void
}

// Google 品牌四色。用在标题的四个字母和每张卡片的图标底座上 ——
// 这是 Google 设计里最容易被认出来的特征：四色只做"点"，不铺面。
const GOOGLE_COLORS = ['#4285f4', '#ea4335', '#fbbc04', '#34a853']

export default function Home({ onOpen, onSearch }: HomeProps) {
  // 登录状态决定两件事：管理员多一张「用户组管理」卡片，已登录用户多一条「我的网盘用量」。
  // 为什么用 status 而不是 isGuest 判断：访客只是"没登录也放行主界面"，
  // 他的 status 仍然是 anonymous，和未登录在数据可用性上没有区别。
  const { status, user, isAdmin } = useAuth()

  // 工具的个数直接从浏览器本地读一次，不需要挂载整个工具箱
  const [toolCounts] = useState(() => readToolCounts())
  const [fileInfo, setFileInfo] = useState('读取中…')

  // 云端用量三态：undefined = 还在读，null = 读不到，对象 = 读到了。
  // 用一个 state 而不是 loading + data 两个，是为了避免出现"既在加载又有数据"这种
  // 两个变量打架的状态；类型上也只有三种可能。
  const [usage, setUsage] = useState<CloudUsage | null | undefined>(undefined)

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

  // 云端用量只在"已登录"时才去问。用户 id 进依赖数组：
  // 同一台设备换账号后（A 退出、B 登录），必须重新拉一次，
  // 否则界面上会留着上一个人用量的旧数字。
  useEffect(() => {
    if (status !== 'authenticated') {
      // 退出登录后立刻清掉，别把上一个人的用量留在屏幕上
      setUsage(undefined)
      return
    }

    let alive = true
    setUsage(undefined)
    // fetchUsage 自己吞掉所有失败并返回 null（未登录 / 断网 / 格式不对），
    // 所以这里不需要 catch；只需要在组件卸载后别再用旧结果写 state。
    void fetchUsage().then((next) => {
      if (alive) setUsage(next)
    })

    return () => {
      alive = false
    }
  }, [status, user?.id])

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
    // 管理员专属入口。
    // 为什么是"不 push 这张卡片"而不是"渲染出来再禁用/隐藏"：
    //   非管理员点进去只会被服务端回 403，一个永远用不了的功能摆在首页，
    //   只会让人以为网站坏了。所以从这里就不生成 —— 普通用户的网格里
    //   仍然只有两张卡片，不会空出一个格子。
    ...(isAdmin
      ? [
          {
            id: 'admin' as ModuleId,
            icon: '👥',
            title: '用户组管理',
            desc: '查看所有注册用户的网盘用量、最近登录时间和 IP',
            meta: '仅管理员可见',
            accent: GOOGLE_COLORS[1],
          },
        ]
      : []),
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

        {/* 全局搜索入口。
            它看起来像输入框，其实是个按钮 —— 点一下打开搜索浮层。
            为什么不在首页直接内嵌一个能打字的搜索框：
            那样首页要维护一份完整的搜索界面（结果列表、键盘选择、文件预览），
            而浮层已经把这些都做好了。这里只负责"让人一眼看见有这个功能"。 */}
        <button
          type="button"
          onClick={onSearch}
          className="field mb-8 flex items-center gap-3 text-left text-fg-subtle"
        >
          <span aria-hidden="true" className="shrink-0">
            🔍
          </span>
          <span className="flex-1">搜索工具和文件…</span>
          {/* 桌面端才显示快捷键提示：手机上没有物理键盘，显示了反而占地方 */}
          <kbd className="hidden shrink-0 rounded border border-line px-1.5 py-0.5 text-xs sm:inline">
            Ctrl K
          </kbd>
        </button>

        {/* 「我的网盘用量」：所有已登录用户（普通用户也算）都能看到自己用了多少。
            访客 / 未登录不渲染：他们既没有会话，fetchUsage 也只会返回 null，
            显示一条"暂无数据"只会多一行噪音。
            为什么不做成第四张卡片：它是"信息条"而不是"入口"，
            卡片网格是给人进模块用的，混进去会打乱三张入口的视觉节奏。 */}
        {status === 'authenticated' && (
          <section className="card mb-6 flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-fg">我的网盘用量</p>

              {usage === undefined ? (
                <p className="mt-1 text-xs text-fg-subtle">读取中…</p>
              ) : usage === null ? (
                // 读不到不报错：离线 / 服务没起来时本地文件照样能用，
                // 这条只是"云端统计暂时看不了"，语气要中性，别吓人。
                <p className="mt-1 text-xs text-fg-subtle">
                  暂时读不到云端用量（离线时不影响本地文件）
                </p>
              ) : (
                <>
                  <p className="mt-1 text-xs text-fg-muted">
                    已用 {formatBytes(usage.used)} / {formatBytes(usage.quota)}
                    <span className="ml-2 text-fg-subtle">{usagePercent(usage)}%</span>
                  </p>
                  {/* 进度条：轨道用 surface-3（比卡片底色深一档），
                      填充用主色。宽度只能是行内 style —— Tailwind 不会为
                      0~100 的每个百分比各生成一个类名。 */}
                  <div
                    role="progressbar"
                    aria-label="我的网盘用量"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={usagePercent(usage)}
                    className="mt-2 h-2 w-full overflow-hidden rounded-full bg-surface-3"
                  >
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${usagePercent(usage)}%` }}
                    />
                  </div>
                </>
              )}
            </div>

            <button
              type="button"
              onClick={() => onOpen('files')}
              className="btn btn-outline shrink-0"
            >
              去文件管理 →
            </button>
          </section>
        )}

        {/* 管理员多一个入口时用三列，普通用户两列。
            为什么分开写而不是固定三列：固定三列在普通用户下会空出一个格子，
            看起来像"有个模块没加载出来"。 */}
        <div
          className={
            'grid grid-cols-1 gap-4 ' +
            (isAdmin ? 'sm:grid-cols-2 lg:grid-cols-3' : 'sm:grid-cols-2')
          }
        >
          {cards.map((card, index) => (
            <button
              key={card.id}
              type="button"
              onClick={() => onOpen(card.id)}
              // animate-rise + animationDelay：卡片依次淡入上浮。
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
          {/* 页脚说明：① 网站部署在哪；② 数据在哪。
              文件管理现在会把文件同步到账号云端（R2），
              所以这里不能再写"文件只存在这台设备" —— 上面的用量条正是从云端读的。 */}
          网站托管在 bupt-bettertools.yuesu76.workers.dev · 登录后工具、收藏和文件会同步到你的账号云端
        </p>
      </div>
    </div>
  )
}

/**
 * 已用 / 配额 → 0~100 的整数百分比。
 *
 * 为什么要夹住范围：进度条宽度是用行内 style 写的，如果服务端给出
 * used > quota（或 quota 为 0）时算出 120% / Infinity，进度条会撑出卡片。
 * 这里统一收进 0~100，另外四舍五入到整数，避免出现 33.33333%。
 */
function usagePercent(usage: CloudUsage): number {
  if (!Number.isFinite(usage.quota) || usage.quota <= 0) return 0
  const percent = (usage.used / usage.quota) * 100
  return Math.min(100, Math.max(0, Math.round(percent)))
}
