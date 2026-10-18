// App.tsx：主界面，负责"状态"和"数据流转"。
//
// 数据流（理解 React 的关键）：
//   useState 保存状态  →  用户操作触发 setXxx  →  组件重新渲染  →  界面跟着更新
//
// 拖拽有三个用途：
//   ① 在卡片之间拖动 → 调整卡片顺序
//   ② 把卡片拖到上方的分组标签上 → 移进那个分组
//   ③ 拖动分组标签本身 → 调整分组的排列顺序

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
import { ALL, TAB_PREFIX } from '../lib/constants'
import { buildAutoScroll } from '../lib/autoScroll'
import { useFavorites } from '../hooks/useFavorites'
import { useToolOrder } from '../hooks/useToolOrder'
import { useTools } from '../hooks/useTools'
import { useDevSettings } from '../hooks/useDevSettings'
import { useAppSettings } from '../hooks/useAppSettings'
import { useTheme } from '../hooks/useTheme'
import SearchBar from '../components/SearchBar'
import CategoryTabs from '../components/CategoryTabs'
import ToolCard from '../components/ToolCard'
import GroupEditor from '../components/GroupEditor'
import ToolEditModal from '../components/ToolEditModal'
import ToolDetailModal from '../components/ToolDetailModal'
import GeneralSettingsPanel from '../components/GeneralSettingsPanel'

interface ToolboxModuleProps {
  onBack: () => void
  /** 打开「全局搜索」浮层 */
  onSearch: () => void
}

