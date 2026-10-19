// 「通用设置」的中央存储（带本地持久化）。
//
// 和 useDevSettings 的分工：
//   通用设置   —— 影响日常使用体验的选项（比如打开时的默认分组）
//   开发者设置 —— 调试用的参数（拖动激活距离、自动滚动速度等）
//
// 以后要新增一个通用设置项，改三个地方：
//   1. 下面的 DEFAULT_APP_SETTINGS 里加一行（默认值）
//   2. GeneralSettingsPanel.tsx 里加对应控件
//   3. 在用到它的组件里读 settings.xxx

import { useCallback, useEffect, useState } from 'react'
import { ALL, DATA_CHANGED_EVENT } from '../lib/constants'
import { isGuest } from '../lib/guestMode'

// 键名导出给 src/lib/syncData.ts 用（云端同步要按同样的键写回）
export const APP_SETTINGS_KEY = 'better-tools:app-settings'

export const DEFAULT_APP_SETTINGS = {
  // 每次打开工具箱时默认选中哪个分组。'全部' 表示不筛选。
  defaultCategory: ALL as string,
}

export type AppSettings = typeof DEFAULT_APP_SETTINGS

export function useAppSettings() {
  const [settings, setSettings] = useState<AppSettings>(() => {
    try {
      const raw = localStorage.getItem(APP_SETTINGS_KEY)
      // 用默认值兜底：以后新增字段时，老数据里没有这一项也不会出错
      return raw
        ? { ...DEFAULT_APP_SETTINGS, ...(JSON.parse(raw) as Partial<AppSettings>) }
        : { ...DEFAULT_APP_SETTINGS }
    } catch {
      return { ...DEFAULT_APP_SETTINGS }
    }
  })

  useEffect(() => {
    localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(settings))
  }, [settings])

  // 别处改了 localStorage（云端同步写回）时重新读
  useEffect(() => {
    function reload() {
      try {
        const raw = localStorage.getItem(APP_SETTINGS_KEY)
        setSettings(
          raw
            ? { ...DEFAULT_APP_SETTINGS, ...(JSON.parse(raw) as Partial<AppSettings>) }
            : { ...DEFAULT_APP_SETTINGS },
        )
      } catch {
        setSettings({ ...DEFAULT_APP_SETTINGS })
      }
    }
    window.addEventListener(DATA_CHANGED_EVENT, reload)
    return () => window.removeEventListener(DATA_CHANGED_EVENT, reload)
  }, [])

  const updateSetting = useCallback(
    <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
      // 访客预览是「只读」的：设置项会被存进 localStorage、还会跟着云端同步，
      // 属于用户数据的一部分，界面漏禁了也得在这里拦住。
      if (isGuest()) return
      setSettings((prev) => ({ ...prev, [key]: value }))
    },
    [],
  )

  const resetSettings = useCallback(() => {
    // 访客只读：恢复默认会覆盖本地设置
    if (isGuest()) return
    setSettings({ ...DEFAULT_APP_SETTINGS })
  }, [])

  return { settings, updateSetting, resetSettings }
}
