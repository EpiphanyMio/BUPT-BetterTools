// 「编辑分组」弹窗里的分组列表：每个工具行左侧有拖拽条，可以拖到别的分组里。
//
// 这里用了 DragOverlay：拖动时显示一个"漂浮副本"，而不是让原来那一行跟着跑。
// 好处是副本渲染在滚动容器之外 —— ① 不会被 overflow 裁掉 ② 容器自动滚动时也不会跑偏。

import { useState } from 'react'
import {
  DndContext,
  DragOverlay,
  pointerWithin,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import type { Tool } from '../types'
import type { AutoScrollConfig } from '../lib/autoScroll'
import {
  EDITOR_TOOL_PREFIX,
  GROUP_PREFIX,
  editorToolId,
  groupId,
} from '../lib/constants'

interface GroupEditorListProps {
  groups: string[]
  tools: Tool[]
  onMoveTool: (toolId: string, category: string) => void
  onEditTool: (category: string, tool: Tool) => void
  onAddTool: (category: string) => void
  onRemoveGroup: (group: string) => void
  autoScroll: AutoScrollConfig
}

export default function GroupEditorList({
  groups,
  tools,
  onMoveTool,
  onEditTool,
  onAddTool,
  onRemoveGroup,
  autoScroll,
}: GroupEditorListProps) {
  // 正在被拖动的工具，用来渲染"漂浮副本"
  const [activeTool, setActiveTool] = useState<Tool | null>(null)

  function findTool(id: string) {
    if (!id.startsWith(EDITOR_TOOL_PREFIX)) return null
    const toolId = id.slice(EDITOR_TOOL_PREFIX.length)
    return tools.find((tool) => tool.id === toolId) ?? null
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveTool(findTool(String(event.active.id)))
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveTool(null)

    const { active, over } = event
    if (!over) return

    const activeId = String(active.id)
    const overId = String(over.id)

    // 只处理"工具行 → 分组区块"这一种情况
    if (!activeId.startsWith(EDITOR_TOOL_PREFIX)) return
    if (!overId.startsWith(GROUP_PREFIX)) return

    const toolId = activeId.slice(EDITOR_TOOL_PREFIX.length)
    const targetGroup = overId.slice(GROUP_PREFIX.length)

    const tool = tools.find((item) => item.id === toolId)
    if (!tool || tool.category === targetGroup) return

    onMoveTool(toolId, targetGroup)
  }

  return (
    <DndContext
      collisionDetection={pointerWithin}
      // 拖到滚动容器的上/下边缘附近时，容器会自动滚动。
      // threshold 表示"距边缘多少比例内开始滚动"，acceleration 是滚动加速度。
      // 和主页共用同一份配置（来自「开发者设置」）
      autoScroll={autoScroll}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveTool(null)}
    >
      <p className="mb-3 text-xs text-fg-subtle">
        提示：按住工具左侧的 ⠿ 拖动，可以把它移到别的分组
      </p>

      <div className="space-y-3">
        {groups.map((group) => (
          <GroupDropZone
            key={group}
            group={group}
            tools={tools.filter((tool) => tool.category === group)}
            onEditTool={onEditTool}
            onAddTool={onAddTool}
            onRemoveGroup={onRemoveGroup}
          />
        ))}
      </div>

      {/* 跟随鼠标的漂浮副本 */}
      <DragOverlay>
        {activeTool ? (
          <div className="flex items-center gap-2 rounded-lg border border-primary bg-surface px-3 py-2 shadow-xl">
            <span className="text-lg">{activeTool.icon ?? '🔗'}</span>
            <span className="truncate text-sm text-fg-muted">
              {activeTool.name}
            </span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}

// ---- 一个分组区块：它自己是一个"可投放区" ----

interface GroupDropZoneProps {
  group: string
  tools: Tool[]
  onEditTool: (category: string, tool: Tool) => void
  onAddTool: (category: string) => void
  onRemoveGroup: (group: string) => void
}

function GroupDropZone({
  group,
  tools,
  onEditTool,
  onAddTool,
  onRemoveGroup,
}: GroupDropZoneProps) {
  const { setNodeRef, isOver } = useDroppable({ id: groupId(group) })

  return (
    <div
      ref={setNodeRef}
      className={
        'rounded-btn border transition ' +
        (isOver ? 'border-primary ring-2 ring-primary-soft' : 'border-line')
      }
    >
      <div className="flex items-center justify-between gap-2 rounded-t-xl bg-surface-2 px-3 py-2">
        <span className="font-medium text-fg">
          {group}
          <span className="ml-2 text-xs text-fg-subtle">{tools.length} 个</span>
        </span>
        <div className="flex shrink-0 gap-1">
          <button
            type="button"
            onClick={() => onAddTool(group)}
            className="rounded-md px-2 py-1 text-sm text-primary transition hover:bg-surface-2"
          >
            ＋ 添加工具
          </button>
          <button
            type="button"
            onClick={() => onRemoveGroup(group)}
            className="rounded-md px-2 py-1 text-sm text-danger transition hover:bg-danger-bg"
          >
            删除分组
          </button>
        </div>
      </div>

      {tools.length === 0 ? (
        <p className="px-3 py-3 text-sm text-fg-subtle">
          这个分组还没有工具（可以把别的分组里的拖进来）
        </p>
      ) : (
        <ul className="divide-y divide-line-soft">
          {tools.map((tool) => (
            <ToolRow
              key={tool.id}
              tool={tool}
              onEdit={() => onEditTool(group, tool)}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

// ---- 一行工具：左侧是可拖拽的把手 ----

interface ToolRowProps {
  tool: Tool
  onEdit: () => void
}

function ToolRow({ tool, onEdit }: ToolRowProps) {
  // 用了 DragOverlay，所以这里不需要 transform —— 原来那一行留在原地变淡即可
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    isDragging,
  } = useDraggable({ id: editorToolId(tool.id) })

  return (
    <li
      ref={setNodeRef}
      className={
        'flex items-center gap-2 px-3 py-2 transition ' +
        (isDragging ? 'bg-surface-2 opacity-40' : '')
      }
    >
      {/* 拖拽条：按住它才会开始拖 */}
      <button
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        type="button"
        title="按住拖到别的分组"
        aria-label="按住拖到别的分组"
        className="cursor-grab touch-none rounded p-1 text-fg-subtle transition hover:bg-surface-3 hover:text-fg-subtle active:cursor-grabbing"
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

      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="text-lg">{tool.icon ?? '🔗'}</span>
        <span className="truncate text-sm text-fg-muted">{tool.name}</span>
      </span>

      <button
        type="button"
        onClick={onEdit}
        className="shrink-0 rounded-md px-2 py-1 text-sm text-fg-muted transition hover:bg-surface-3"
      >
        编辑
      </button>
    </li>
  )
}
