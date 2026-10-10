// 由「开发者设置」里的参数，生成 dnd-kit 需要的 autoScroll 配置。
// 主页和编辑弹窗都用这个函数，保证两边行为一致、都能被调试参数控制。

import type { DevSettings } from '../hooks/useDevSettings'

export interface AutoScrollConfig {
  enabled: boolean
  threshold: { x: number; y: number }
  acceleration: number
}

export function buildAutoScroll(dev: DevSettings): AutoScrollConfig {
  return {
    enabled: dev.autoScrollEnabled,
    // 用一个参数同时设置横向和纵向的触发区
    threshold: {
      x: dev.autoScrollThreshold,
      y: dev.autoScrollThreshold,
    },
    acceleration: dev.autoScrollAcceleration,
  }
}
