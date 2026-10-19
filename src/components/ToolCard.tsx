// 单个工具卡片：
//   左上角 = 拖动把手    右上角 = 详情（ⓘ）
//   主体   = 打开链接    左下角 = 收藏        右下角 = 编辑（点开可快速编辑 / 删除）
//
// ★ 对齐规则（卡片能整齐排成一行，靠的就是这三条）：
//   ① 根元素是"纵向 flex + h-full"，卡片会被网格拉到与同行最高者等高；
//   ② 中间那个 <a> 用 flex-1，把剩余高度吃掉，于是简介下方的空白被推到最底；
//   ③ 分组药丸用 mt-auto 钉在底部 —— 这样不管上面简介是一行还是两行，
//      所有卡片的药丸都落在同一条水平线上。
//   另外简介限两行（line-clamp-2），再多也不会把卡片撑高。

import { useEffect, useRef, useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { Tool } from '../types'

interface ToolCardProps {
  tool: Tool
  isFavorite: boolean
  onToggleFavorite: (id: string) => void
  onOpenDetail: (id: string) => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
}

export default function ToolCard({
  tool,
  isFavorite,
  onToggleFavorite,
  onOpenDetail,
  onEdit,
  onDelete,
}: ToolCardProps) {
  // useSortable 把这张卡片变成"可拖动排序的项"
  const {
    attributes,          // 无障碍相关属性
    listeners,           // 拖拽事件（必须绑到"把手"上，否则点链接也会触发拖动）
    setNodeRef,          // 绑到卡片根元素，dnd-kit 才能测量它的位置
    setActivatorNodeRef, // 绑到把手元素
    transform,           // 拖动过程中的位移 {x, y, ...}
    transition,          // 位移的过渡动画
    isDragging,          // 当前是否正在被拖动
  } = useSortable({ id: tool.id })

  // ---- 右下角小菜单 ----
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // 点击菜单以外的任何地方，就把菜单关掉
  useEffect(() => {
    if (!menuOpen) return

    function handleMouseDown(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [menuOpen])

  // ★ 关键：拖动中必须"关掉过渡动画"。
  // 否则 transform 会被 CSS 过渡拖慢（150ms），卡片就会慢半拍追鼠标，感觉"不跟手"。
  // 拖动时还要加 will-change，提示浏览器把这张卡提升到独立图层，移动更顺滑。
  const style = {
    transform: CSS.Transform.toString(transform),
    transition: isDragging ? undefined : transition,
    willChange: isDragging ? 'transform' : undefined,
  }

  // 静止时才用 transition（让悬停的阴影/上浮有动画）；拖动时一律不加。
  // 拖动时用 border-primary（主色描边）来表示"这张正在被拖"，
  // 而不是靠放大 —— Material 里"选中/激活"是描边和海拔变化，不是缩放。
  const cardClass = isDragging
    ? 'z-10 cursor-grabbing border-primary opacity-80 shadow-e4'
    : 'card-hover'

  function handleQuickDelete() {
    setMenuOpen(false)
    if (window.confirm(`确定删除工具「${tool.name}」吗？`)) {
      onDelete(tool.id)
    }
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      // data-tool-card 是给自动化测量用的标记（见 scripts/_check-align.mjs）。
      // 它不影响任何样式，只是让脚本能精确拿到每张卡片的坐标来验证对齐。
      data-tool-card={tool.id}
      className={
        // h-full：让卡片撑满网格给的高度（同行等高）
        // flex flex-col：卡片内部纵向排列，好让药丸能钉到底部
        // pb-10 是给右下角的编辑按钮留出的位置
        'card group relative flex h-full flex-col p-4 pb-10 pl-9 ' + cardClass
      }
    >
      {/* 拖动把手：只有按住这里才会开始拖动，不影响点链接和收藏 */}
      <button
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        type="button"
        title="按住拖动调整顺序"
        aria-label="按住拖动调整顺序"
        className="absolute left-1.5 top-3.5 z-10 cursor-grab touch-none rounded p-1 text-fg-subtle transition hover:bg-surface-3 hover:text-fg-muted active:cursor-grabbing"
      >
        <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">
          <circle cx="2.5" cy="3" r="1.4" />
          <circle cx="7.5" cy="3" r="1.4" />
          <circle cx="2.5" cy="8" r="1.4" />
          <circle cx="7.5" cy="8" r="1.4" />
          <circle cx="2.5" cy="13" r="1.4" />
          <circle cx="7.5" cy="13" r="1.4" />
        </svg>
      </button>

      {/* 右上角按钮组：详情（打开信息面板）+ 收藏。
          放在 <a> 之前、并给 z-10，是为了保证它们浮在链接的点击区之上 ——
          否则点按钮会被下面的链接抢走，变成"打开网址"。
          top-11 把它们放到图标行下方：这样卡片名可以独占整行宽度，
          长名字（比如"现代 JavaScript 教程"）就不会被挤到提前换行。 */}
      <div className="absolute right-2 top-11 z-10 flex items-center gap-0.5">
        <button
          type="button"
          data-detail-btn
          onClick={() => onOpenDetail(tool.id)}
          title="查看详情"
          aria-label={`查看「${tool.name}」的详情`}
          className="flex h-8 w-8 items-center justify-center rounded-full text-base leading-none text-fg-subtle transition hover:bg-primary-soft hover:text-primary"
        >
          {/* ⓘ 是"信息"的标准符号，比写"详情"两字更省地方，也更像 Google 的圆形图标按钮 */}
          <span aria-hidden="true">ⓘ</span>
        </button>

        <button
          type="button"
          onClick={() => onToggleFavorite(tool.id)}
          title={isFavorite ? '取消收藏' : '收藏'}
          aria-label={isFavorite ? '取消收藏' : '收藏'}
          className={
            'flex h-8 w-8 items-center justify-center rounded-full text-xl leading-none transition hover:bg-surface-3 ' +
            (isFavorite ? 'text-warn' : 'text-fg-subtle hover:text-warn')
          }
        >
          <span aria-hidden="true">{isFavorite ? '★' : '☆'}</span>
        </button>
      </div>

      {/* draggable={false} 关掉浏览器自带的"拖动链接"行为，避免和排序拖拽打架。
          flex-1：把剩余高度吃掉，从而把下面的药丸推到底部。 */}
      <a
        href={tool.url}
        target="_blank"
        rel="noreferrer"
        draggable={false}
        className="flex flex-1 flex-col"
      >
        <div className="flex items-center gap-3">
          {/* 图标底座：Google 产品里图标都装在一个淡色圆角方块里，比裸 emoji 更有体系感。
              用 surface-2 而不是彩色的，是为了让同一个淡底承载各种 emoji 都不打架。 */}
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-btn bg-surface-2 text-xl">
            {tool.icon ?? '🔗'}
          </span>
          {/* min-w-0 + break-words：名称过长时按词换行，而不是把卡片撑宽 */}
          <span data-card-name className="min-w-0 break-words font-medium text-fg">
            {tool.name}
          </span>
        </div>

        {tool.description && (
          // ★ 限两行：line-clamp-2 会在第二行末尾显示省略号。
          //   配合 min-h-10（正好两行文字高），简介无论一行、两行还是更长，
          //   占的高度都一样 —— 这是卡片等高的另一半保证。
          // ★ pr-16：右上角的详情/收藏按钮是绝对定位浮在上面的，
          //   不预留这块宽度的话，第一行备注的文字会钻到按钮底下被挡住。
          <p
            data-card-desc
            className="mt-2 line-clamp-2 min-h-10 pr-16 text-sm leading-5 text-fg-subtle"
          >
            {tool.description}
          </p>
        )}

        {/* 分组名做成 Google 风格的药丸：淡主色底 + 主色文字。
            mt-auto 把它钉在卡片底部，所以所有卡片的药丸水平对齐。
            悬停整张卡片时底色略微加深，表示"这张卡片是活的"。 */}
        <span
          data-card-category
          className="mt-auto inline-block self-start rounded-full bg-surface-3 px-2.5 py-1 text-xs font-medium text-fg-muted transition-colors group-hover:bg-primary-soft group-hover:text-primary"
        >
          {tool.category}
        </span>
      </a>

      {/* 右下角：编辑按钮 + 展开的小菜单 */}
      <div ref={menuRef} className="absolute bottom-3 right-3 z-10">
        <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          title="编辑 / 删除这个工具"
          aria-label="编辑 / 删除这个工具"
          className={
            'rounded-lg px-2 py-1 text-sm leading-none transition ' +
            (menuOpen
              ? 'bg-primary-soft text-primary'
              : 'text-fg-subtle hover:bg-surface-3 hover:text-fg-muted')
          }
        >
          ✎
        </button>

        {menuOpen && (
          <div className="absolute bottom-full right-0 mb-1 w-28 overflow-hidden rounded-btn border border-line bg-surface py-1 shadow-e3">
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false)
                onEdit(tool.id)
              }}
              className="block w-full px-3 py-1.5 text-left text-sm text-fg-muted transition hover:bg-surface-3"
            >
              ✎ 编辑
            </button>
            <button
              type="button"
              onClick={handleQuickDelete}
              className="block w-full px-3 py-1.5 text-left text-sm text-danger transition hover:bg-danger-bg"
            >
              🗑 删除
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
