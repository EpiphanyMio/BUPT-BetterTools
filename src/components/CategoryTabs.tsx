// 分组按钮条：点击切换当前分组；每个标签同时也是"可投放区"。
// 最右侧是「编辑分组」操作按钮。

import CategoryTab from './CategoryTab'

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
  return (
    <div className="mb-5 flex flex-wrap items-center gap-2">
      {categories.map((category) => (
        <CategoryTab
          key={category}
          category={category}
          active={category === selected}
          onSelect={onSelect}
        />
      ))}

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
