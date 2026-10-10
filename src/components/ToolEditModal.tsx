// 单个工具的快速编辑弹窗（从卡片右下角的 ✎ 按钮打开）。
// 复用 ToolForm，所以字段和「编辑分组」里完全一致。

import { useEffect } from 'react'
import type { Tool, ToolDraft } from '../types'
import ToolForm from './ToolForm'

interface ToolEditModalProps {
  tool: Tool | null          // null 表示不显示
  onSave: (id: string, values: ToolDraft) => void
  onDelete: (id: string) => void
  onClose: () => void
}

export default function ToolEditModal({
  tool,
  onSave,
  onDelete,
  onClose,
}: ToolEditModalProps) {
  // 按 Esc 关闭，并锁住背景滚动
  useEffect(() => {
    if (!tool) return

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
  }, [tool, onClose])

  // ⚠️ Hook 必须写在 return 之前
  if (!tool) return null

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/50 p-4 sm:py-10"
      onClick={onClose}
    >
      <div
        className="mx-auto w-full max-w-lg rounded-2xl bg-white shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h2 className="text-lg font-semibold text-slate-900">编辑工具</h2>
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
          <ToolForm
            key={tool.id}
            category={tool.category}
            tool={tool}
            onSave={(values) => {
              onSave(tool.id, values)
              onClose()
            }}
            onCancel={onClose}
            onDelete={() => {
              if (window.confirm(`确定删除工具「${tool.name}」吗？`)) {
                onDelete(tool.id)
                onClose()
              }
            }}
          />
        </div>
      </div>
    </div>
  )
}
