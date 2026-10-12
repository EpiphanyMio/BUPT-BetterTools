// 单个分组标签。
// 它有三个身份：
//   ① 可点击的按钮   —— 点击切换当前分组
//   ② 接收工具的投放区 —— 把工具卡片拖到它上面 = 移进该分组
//   ③ 自己也能被拖动  —— 拖动标签 = 调整分组的排列顺序
//
// ②③ 都由 useSortable 提供：一个"可排序项"天然同时是"可投放区"，
// 所以不需要再额外套一层 useDroppable。

import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
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
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({
    id: tabId(category),
    // "全部"是个虚拟分组，它既不能被拖动，也不能作为投放目标
    disabled: category === ALL,
  })

  // ★ 和卡片同样的处理：拖动过程中必须关掉 CSS 过渡。
  // 否则 transform 会被过渡动画拖慢，标签就会慢半拍追着鼠标跑。
  const style = {
    transform: CSS.Transform.toString(transform),
    transition: isDragging ? undefined : transition,
    willChange: isDragging ? 'transform' : undefined,
  }

  return (
    <button
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      type="button"
      onClick={() => onSelect(category)}
      title="点击切换分组；按住拖动可调整分组顺序"
      className={
        // touch-none：手机上按住标签时不要触发页面滚动，否则拖不动
        'touch-none select-none rounded-full px-3.5 py-1.5 text-sm ' +
        (isDragging
          ? 'z-10 cursor-grabbing bg-sky-600 text-white opacity-80 shadow-lg'
          : 'transition ' +
            (isOver
              ? 'scale-110 bg-sky-100 text-sky-700 ring-2 ring-sky-400'
              : active
                ? 'bg-sky-600 text-white shadow-sm'
                : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100'))
      }
    >
      {category}
    </button>
  )
}
