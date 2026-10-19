// 开发者设置的中央存储（带本地持久化）。
//
// ┌─────────────────────────────────────────────────────────────┐
// │ 以后要新增一个调试参数，只需要改三个地方：                    │
// │   1. 下面的 DEFAULT_DEV_SETTINGS 里加一行（默认值）           │
// │   2. DevSettingsPanel.tsx 的 FIELDS 里加一行（界面描述）      │
// │   3. 在用到它的组件里读 settings.xxx                          │
// └─────────────────────────────────────────────────────────────┘

import { useCallback, useEffect, useState } from 'react'
import { isGuest } from '../lib/guestMode'

const STORAGE_KEY = 'better-tools:dev-settings'

// ---- 调试参数的默认值 ----
export const DEFAULT_DEV_SETTINGS = {
  // 拖动前需要移动多少像素才算"开始拖"
  dragActivationDistance: 6,
  // 拖动时是否开启自动滚动
  autoScrollEnabled: true,
  // 自动滚动触发区：距容器边缘多少比例内开始滚动（0~1）
  autoScrollThreshold: 0.2,
  // 自动滚动加速度：数值越大滚得越快
  autoScrollAcceleration: 12,
}

export type DevSettings = typeof DEFAULT_DEV_SETTINGS
export type DevSettingKey = keyof DevSettings

export function useDevSettings() {
  const [settings, setSettings] = useState<DevSettings>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      // 用默认值兜底：以后新增参数时，老用户存的数据里没有这个字段也不会出错
      return raw
        ? { ...DEFAULT_DEV_SETTINGS, ...(JSON.parse(raw) as Partial<DevSettings>) }
        : { ...DEFAULT_DEV_SETTINGS }
    } catch {
      return { ...DEFAULT_DEV_SETTINGS }
    }
  })

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  }, [settings])

  const updateSetting = useCallback(
    (key: DevSettingKey, value: DevSettings[DevSettingKey]) => {
      // 访客预览是「只读」的：开发者参数同样存在 localStorage 里，
      // 也是"内容"的一部分，不能因为面板藏得深就放过。
      if (isGuest()) return
      setSettings((prev) => ({ ...prev, [key]: value }) as DevSettings)
    },
    [],
  )

  const resetSettings = useCallback(() => {
    // 访客只读：恢复默认会覆盖本地参数
    if (isGuest()) return
    setSettings({ ...DEFAULT_DEV_SETTINGS })
  }, [])

  return { settings, updateSetting, resetSettings }
}
