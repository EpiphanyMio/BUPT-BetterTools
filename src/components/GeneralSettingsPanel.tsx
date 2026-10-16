// 「通用设置」面板：日常使用相关的选项，以及进入「开发者设置」的入口。
//
// 它是两级结构：
//   第一级 —— 通用设置首页（主题、打开的默认分组）
//   第二级 —— 开发者设置（点进去才显示，左上角 ← 或按 Esc 返回）
//
// 为什么要分两级：开发者参数是"调一次就很少再动"的东西，
// 和日常选项混在一页会让人不知道该看哪儿。

import { useEffect, useState } from 'react'
import { ALL } from '../lib/constants'
import type { AppSettings } from '../hooks/useAppSettings'
import type { DevSettingKey, DevSettings } from '../hooks/useDevSettings'
import { THEME_OPTIONS, useTheme } from '../hooks/useTheme'
import DevSettingsContent from './DevSettingsContent'

interface GeneralSettingsPanelProps {
  open: boolean
  onClose: () => void
  /** 现有分组，用于"默认分组"下拉 */
  groups: string[]
  settings: AppSettings
  onChange: (key: keyof AppSettings, value: string) => void
  devSettings: DevSettings
  onDevChange: (key: DevSettingKey, value: DevSettings[DevSettingKey]) => void
  onDevReset: () => void
}

export default function GeneralSettingsPanel({
  open,
  onClose,
  groups,
  settings,
  onChange,
  devSettings,
  onDevChange,
  onDevReset,
}: GeneralSettingsPanelProps) {
  const [page, setPage] = useState<'main' | 'dev'>('main')

  // 主题是全局单例状态（见 hooks/useTheme.ts），
  // 这里读到的和头部那个切换按钮读到的永远是同一份，不会错位。
  const { mode: themeMode, setTheme, resolved, systemDark } = useTheme()

  // 关闭时退回第一级 —— 下次打开总是从首页开始，不会停在上次进过的二级页
  useEffect(() => {
    if (!open) setPage('main')
  }, [open])

  // 按 Esc：在二级窗口时先返回上一级，在首页时才关闭整个面板
  useEffect(() => {
    if (!open) return

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      if (page === 'dev') setPage('main')
      else onClose()
    }
    window.addEventListener('keydown', onKeyDown)

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [open, onClose, page])

  // ⚠️ Hook 必须写在 return 之前
  if (!open) return null

  const inDev = page === 'dev'
  // 选中的分组可能已经被删掉了，那就退回"全部"
  const selected = groups.includes(settings.defaultCategory)
    ? settings.defaultCategory
    : ALL

  return (
    <div className="scrim p-4 sm:py-10" onClick={onClose}>
      <div
        className="modal-panel mx-auto w-full max-w-lg"
        onClick={(event) => event.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div className="flex min-w-0 items-center gap-2">
            {inDev && (
              <button
                type="button"
                onClick={() => setPage('main')}
                aria-label="返回通用设置"
                title="返回通用设置"
                className="btn-icon btn"
              >
                ←
              </button>
            )}
            <h2 className="truncate text-lg font-medium text-fg">
              {inDev ? '开发者设置' : '通用设置'}
            </h2>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭" className="btn-icon btn">
            ✕
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">
          {inDev ? (
            <DevSettingsContent
              settings={devSettings}
              onChange={onDevChange}
              onReset={onDevReset}
            />
          ) : (
            <>
              {/* ---------- 第一级：通用设置 ---------- */}
              <h3 className="mb-3 text-xs font-medium tracking-wide text-fg-subtle">
                界面
              </h3>

              {/* ---- 主题：三个选项做成"分段控件" ---- */}
              <div className="block">
                <span className="block text-sm font-medium text-fg-muted">主题</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-fg-subtle">
                  选「跟随系统」时，会跟着电脑/手机的深浅设置自动变化。
                  当前实际显示：
                  <b className="text-fg-muted">{resolved === 'dark' ? '深色' : '浅色'}</b>
                  {themeMode === 'system' && (
                    <>（系统现在是{systemDark ? '深色' : '浅色'}）</>
                  )}
                  。
                </span>

                {/* 分段控件：外框一条描边，内部按钮靠 gap 留出分隔线，
                    选中项用主色淡底 + 主色文字（不是涂满主色 —— 那样深色模式下会刺眼）。
                    最左/最右按钮各自圆角，配合外框的 overflow-hidden 形成规整的胶囊。 */}
                <div className="mt-2 flex gap-px overflow-hidden rounded-btn border border-line bg-line">
                  {THEME_OPTIONS.map((option, index) => {
                    const active = themeMode === option.value
                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => setTheme(option.value)}
                        aria-pressed={active}
                        className={
                          'flex flex-1 items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium transition-colors ' +
                          // 首尾各自补圆角，中间保持方形
                          (index === 0
                            ? 'rounded-l-[7px] '
                            : index === THEME_OPTIONS.length - 1
                              ? 'rounded-r-[7px] '
                              : '') +
                          (active
                            ? 'bg-primary-soft text-primary'
                            : 'bg-surface text-fg-muted hover:bg-surface-2')
                        }
                      >
                        <span aria-hidden="true">{option.icon}</span>
                        <span>{option.label}</span>
                      </button>
                    )
                  })}
                </div>
              </div>

              <label className="mt-6 block">
                <span className="block text-sm font-medium text-fg-muted">
                  打开工具箱时的默认分组
                </span>
                <span className="mt-0.5 block text-xs leading-relaxed text-fg-subtle">
                  每次进入「常用工具」时自动选中这个分组，省去手动切换。
                  改完在下次打开工具箱时生效。
                </span>
                <select
                  value={selected}
                  onChange={(event) => onChange('defaultCategory', event.target.value)}
                  className="field field-boxed mt-2"
                >
                  <option value={ALL}>{ALL}（不筛选，显示所有工具）</option>
                  {groups.map((group) => (
                    <option key={group} value={group}>
                      {group}
                    </option>
                  ))}
                </select>
              </label>

              <h3 className="mb-3 mt-7 text-xs font-medium tracking-wide text-fg-subtle">
                高级
              </h3>

              <button
                type="button"
                onClick={() => setPage('dev')}
                className="flex w-full items-center justify-between gap-3 rounded-btn border border-line px-4 py-3 text-left transition hover:border-primary hover:bg-surface-2"
              >
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-fg-muted">
                    开发者设置
                  </span>
                  <span className="mt-0.5 block text-xs text-fg-subtle">
                    拖动激活距离、自动滚动速度等调试参数
                  </span>
                </span>
                <span className="shrink-0 text-lg text-fg-subtle">›</span>
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
