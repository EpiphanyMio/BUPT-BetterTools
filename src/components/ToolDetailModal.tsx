// 工具详情面板。
//
// 为什么单独做一个"详情"而不是直接用编辑弹窗：
//   卡片上位置有限，简介被截成两行、网址只显示成一个可点的链接。
//   详情页负责"看全" —— 完整简介、完整网址、所属分组、收藏状态，
//   以及两个最常用的动作（打开 / 复制网址）。
//   编辑、删除仍然留在卡片右下角的 ✎ 菜单里，两边职责不重叠。

import { useEffect, useState } from 'react'
import type { Tool } from '../types'

interface ToolDetailModalProps {
  tool: Tool | null // null 表示不显示
  isFavorite: boolean
  onToggleFavorite: (id: string) => void
  onClose: () => void
}

export default function ToolDetailModal({
  tool,
  isFavorite,
  onToggleFavorite,
  onClose,
}: ToolDetailModalProps) {
  // 复制成功后的临时提示（1.6 秒后自动消失）
  const [copied, setCopied] = useState(false)

  // 每次打开新的工具就把提示清掉，免得上次的"已复制"残留到这次的另一个工具上
  useEffect(() => {
    setCopied(false)
  }, [tool?.id])

  // 按 Esc 关闭，并锁住背景滚动（和项目里其它弹窗保持一致的行为）
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

  // ⚠️ Hook 必须写在 return 之前，这是 React 的硬性规则
  if (!tool) return null

  async function handleCopy() {
    if (!tool) return
    try {
      await navigator.clipboard.writeText(tool.url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      // 浏览器可能因为"非安全上下文"等原因拒绝剪贴板权限，那就退化成让用户手动选
      window.prompt('复制下面的网址：', tool.url)
    }
  }

  return (
    <div className="scrim flex items-start justify-center p-4 sm:py-16" onClick={onClose}>
      <div
        className="modal-panel w-full max-w-md"
        onClick={(event) => event.stopPropagation()}
      >
        {/* 头部：图标 + 名称 + 关闭 */}
        <div className="flex items-start gap-3 px-5 pt-5">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-btn bg-surface-2 text-2xl">
            {tool.icon ?? '🔗'}
          </span>

          <div className="min-w-0 flex-1">
            <h2 className="truncate text-lg font-medium text-fg">{tool.name}</h2>
            <span className="mt-1 inline-block rounded-full bg-surface-3 px-2.5 py-0.5 text-xs font-medium text-fg-muted">
              {tool.category}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-0.5">
            {/* 收藏按钮放在详情里，是为了"看的时候顺手收藏"，不用退回卡片 */}
            <button
              type="button"
              onClick={() => onToggleFavorite(tool.id)}
              title={isFavorite ? '取消收藏' : '收藏'}
              aria-label={isFavorite ? '取消收藏' : '收藏'}
              className={
                'flex h-9 w-9 items-center justify-center rounded-full text-xl leading-none transition hover:bg-surface-3 ' +
                (isFavorite ? 'text-warn' : 'text-fg-subtle hover:text-warn')
              }
            >
              <span aria-hidden="true">{isFavorite ? '★' : '☆'}</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              title="关闭"
              aria-label="关闭"
              className="btn-icon btn"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="px-5 pb-5 pt-4">
          {/* 完整简介：详情页里不做行数限制，该多长就多长 */}
          <h3 className="mb-1 text-xs font-medium tracking-wide text-fg-subtle">备注</h3>
          {tool.description ? (
            <p className="text-sm leading-relaxed text-fg-muted">{tool.description}</p>
          ) : (
            <p className="text-sm text-fg-subtle">（没有填写备注）</p>
          )}

          {/* 网址：用等宽字体 + 可选中，长网址会自动换行 */}
          <h3 className="mb-1 mt-5 text-xs font-medium tracking-wide text-fg-subtle">网址</h3>
          <div className="flex items-start gap-2">
            <code className="min-w-0 flex-1 select-all break-all rounded-btn bg-surface-2 px-3 py-2 text-xs leading-relaxed text-fg-muted">
              {tool.url}
            </code>
            <button
              type="button"
              onClick={handleCopy}
              title="复制网址"
              aria-label="复制网址"
              className="btn btn-neutral shrink-0"
            >
              {copied ? '✓ 已复制' : '复制'}
            </button>
          </div>

          {/* 主操作 */}
          <a
            href={tool.url}
            target="_blank"
            rel="noreferrer"
            className="btn btn-primary mt-5 w-full"
          >
            打开链接 ↗
          </a>
        </div>
      </div>
    </div>
  )
}
