// App.tsx：主界面，负责"状态"和"数据流转"。
//
// 数据流（理解 React 的关键）：
//   useState 保存状态  →  用户操作触发 setXxx  →  组件重新渲染  →  界面跟着更新
//
// 拖拽有两个用途：
//   ① 在卡片之间拖动 → 调整顺序
//   ② 把卡片拖到上方的分组标签上 → 移进那个分组

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable'
import { ALL, TAB_PREFIX } from './lib/constants'
import { buildAutoScroll } from './lib/autoScroll'
import { useFavorites } from './hooks/useFavorites'
import { useToolOrder } from './hooks/useToolOrder'
import { useTools } from './hooks/useTools'
import { useDevSettings } from './hooks/useDevSettings'
import SearchBar from './components/SearchBar'
import CategoryTabs from './components/CategoryTabs'
import ToolCard from './components/ToolCard'
import GroupEditor from './components/GroupEditor'
import ToolEditModal from './components/ToolEditModal'
import DevSettingsPanel from './components/DevSettingsPanel'

export default function App() {
  // ---- 界面状态 ----
  const [query, setQuery] = useState('')                            // 搜索关键词
  const [category, setCategory] = useState(ALL)                     // 当前分组
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false) // 是否只看收藏
  const [editorOpen, setEditorOpen] = useState(false)               // 「编辑分组」弹窗
  const [editingToolId, setEditingToolId] = useState<string | null>(null) // 卡片快速编辑的工具
  const [devPanelOpen, setDevPanelOpen] = useState(false)           // 「开发者设置」弹窗

  // ---- 数据：收藏 + 工具/分组 ----
  const { favorites, toggleFavorite, isFavorite } = useFavorites()
  const {
    tools,
    groups,
    addGroup,
    removeGroup,
    addTool,
    updateTool,
    moveTool,
    removeTool,
    resetAll,
  } = useTools()

  // ---- 开发者设置（调试参数）----
  const {
    settings: dev,
    updateSetting: updateDevSetting,
    resetSettings: resetDevSettings,
  } = useDevSettings()

  // ---- 顺序：拖动调整后存到浏览器本地 ----
  const allIds = useMemo(() => tools.map((tool) => tool.id), [tools])
  const { order, setOrder } = useToolOrder(allIds)

  // 分组列表 = "全部" + 用户自己定义的分组
  const categories = useMemo(() => [ALL, ...groups], [groups])

  // 如果当前选中的分组被删掉了，自动退回"全部"
  useEffect(() => {
    if (category !== ALL && !groups.includes(category)) setCategory(ALL)
  }, [category, groups])

  // ---- 第一步：按用户自定义的顺序排好 ----
  const sortedTools = useMemo(() => {
    const rank = new Map(order.map((id, index) => [id, index]))
    return [...tools].sort(
      (a, b) =>
        (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    )
  }, [tools, order])

  // ---- 第二步：用"搜索 + 分组 + 只看收藏"三个条件过滤 ----
  const visibleTools = useMemo(() => {
    const keyword = query.trim().toLowerCase()

    return sortedTools.filter((tool) => {
      const matchKeyword =
        keyword === '' ||
        tool.name.toLowerCase().includes(keyword) ||
        tool.description.toLowerCase().includes(keyword)

      const matchCategory = category === ALL || tool.category === category
      const matchFavorite = !showFavoritesOnly || favorites.includes(tool.id)

      return matchKeyword && matchCategory && matchFavorite
    })
  }, [sortedTools, query, category, showFavoritesOnly, favorites])

  // 当前屏幕上显示的工具 id 列表，拖动排序要用
  const visibleIds = useMemo(
    () => visibleTools.map((tool) => tool.id),
    [visibleTools],
  )

  // 只统计"现在还存在"的收藏，避免删掉工具后数字对不上
  const favoriteCount = useMemo(
    () => tools.filter((tool) => favorites.includes(tool.id)).length,
    [tools, favorites],
  )

  // 正在被"卡片快速编辑"的工具；找不到就是 null，弹窗会自动关闭
  const editingTool = useMemo(
    () => tools.find((tool) => tool.id === editingToolId) ?? null,
    [tools, editingToolId],
  )

  const closeEditor = useCallback(() => setEditorOpen(false), [])
  const closeToolEditor = useCallback(() => setEditingToolId(null), [])
  const closeDevPanel = useCallback(() => setDevPanelOpen(false), [])

  // 由开发者设置生成的自动滚动配置（主页和编辑弹窗共用同一份）
  const autoScroll = useMemo(() => buildAutoScroll(dev), [dev])

  // ---- 碰撞检测（决定"松手时投给谁"）----
  // 优先判断"指针是不是真的压在某个分组标签上"：
  //   是 → 投给那个标签（= 把工具移进该分组）
  //   否 → 退回"最近中心"算法（= 卡片之间排序）
  const collisionDetection = useCallback<CollisionDetection>((args) => {
    const overTabs = pointerWithin(args).filter((collision) =>
      String(collision.id).startsWith(TAB_PREFIX),
    )
    if (overTabs.length > 0) return overTabs
    return closestCenter(args)
  }, [])

  const sensors = useSensors(
    useSensor(PointerSensor, {
      // 这个数值可以在「开发者设置」里实时调整
      activationConstraint: { distance: dev.dragActivationDistance },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  // ---- 拖动结束 ----
  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over) return

    const activeId = String(active.id)
    const overId = String(over.id)

    // 情况 A：拖到了分组标签上 → 把工具移到那个分组
    if (overId.startsWith(TAB_PREFIX)) {
      const targetGroup = overId.slice(TAB_PREFIX.length)
      const tool = tools.find((item) => item.id === activeId)
      if (tool && tool.category !== targetGroup) moveTool(activeId, targetGroup)
      return
    }

    // 情况 B：在卡片之间拖动 → 调整顺序
    if (activeId === overId) return

    const oldIndex = visibleIds.indexOf(activeId)
    const newIndex = visibleIds.indexOf(overId)
    if (oldIndex === -1 || newIndex === -1) return

    // 只重排"当前看得见的这些"
    const nextVisible = arrayMove(visibleIds, oldIndex, newIndex)

    // 关键一步：把这些 id 放回它们在"全局顺序"里原本占据的槽位。
    // 这样当前没显示出来的工具（别的分组、被搜索过滤掉的）位置完全不受影响。
    const visibleSet = new Set(visibleIds)
    const slots: number[] = []
    order.forEach((id, index) => {
      if (visibleSet.has(id)) slots.push(index)
    })

    const nextOrder = [...order]
    slots.forEach((slot, i) => {
      nextOrder[slot] = nextVisible[i]
    })

    setOrder(nextOrder)
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800">
      <div className="mx-auto max-w-5xl px-4 py-8">
        {/* 标题区 */}
        <header className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-slate-900">
              🧰 我的工具箱
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              常用工具和网站，一处收藏，随时可用。
            </p>
          </div>

          {/* 右上角：开发者设置 */}
          <button
            type="button"
            onClick={() => setDevPanelOpen(true)}
            className="shrink-0 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-sm text-slate-600 shadow-sm transition hover:border-slate-300 hover:bg-slate-100"
          >
            ⚙ 开发者设置
          </button>
        </header>

        {/* 搜索框 + 只看收藏 */}
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
          <SearchBar value={query} onChange={setQuery} />

          <button
            type="button"
            onClick={() => setShowFavoritesOnly((value) => !value)}
            className={
              'shrink-0 rounded-xl px-4 py-2.5 text-sm transition ' +
              (showFavoritesOnly
                ? 'bg-amber-400 text-white shadow-sm'
                : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100')
            }
          >
            {showFavoritesOnly ? '★' : '☆'} 只看收藏 ({favoriteCount})
          </button>
        </div>

        {/* ⚠️ DndContext 要同时包住"分组标签"和"卡片网格"，
            这样卡片才能被拖到标签上 */}
        <DndContext
          sensors={sensors}
          collisionDetection={collisionDetection}
          // 拖到视口上下边缘时，页面会自动滚动（参数来自「开发者设置」）
          autoScroll={autoScroll}
          onDragEnd={handleDragEnd}
        >
          {/* 分组按钮 + 右侧「编辑分组」 */}
          <CategoryTabs
            categories={categories}
            selected={category}
            onSelect={setCategory}
            onOpenEditor={() => setEditorOpen(true)}
          />

          {/* 拖动提示 */}
          <p className="mb-3 text-xs text-slate-400">
            提示：按住卡片左上角的手柄可调整顺序；把它拖到上方的分组标签上，就能移进那个分组
          </p>

          {/* 工具卡片列表 */}
          {visibleTools.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-slate-300 bg-white py-12 text-center text-sm text-slate-400">
              {showFavoritesOnly
                ? '还没有收藏任何工具，点卡片右上角的 ☆ 试试'
                : category !== ALL
                  ? `「${category}」分组下还没有工具，点右上角「编辑分组」去添加`
                  : '没有找到匹配的工具，换个关键词试试？'}
            </p>
          ) : (
            <SortableContext items={visibleIds} strategy={rectSortingStrategy}>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {visibleTools.map((tool) => (
                  <ToolCard
                    key={tool.id}
                    tool={tool}
                    isFavorite={isFavorite(tool.id)}
                    onToggleFavorite={toggleFavorite}
                    onEdit={setEditingToolId}
                    onDelete={removeTool}
                  />
                ))}
              </div>
            </SortableContext>
          )}
        </DndContext>

        <footer className="mt-10 text-center text-xs text-slate-400">
          共 {tools.length} 个工具 · 阶段 1：纯前端静态工具箱
        </footer>
      </div>

      {/* 「编辑分组」弹窗（自带独立的拖拽环境） */}
      <GroupEditor
        open={editorOpen}
        onClose={closeEditor}
        groups={groups}
        tools={tools}
        onAddGroup={addGroup}
        onRemoveGroup={removeGroup}
        onAddTool={addTool}
        onUpdateTool={updateTool}
        onMoveTool={moveTool}
        onRemoveTool={removeTool}
        onReset={resetAll}
        autoScroll={autoScroll}
      />

      {/* 卡片右下角「编辑」打开的快速编辑弹窗 */}
      <ToolEditModal
        tool={editingTool}
        onSave={updateTool}
        onDelete={removeTool}
        onClose={closeToolEditor}
      />

      {/* 右上角「开发者设置」 */}
      <DevSettingsPanel
        open={devPanelOpen}
        onClose={closeDevPanel}
        settings={dev}
        onChange={updateDevSetting}
        onReset={resetDevSettings}
      />
    </div>
  )
}
