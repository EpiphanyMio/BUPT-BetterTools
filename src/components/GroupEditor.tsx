// 「编辑分组」弹窗：管理分组，以及组内工具的增 / 删 / 改 / 移动。

import { useEffect, useState } from 'react'
import type { Tool, ToolDraft } from '../types'
import type { AutoScrollConfig } from '../lib/autoScroll'
import ToolForm from './ToolForm'
import GroupEditorList from './GroupEditorList'

interface GroupEditorProps {
  open: boolean
  onClose: () => void
  groups: string[]
  tools: Tool[]
  onAddGroup: (name: string) => void
  onRemoveGroup: (name: string) => void
  onAddTool: (category: string, values: ToolDraft) => void
  onUpdateTool: (id: string, values: ToolDraft) => void
  onMoveTool: (id: string, category: string) => void
  onRemoveTool: (id: string) => void
  onReset: () => void
  autoScroll: AutoScrollConfig
}

export default function GroupEditor({
  open,
  onClose,
  groups,
  tools,
  onAddGroup,
  onRemoveGroup,
  onAddTool,
  onUpdateTool,
  onMoveTool,
  onRemoveTool,
  onReset,
  autoScroll,
}: GroupEditorProps) {
  const [newGroup, setNewGroup] = useState('')
  // editing 为 null 表示"在列表页"；有值表示"正在填工具表单"
  const [editing, setEditing] = useState<{ category: string; tool: Tool | null } | null>(null)

  // 打开时：按 Esc 能关闭，并锁住背景滚动
  useEffect(() => {
    if (!open) return

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [open, onClose])

  // ⚠️ 所有 Hook 必须写在任何 return 之前，这是 React 的硬性规则
  if (!open) return null

  const editingTool = editing ? editing.tool : null
  const editingCategory = editing ? editing.category : ''

  function handleAddGroup() {
    const clean = newGroup.trim()
    if (!clean) return
    onAddGroup(clean)
    setNewGroup('')
  }

  function handleRemoveGroup(name: string) {
    const count = tools.filter((tool) => tool.category === name).length
    const message =
      count > 0
        ? `确定删除分组「${name}」吗？组内 ${count} 个工具也会一起删除。`
        : `确定删除分组「${name}」吗？`
    if (window.confirm(message)) onRemoveGroup(name)
  }

  function handleDeleteTool() {
    if (!editingTool) return
    if (window.confirm(`确定删除工具「${editingTool.name}」吗？`)) {
      onRemoveTool(editingTool.id)
      setEditing(null)
    }
  }

  function handleReset() {
    if (window.confirm('确定恢复成初始的工具数据吗？你自己添加的分组和工具都会丢失。')) {
      onReset()
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/50 p-4 sm:py-10"
      onClick={() => {
        // 填表单时点背景不关闭，避免误触丢内容
        if (!editing) onClose()
      }}
    >
      <div
        className="mx-auto w-full max-w-2xl rounded-2xl bg-white shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h2 className="text-lg font-semibold text-slate-900">
            {editing ? (editingTool ? '编辑工具' : '添加工具') : '编辑分组'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="rounded-lg px-2 py-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
          >
            ✕
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">
          {editing ? (
            <ToolForm
              // key 变化会让表单重置，避免切换工具时残留上一个的内容
              key={editingTool?.id ?? 'new-' + editingCategory}
              category={editingCategory}
              tool={editingTool}
              onSave={(values) => {
                if (editingTool) onUpdateTool(editingTool.id, values)
                else onAddTool(editingCategory, values)
                setEditing(null)
              }}
              onCancel={() => setEditing(null)}
              onDelete={editingTool ? handleDeleteTool : undefined}
            />
          ) : (
            <>
              {/* 一键添加新分组 */}
              <div className="mb-5 rounded-xl bg-slate-50 p-3">
                <label className="mb-1 block text-sm font-medium text-slate-700">
                  添加新分组
                </label>
                <div className="flex gap-2">
                  <input
                    value={newGroup}
                    onChange={(event) => setNewGroup(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') handleAddGroup()
                    }}
                    placeholder="例如：教务"
                    className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
                  />
                  <button
                    type="button"
                    onClick={handleAddGroup}
                    className="rounded-lg bg-sky-600 px-4 py-2 text-sm text-white shadow-sm transition hover:bg-sky-700"
                  >
                    添加
                  </button>
                </div>
              </div>

              {/* 分组列表（支持拖拽移动工具） */}
              <GroupEditorList
                groups={groups}
                tools={tools}
                onMoveTool={onMoveTool}
                onEditTool={(category, tool) => setEditing({ category, tool })}
                onAddTool={(category) => setEditing({ category, tool: null })}
                onRemoveGroup={handleRemoveGroup}
                autoScroll={autoScroll}
              />

              {/* 恢复默认 */}
              <div className="mt-6 border-t border-slate-100 pt-4">
                <button
                  type="button"
                  onClick={handleReset}
                  className="text-sm text-slate-400 transition hover:text-rose-600"
                >
                  恢复默认数据
                </button>
                <p className="mt-1 text-xs text-slate-400">
                  提示：所有修改都保存在这台设备的浏览器里，不会上传到服务器。
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
