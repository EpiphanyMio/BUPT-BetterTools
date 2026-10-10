// 「开发者设置」面板：集中放置调试参数。
//
// 新增参数：在下面的 FIELDS 数组里加一行描述，界面上就会自动出现对应控件。

import { useEffect } from 'react'
import type { DevSettingKey, DevSettings } from '../hooks/useDevSettings'

// 参数界面的描述。key 必须和 DEFAULT_DEV_SETTINGS 里的字段名一致。
type FieldSpec =
  | { key: DevSettingKey; type: 'boolean'; label: string; description?: string }
  | {
      key: DevSettingKey
      type: 'number'
      label: string
      description?: string
      min?: number
      max?: number
      step?: number
    }

const FIELDS: FieldSpec[] = [
  {
    key: 'dragActivationDistance',
    type: 'number',
    label: '拖动激活距离（px）',
    description: '按住手柄后要移动多少像素才算开始拖动。调大可以避免误触。',
    min: 0,
    max: 30,
    step: 1,
  },
  {
    key: 'autoScrollEnabled',
    type: 'boolean',
    label: '拖拽时自动滚动',
    description: '拖到视口或容器边缘时，是否自动滚动。',
  },
  {
    key: 'autoScrollThreshold',
    type: 'number',
    label: '自动滚动触发区（0~1）',
    description: '距容器边缘多少比例内开始自动滚动。调大 = 更早开始滚，默认 0.2。',
    min: 0.02,
    max: 1,
    step: 0.01,
  },
  {
    key: 'autoScrollAcceleration',
    type: 'number',
    label: '自动滚动加速度',
    description: '数值越大滚得越快，默认 12。',
    min: 1,
    max: 50,
    step: 1,
  },
]

interface DevSettingsPanelProps {
  open: boolean
  onClose: () => void
  settings: DevSettings
  onChange: (key: DevSettingKey, value: DevSettings[DevSettingKey]) => void
  onReset: () => void
}

export default function DevSettingsPanel({
  open,
  onClose,
  settings,
  onChange,
  onReset,
}: DevSettingsPanelProps) {
  // 按 Esc 关闭，并锁住背景滚动
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

  // ⚠️ Hook 必须写在 return 之前
  if (!open) return null

  // 清空本工具在浏览器里保存的全部数据（调试时经常要用）
  function handleClearStorage() {
    const keys = Object.keys(localStorage).filter((key) =>
      key.startsWith('better-tools:'),
    )
    if (
      !window.confirm(
        `确定清空本工具在浏览器里保存的全部数据吗？\n\n将删除 ${keys.length} 项：` +
          `工具、分组、收藏、排序、拖动顺序、开发者设置。\n清空后页面会重新加载。`,
      )
    ) {
      return
    }
    keys.forEach((key) => localStorage.removeItem(key))
    window.location.reload()
  }

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/50 p-4 sm:py-10"
      onClick={onClose}
    >
      <div
        className="mx-auto w-full max-w-lg rounded-2xl bg-white shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h2 className="text-lg font-semibold text-slate-900">开发者设置</h2>
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
          <p className="mb-4 rounded-lg bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-500">
            这里的参数用于调试，只影响这台设备的这次浏览，都会保存到浏览器本地。
          </p>

          {/* ---- 参数列表 ---- */}
          {FIELDS.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-400">
              还没有可调参数
            </p>
          ) : (
            <div className="space-y-5">
              {FIELDS.map((field) => {
                const value = settings[field.key]

                if (field.type === 'boolean') {
                  return (
                    <label
                      key={field.key}
                      className="flex cursor-pointer items-start justify-between gap-4"
                    >
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-slate-700">
                          {field.label}
                        </span>
                        {field.description && (
                          <span className="mt-0.5 block text-xs leading-relaxed text-slate-400">
                            {field.description}
                          </span>
                        )}
                      </span>
                      <input
                        type="checkbox"
                        checked={Boolean(value)}
                        onChange={(event) =>
                          onChange(field.key, event.target.checked)
                        }
                        className="mt-1 h-4 w-4 shrink-0 accent-sky-600"
                      />
                    </label>
                  )
                }

                return (
                  <div key={field.key}>
                    <label className="block text-sm font-medium text-slate-700">
                      {field.label}
                    </label>
                    {field.description && (
                      <p className="mt-0.5 text-xs leading-relaxed text-slate-400">
                        {field.description}
                      </p>
                    )}
                    <input
                      type="number"
                      value={Number(value)}
                      min={field.min}
                      max={field.max}
                      step={field.step}
                      onChange={(event) =>
                        onChange(field.key, Number(event.target.value))
                      }
                      className="mt-1.5 w-28 rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
                    />
                  </div>
                )
              })}
            </div>
          )}

          {/* ---- 操作 ---- */}
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
            <button
              type="button"
              onClick={onReset}
              className="rounded-lg px-3 py-2 text-sm text-slate-600 ring-1 ring-slate-200 transition hover:bg-slate-100"
            >
              参数恢复默认值
            </button>
            <button
              type="button"
              onClick={handleClearStorage}
              className="rounded-lg px-3 py-2 text-sm text-rose-600 transition hover:bg-rose-50"
            >
              清空本地数据
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
