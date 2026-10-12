// 分组按钮条：点击切换当前分组；标签本身还能拖动排序。
// 最右侧是「编辑分组」操作按钮。

import { SortableContext, rectSortingStrategy } from '@dnd-kit/sortable'
import CategoryTab from './CategoryTab'
import { ALL, tabId } from '../lib/constants'

interface CategoryTabsProps {
  categories: string[]
  selected: string
  onSelect: (category: string) => void
  onOpenEditor: () => void
}

export default function CategoryTabs({
  categories,
  selected,
  onSelect,
  onOpenEditor,
}: CategoryTabsProps) {
  // 参与排序的只有真实分组。"全部"是虚拟分组，固定钉在最前面，
  // 所以它的 id 不放进 items 里 —— 不参与排序，也就不会被别人挤走。
  const sortableIds = categories.filter((name) => name !== ALL).map(tabId)

  return (
    <div className="mb-5 flex flex-wrap items-center gap-2">
      <SortableContext items={sortableIds} strategy={rectSortingStrategy}>
        {categories.map((category) => (
          <CategoryTab
            key={category}
            category={category}
            active={category === selected}
            onSelect={onSelect}
          />
        ))}
      </SortableContext>

      {/* ml-auto 会把这个按钮推到本行最右边 */}
      <button
        type="button"
        onClick={onOpenEditor}
        className="ml-auto rounded-full border border-dashed border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-500 transition hover:border-sky-400 hover:text-sky-700"
      >
        ✎ 编辑分组
      </button>
    </div>
  )
}
