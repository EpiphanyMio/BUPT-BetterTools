// 单个分组标签。
// 它有两个身份：① 可点击的按钮（切换分组）② 可以"接收工具"的投放区（拖动工具到它上面 = 移进该分组）。

import { useDroppable } from '@dnd-kit/core'
import { ALL, tabId } from '../lib/constants'

interface CategoryTabProps {
  category: string
  active: boolean
  onSelect: (category: string) => void
}

export default function CategoryTab({
  category,
  active,
  onSelect,
}: CategoryTabProps) {
  // isOver：当前有东西正悬停在这个标签上
  const { setNodeRef, isOver } = useDroppable({
    id: tabId(category),
    // "全部"不是真实分组，不能作为投放目标
    disabled: category === ALL,
  })

  return (
    <button
      ref={setNodeRef}
      type="button"
      onClick={() => onSelect(category)}
      className={
        'rounded-full px-3.5 py-1.5 text-sm transition ' +
        (isOver
          ? 'scale-110 bg-sky-100 text-sky-700 ring-2 ring-sky-400'
          : active
            ? 'bg-sky-600 text-white shadow-sm'
            : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100')
      }
    >
      {category}
    </button>
  )
}
