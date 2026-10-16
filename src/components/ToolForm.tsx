// 工具表单：新增或编辑一个工具（名称 / 网址 / 图标 / 备注）。

import { useState, type FormEvent } from 'react'
import type { Tool, ToolDraft } from '../types'

interface ToolFormProps {
  category: string
  tool: Tool | null          // 传 null 表示"新增"
  onSave: (values: ToolDraft) => void
  onCancel: () => void
  onDelete?: () => void      // 只有编辑已有工具时才有
}

// 常用图标，点一下就能填进去
const QUICK_ICONS = ['📚', '📝', '🔗', '📊', '🏫', '💻', '🎓', '📅', '📌', '⚙️', '🗂️', '🧮']

// 用户可能只填 "jw.xxx.edu.cn"，这里自动补上 https://
function normalizeUrl(input: string) {
  const value = input.trim()
  if (value === '') return ''
  return /^https?:\/\//i.test(value) ? value : 'https://' + value
}

const inputClass =
  'field'

export default function ToolForm({
  category,
  tool,
  onSave,
  onCancel,
  onDelete,
}: ToolFormProps) {
  // 每个输入框一个状态；如果是编辑，就用原来的值做初值
  const [name, setName] = useState(tool?.name ?? '')
  const [url, setUrl] = useState(tool?.url ?? '')
  const [icon, setIcon] = useState(tool?.icon ?? '')
  const [description, setDescription] = useState(tool?.description ?? '')
  const [error, setError] = useState('')

  function handleSubmit(event: FormEvent) {
    event.preventDefault()

    if (!name.trim()) {
      setError('请填写工具名称')
      return
    }
    if (!url.trim()) {
      setError('请填写网址链接')
      return
    }

    setError('')
    onSave({
      name: name.trim(),
      url: normalizeUrl(url),
      icon: icon.trim(),
      description: description.trim(),
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <p className="text-sm text-fg-subtle">
        所属分组：
        <span className="ml-1 font-medium text-fg-muted">{category}</span>
      </p>

      <div>
        <label className="mb-1 block text-sm font-medium text-fg-muted">
          名称 <span className="text-danger">*</span>
        </label>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="例如：教务系统"
          className={inputClass}
        />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-fg-muted">
          网址链接 <span className="text-danger">*</span>
        </label>
        <input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="例如：https://jw.xxx.edu.cn"
          className={inputClass}
        />
        <p className="mt-1 text-xs text-fg-subtle">
          不写 https:// 也可以，保存时会自动补上
        </p>
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-fg-muted">图标</label>
        <div className="flex items-center gap-3">
          <input
            value={icon}
            onChange={(event) => setIcon(event.target.value)}
            placeholder="填一个 emoji，例如 📚"
            maxLength={4}
            className={inputClass + ' flex-1'}
          />
          {/* 实时预览 */}
          <span className="flex h-10 w-11 shrink-0 items-center justify-center rounded-lg bg-surface-3 text-xl">
            {icon || '🔗'}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          {QUICK_ICONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => setIcon(emoji)}
              className="rounded-md px-2 py-1 text-lg leading-none transition hover:bg-surface-3"
            >
              {emoji}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-fg-muted">备注</label>
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          rows={2}
          placeholder="一句话说明，例如：查成绩、选课"
          className={inputClass + ' resize-none'}
        />
        <p className="mt-1 text-xs text-fg-subtle">会显示在卡片名称下方</p>
      </div>

      {error && (
        <p className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      <div className="flex items-center justify-between gap-2 border-t border-line-soft pt-4">
        <div>
          {onDelete && (
            <button
              type="button"
              onClick={onDelete}
              className="btn btn-danger"
            >
              删除此工具
            </button>
          )}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="btn btn-outline"
          >
            取消
          </button>
          <button
            type="submit"
            className="btn btn-primary"
          >
            保存
          </button>
        </div>
      </div>
    </form>
  )
}
