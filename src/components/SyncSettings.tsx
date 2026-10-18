// 「云端同步」设置区：填令牌、看状态、手动同步一次。
//
// 为什么是"填一个令牌"而不是"注册登录"：
//   这个后端只服务你一个人。做注册/登录/找回密码那一整套，代码量和出事面积都大好几倍，
//   换来的只是同一个人的账号。一串足够长的随机字符串已经够挡住外人 ——
//   前提是它够长、只存在浏览器里、而且没有进过仓库（.dev.vars 已被 gitignore）。
//
// 为什么输入框用 type="password"：令牌等于密码。
//   个人电脑上被室友/同事瞥一眼就抄走，成本太低了。

import { useState } from 'react'
import { formatTime } from '../lib/fileUtils'
import { useSync } from '../hooks/useSync'
import type { SyncStatus } from '../types'

// 每个状态配一句话和一颗圆点。
// 颜色只用语义令牌（success / warn / danger / primary），深浅主题会自动跟着变。
const STATUS_META: Record<SyncStatus, { text: string; dot: string }> = {
  unconfigured: { text: '未启用（不联网，数据只在本机）', dot: 'bg-fg-subtle' },
  idle: { text: '待同步', dot: 'bg-warn' },
  syncing: { text: '同步中…', dot: 'bg-primary' },
  synced: { text: '已同步', dot: 'bg-success' },
  offline: { text: '连不上服务器（本地照常可用）', dot: 'bg-warn' },
  error: { text: '同步出错', dot: 'bg-danger' },
}

export default function SyncSettings() {
  const { status, lastSyncedAt, lastError, isConfigured, syncNow, setToken } = useSync()
  // 已经配置过时，默认把输入框收起来 —— 令牌不是天天要看的东西
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  const meta = STATUS_META[status]
  const showForm = !isConfigured || editing

  function handleSave() {
    const value = draft.trim()
    if (!value) return
    setToken(value)
    setDraft('')
    setEditing(false)
    // 保存后立刻试一次；失败了也不会抛错，状态会自己变成 offline / error
    void syncNow()
  }

  function handleDisable() {
    setToken('')
    setEditing(false)
  }

  return (
    <div className="rounded-btn border border-line px-4 py-3">
      {/* 状态行 */}
      <div className="flex flex-wrap items-center gap-2">
        <span aria-hidden="true" className={"h-2 w-2 shrink-0 rounded-full " + meta.dot} />
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

      {showForm ? (
        <div className="mt-3">
          <label className="block">
            <span className="block text-xs text-fg-subtle">
              同步令牌（在 Cloudflare 上设置的那串 SYNC_TOKEN）
            </span>
            <input
              type="password"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') handleSave()
              }}
              placeholder="粘贴令牌…"
              autoComplete="off"
              className="field field-boxed mt-1"
            />
          </label>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={draft.trim() === ''}
              className="btn btn-primary btn-sm"
            >
              保存并同步
            </button>
            {isConfigured && (
              <button type="button" onClick={() => setEditing(false)} className="btn btn-text btn-sm">
                取消
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void syncNow()}
            disabled={status === 'syncing'}
            className="btn btn-outline btn-sm"
          >
            立即同步
          </button>
          <button type="button" onClick={() => setEditing(true)} className="btn btn-text btn-sm">
            更换令牌
          </button>
          <button type="button" onClick={handleDisable} className="btn btn-danger btn-sm">
            关闭同步
          </button>
        </div>
      )}

      <p className="mt-3 text-xs leading-relaxed text-fg-subtle">
        同步的是：工具清单、分组、收藏、排序、默认分组。
        不同步：主题（每台设备各自的显示偏好）、开发者参数、文件管理里的文件。
        关闭同步不会删除任何数据，只是不再上传。
      </p>
    </div>
  )
}