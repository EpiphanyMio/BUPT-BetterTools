// 「云端同步」设置区：看当前账号、同步状态，手动同步一次，退出登录。
//
// 为什么这里不再有"填令牌"：
//   以前是单用户 + 一个共享令牌（SYNC_TOKEN），令牌就等于密码，只能靠人手动粘贴。
//   现在改成账号登录（邀请码注册），令牌是登录成功后服务器发的、存在浏览器里，
//   界面上该出现的就只剩"我是谁 / 同步得怎么样 / 退出登录"。
//
// 为什么退出登录要弹确认、还要说明会清本地数据：
//   它确实是"清空这台浏览器里那份数据"的操作（云端还有一份，重新登录会拉回来）。
//   不写清楚，用户会以为退出等于清空云端，或者反过来以为本地数据还在。

import { useState } from 'react'
import { formatTime } from '../lib/fileUtils'
import { useAuth } from '../hooks/useAuth'
import { useSync } from '../hooks/useSync'
import type { SyncStatus } from '../types'

// 每个状态配一句话和一颗圆点。
// 颜色只用语义令牌（success / warn / danger / primary），深浅主题会自动跟着变。
const STATUS_META: Record<SyncStatus, { text: string; dot: string }> = {
  unauthenticated: { text: '未登录（不会上传任何数据）', dot: 'bg-fg-subtle' },
  unconfigured: { text: '未启用（不联网，数据只在本机）', dot: 'bg-fg-subtle' },
  idle: { text: '待同步', dot: 'bg-warn' },
  syncing: { text: '同步中…', dot: 'bg-primary' },
  synced: { text: '已同步', dot: 'bg-success' },
  offline: { text: '连不上服务器（本地照常可用）', dot: 'bg-warn' },
  error: { text: '同步出错', dot: 'bg-danger' },
}

export default function SyncSettings() {
  const { user, logout } = useAuth()
  // 注意：不要再从 useSync 里取 isConfigured —— 它现在的含义还是"填过共享令牌没有"，
  // 已经和登录状态无关了。判断登录一律用 useAuth().status。
  const { status, lastSyncedAt, lastError, syncNow } = useSync()

  // 退出过程中禁用按钮，避免连点两次
  const [leaving, setLeaving] = useState(false)

  const meta = STATUS_META[status]

  function handleLogout() {
    const confirmed = window.confirm(
      '退出登录会清空这台浏览器里保存的工具、分组、收藏、排序和默认分组。\n\n' +
        '云端那份数据不会删，重新登录就会拉回来。\n\n确定退出登录吗？',
    )
    if (!confirmed) return

    setLeaving(true)
    // logout 内部会：通知服务器作废会话 → 清本地数据 → 刷新页面。
    // 所以这里不用写任何收尾代码，刷新之后就已经是登录界面了。
    void logout()
  }

  return (
    <div className="rounded-btn border border-line px-4 py-3">
      {/* ---- 当前账号 ---- */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-fg-subtle">当前账号</span>
        <span className="text-sm font-medium text-fg">{user?.username ?? '—'}</span>
        {user?.isAdmin === true && (
          <span className="rounded-full bg-primary-soft px-2 py-0.5 text-xs font-medium text-primary">
            管理员
          </span>
        )}
      </div>

      {/* ---- 同步状态 ---- */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span aria-hidden="true" className={'h-2 w-2 shrink-0 rounded-full ' + meta.dot} />
        <span className="text-sm font-medium text-fg-muted">{meta.text}</span>
        {status === 'synced' && lastSyncedAt > 0 && (
          <span className="text-xs text-fg-subtle">· 上次同步 {formatTime(lastSyncedAt)}</span>
        )}
      </div>

      {/* 错误提示：只显示服务端给的具体原因，不要吞掉 */}
      {lastError !== '' && (
        <p className="mt-2 rounded-btn bg-danger-bg px-3 py-2 text-xs leading-relaxed text-danger">
          {lastError}
        </p>
      )}

      {/* ---- 操作 ---- */}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void syncNow()}
          disabled={status === 'syncing' || leaving}
          className="btn btn-outline btn-sm"
        >
          立即同步
        </button>
        <button
          type="button"
          onClick={handleLogout}
          disabled={leaving}
          className="btn btn-danger btn-sm"
        >
          {leaving ? '正在退出…' : '退出登录'}
        </button>
      </div>

      <p className="mt-3 text-xs leading-relaxed text-fg-subtle">
        同步的是：工具清单、分组、收藏、排序、默认分组 —— 只在你自己的账号里，别人看不到。
        不同步：主题（每台设备各自的显示偏好）、开发者参数、文件管理里的文件。
        退出登录不会删除云端数据，只是把这台浏览器里那份副本清掉。
      </p>
    </div>
  )
}
