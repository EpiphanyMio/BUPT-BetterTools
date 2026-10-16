// 「开发者设置」的内容部分（不含弹窗外框）。
//
// 它本身不是弹窗 —— 而是被 GeneralSettingsPanel 当作二级窗口的内容来渲染。
// 拆出来的好处：这一堆参数控件可以放在任何容器里，不必被"必须是个弹窗"绑死。
//
// 新增参数：在下面的 FIELDS 数组里加一行描述，界面上就会自动出现对应控件。

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

interface DevSettingsContentProps {
  settings: DevSettings
  onChange: (key: DevSettingKey, value: DevSettings[DevSettingKey]) => void
  onReset: () => void
}

export default function DevSettingsContent({
  settings,
  onChange,
  onReset,
}: DevSettingsContentProps) {
  // 清空本工具在浏览器里保存的全部数据（调试时经常要用）
  function handleClearStorage() {
    const keys = Object.keys(localStorage).filter((key) =>
      key.startsWith('better-tools:'),
    )
    if (
      !window.confirm(
        `确定清空本工具在浏览器里保存的全部数据吗？\n\n将删除 ${keys.length} 项：` +
          '工具、分组、收藏、排序、拖动顺序、通用设置、开发者设置。\n（浏览器里的文件不会被删除）\n清空后页面会重新加载。',
      )
    ) {
      return
    }
    keys.forEach((key) => localStorage.removeItem(key))
    window.location.reload()
  }

  return (
    <>
      <p className="mb-4 rounded-lg bg-surface-2 px-3 py-2 text-xs leading-relaxed text-fg-subtle">
        这里的参数用于调试，只影响这台设备的这次浏览，都会保存到浏览器本地。
      </p>

      {/* ---- 参数列表 ---- */}
      {FIELDS.length === 0 ? (
        <p className="py-8 text-center text-sm text-fg-subtle">还没有可调参数</p>
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
                    <span className="block text-sm font-medium text-fg-muted">
                      {field.label}
                    </span>
                    {field.description && (
                      <span className="mt-0.5 block text-xs leading-relaxed text-fg-subtle">
                        {field.description}
                      </span>
                    )}
                  </span>
                  <input
                    type="checkbox"
                    checked={Boolean(value)}
                    onChange={(event) => onChange(field.key, event.target.checked)}
                    className="mt-1 check"
                  />
                </label>
              )
            }

            return (
              <div key={field.key}>
                <label className="block text-sm font-medium text-fg-muted">
                  {field.label}
                </label>
                {field.description && (
                  <p className="mt-0.5 text-xs leading-relaxed text-fg-subtle">
                    {field.description}
                  </p>
                )}
                <input
                  type="number"
                  value={Number(value)}
                  min={field.min}
                  max={field.max}
                  step={field.step}
                  onChange={(event) => onChange(field.key, Number(event.target.value))}
                  className="mt-1.5 w-28field"
                />
              </div>
            )
          })}
        </div>
      )}

      {/* ---- 操作 ---- */}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-line-soft pt-4">
        <button
          type="button"
          onClick={onReset}
          className="btn btn-outline"
        >
          参数恢复默认值
        </button>
        <button
          type="button"
          onClick={handleClearStorage}
          className="btn btn-danger"
        >
          清空本地数据
        </button>
      </div>
    </>
  )
}