export default function ToolboxModule({ onBack, onSearch }: ToolboxModuleProps) {
  // ---- 通用设置 ----
  // ⚠️ 必须写在下面的 useState 之前：初始分组要读它的值
  const {
    settings: appSettings,
    updateSetting: updateAppSetting,
  } = useAppSettings()

  // ---- 界面状态 ----
  const [query, setQuery] = useState('')                            // 搜索关键词
  // 当前分组：初始值来自「通用设置」里的"打开工具箱时的默认分组"
  const [category, setCategory] = useState(appSettings.defaultCategory)
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false) // 是否只看收藏
  const [editorOpen, setEditorOpen] = useState(false)               // 「编辑分组」弹窗
  const [editingToolId, setEditingToolId] = useState<string | null>(null) // 卡片快速编辑的工具
  const [detailToolId, setDetailToolId] = useState<string | null>(null)   // 卡片右上角 ⓘ 打开详情的工具
  const [settingsOpen, setSettingsOpen] = useState(false)           // 「通用设置」弹窗

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
    reorderGroups,
    mergeSeed,
    missingSeedCount,
    resetAll,
  } = useTools()

  // ---- 开发者设置（调试参数）----
  const {
    settings: dev,
    updateSetting: updateDevSetting,
    resetSettings: resetDevSettings,
  } = useDevSettings()

  // ---- 主题（跟随系统 / 浅色 / 深色）----
  // ⚠️ 它改的是 <html> 上的 color-scheme，影响的是全站颜色，
  // 所以理论上放在任意组件里调用都行 —— 这里放在工具箱模块只是顺手。
  const { mode: themeMode, setTheme } = useTheme()

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

  // 正在查看详情的工具。用 id 而不是直接存对象 ——
  // 这样在详情打开时如果工具被改名/改分组，面板会立刻显示最新内容。
  const detailTool = useMemo(
    () => tools.find((tool) => tool.id === detailToolId) ?? null,
    [tools, detailToolId],
  )

  const closeEditor = useCallback(() => setEditorOpen(false), [])
  const closeToolEditor = useCallback(() => setEditingToolId(null), [])
  const closeDetail = useCallback(() => setDetailToolId(null), [])
  const closeSettings = useCallback(() => setSettingsOpen(false), [])

  // 由开发者设置生成的自动滚动配置（主页和编辑弹窗共用同一份）
  const autoScroll = useMemo(() => buildAutoScroll(dev), [dev])

  // ---- 碰撞检测（决定"松手时投给谁"）----
  // 要分两种情况，因为"正在拖的是什么"决定了该去找什么样的目标：
  //
  //   拖的是分组标签 → 只在标签之间找最近的（= 调整分组顺序）
  //                    绝不能把卡片算进来，否则标签会往卡片格里跑
  //   拖的是工具卡片 → 先看指针是不是真的压在某个标签上（= 移进该分组），
  //                    不是的话退回"最近中心"算法（= 卡片之间排序）
  const collisionDetection = useCallback<CollisionDetection>((args) => {
    const draggingTab = String(args.active.id).startsWith(TAB_PREFIX)

    if (draggingTab) {
      return closestCenter({
        ...args,
        droppableContainers: args.droppableContainers.filter((container) =>
          String(container.id).startsWith(TAB_PREFIX),
        ),
      })
    }

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

    // 情况 A：拖的是分组标签本身 → 调整分组顺序
    // groups 数组的顺序就是标签的显示顺序，所以"换个位置"就够了
    if (activeId.startsWith(TAB_PREFIX)) {
      if (activeId === overId) return
      const from = groups.indexOf(activeId.slice(TAB_PREFIX.length))
      const to = groups.indexOf(overId.slice(TAB_PREFIX.length))
      if (from === -1 || to === -1) return
      reorderGroups(from, to)
      return
    }

    // 情况 B：把工具卡片拖到了分组标签上 → 移进那个分组
    if (overId.startsWith(TAB_PREFIX)) {
      const targetGroup = overId.slice(TAB_PREFIX.length)
      const tool = tools.find((item) => item.id === activeId)
      if (tool && tool.category !== targetGroup) moveTool(activeId, targetGroup)
      return
    }

    // 情况 C：在卡片之间拖动 → 调整顺序
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
    <div className="min-h-screen bg-surface-2 text-fg">
      <div className="mx-auto max-w-5xl px-4 py-8">
        {/* 标题区
            ⚠️ 窄屏必须纵向排列。原来这里是「左右分栏 + 右侧 shrink-0」：
            右边四个按钮不肯收缩（319px），左边标题就被压到只剩几十像素宽，
            逐字换行成一条竖条，而且按钮还会撑出屏幕。
            改成 flex-col / sm:flex-row 之后，手机上标题在上、按钮在下，
            min-w-0 + flex-wrap 再兜住"按钮一行放不下"的情况。 */}
        <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="min-w-0">
            <h1 className="text-3xl font-bold tracking-tight text-fg">🔗 常用工具</h1>
            <p className="mt-1 text-sm text-fg-subtle">
              收藏的网站和顺手的小工具，可拖动排序、按分组管理。
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
            <button type="button" onClick={onBack} className="btn btn-neutral">
              ← 返回首页
            </button>

            {/* 全局搜索：同时搜工具和文件。和下面那个搜索框不冲突 ——
                那个是"在当前分组里筛卡片"，这个是"翻遍整个库找东西"。 */}
            <button
              type="button"
              onClick={onSearch}
              title="搜索工具和文件（Ctrl+K）"
              aria-label="搜索工具和文件"
              className="btn btn-neutral w-10 px-0 leading-none"
            >
              🔍
            </button>

            {/* 主题切换：点一下按「跟随系统 → 浅色 → 深色」循环。
                用 emoji 当图标，改动最小、不引入图标库。 */}
            <button
              type="button"
              onClick={() => {
                const next =
                  themeMode === 'system' ? 'light' : themeMode === 'light' ? 'dark' : 'system'
                setTheme(next)
              }}
              title={
                '当前：' +
                (themeMode === 'system' ? '跟随系统' : themeMode === 'light' ? '浅色' : '深色') +
                '。点击切换'
              }
              aria-label="切换主题"
              className="btn btn-neutral w-10 px-0 leading-none"
            >
              {themeMode === 'system' ? '🖥' : themeMode === 'light' ? '☀️' : '🌙'}
            </button>

            {/* 通用设置（开发者设置是它的二级窗口） */}
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="btn btn-neutral"
            >
              <span aria-hidden="true">⚙</span> 通用设置
            </button>
          </div>
        </header>

        {/* 搜索框 + 只看收藏 */}
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="flex-1">
            <SearchBar value={query} onChange={setQuery} />
          </div>

          <button
            type="button"
            onClick={() => setShowFavoritesOnly((value) => !value)}
            className={
              'btn shrink-0 ' + (showFavoritesOnly ? 'btn-primary' : 'btn-outline')
            }
          >
            <span aria-hidden="true">{showFavoritesOnly ? '★' : '☆'}</span>
            <span>只看收藏 ({favoriteCount})</span>
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
          <p className="mb-3 text-xs text-fg-subtle">
            提示：按住卡片左上角的手柄可调整顺序；把它拖到上方的分组标签上，就能移进那个分组；按住分组标签拖动则可以调整分组的先后顺序
          </p>

          {/* 工具卡片列表 */}
          {visibleTools.length === 0 ? (
            <p className="rounded-card border border-dashed border-line bg-surface-2 py-12 text-center text-sm text-fg-subtle">
              {showFavoritesOnly
                ? '还没有收藏任何工具，点卡片右上角的 ☆ 试试'
                : category !== ALL
                  ? `「${category}」分组下还没有工具，点右上角「编辑分组」去添加`
                  : '没有找到匹配的工具，换个关键词试试？'}
            </p>
          ) : (
            <SortableContext items={visibleIds} strategy={rectSortingStrategy}>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {visibleTools.map((tool, index) => (
                  <div
                    key={tool.id}
                    // 依次入场的错峰延迟：按索引递增，但上限 400ms ——
                    // 否则工具很多时最后一张卡片要等好几秒才出现。
                    // animation-fill-mode 是 both，所以延迟期间保持"透明"，
                    // 不会先闪现再淡入。
                    style={{ animationDelay: `${Math.min(index * 40, 400)}ms` }}
                    className="animate-rise"
                  >
                    <ToolCard
                      tool={tool}
                      isFavorite={isFavorite(tool.id)}
                      onToggleFavorite={toggleFavorite}
                      onOpenDetail={setDetailToolId}
                      onEdit={setEditingToolId}
                      onDelete={removeTool}
                    />
                  </div>
                ))}
              </div>
            </SortableContext>
          )}
        </DndContext>

        <footer className="mt-10 text-center text-xs text-fg-subtle">
          共 {tools.length} 个工具 · {groups.length} 个分组
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
        onMergeSeed={mergeSeed}
        missingSeedCount={missingSeedCount}
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

      {/* 卡片右上角 ⓘ 打开的工具详情面板 */}
      <ToolDetailModal
        tool={detailTool}
        isFavorite={detailTool ? isFavorite(detailTool.id) : false}
        onToggleFavorite={toggleFavorite}
        onClose={closeDetail}
      />

      {/* 右上角「通用设置」（开发者设置在其中作为二级窗口） */}
      <GeneralSettingsPanel
        open={settingsOpen}
        onClose={closeSettings}
        groups={groups}
        settings={appSettings}
        onChange={updateAppSetting}
        devSettings={dev}
        onDevChange={updateDevSetting}
        onDevReset={resetDevSettings}
      />
    </div>
  )
}
