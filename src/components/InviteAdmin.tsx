// 管理员专用：邀请码的列表、生成、删除。
//
// 为什么整块只对管理员渲染（见 DevSettingsContent）：
//   发邀请码是低频的管理动作，普通用户根本用不到。非管理员连 DOM 都不出现，
//   而不是"渲染出来再禁用"—— 一个在那儿却点不动的按钮，比没有更让人困惑。
//
// 接口都在 /api/invites 下，非管理员访问会被服务端回 403；
// 这里的 isAdmin 只用来决定"显不显示"，不作为安全依据（安全依据在服务端）。

import { useCallback, useEffect, useRef, useState } from 'react'
import { AuthError, authErrorMessage, authRequest, validateInviteCode } from '../lib/auth'
import { formatTime } from '../lib/fileUtils'
import type { Invite } from '../types'

// 时间字段读得宽松一点：契约说的是毫秒时间戳，但万一是 ISO 字符串，
// 整列时间也不该变成空白。读不出来的当 0（界面上显示"未知"）。
function toTime(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

/**
 * 把服务端返回的 { invites: [...] } 解析成数组。
 *
 * 为什么要逐字段核对：这份数据是直接拿去渲染列表的。
 * 一条缺 code 的记录会让列表出现 key 为 undefined 的行，React 会报警告、
 * 界面上还会多出一条"看不见的"空行 —— 与其如此，不如跳过这条坏数据。
 */
function parseInvites(body: unknown): Invite[] {
  if (typeof body !== 'object' || body === null) return []

  const raw = (body as { invites?: unknown }).invites
  if (!Array.isArray(raw)) return []

  const out: Invite[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const row = item as Record<string, unknown>
    if (typeof row.code !== 'string' || row.code === '') continue

    const usedAt = toTime(row.usedAt)
    out.push({
      code: row.code,
      createdAt: toTime(row.createdAt),
      usedBy: typeof row.usedBy === 'string' && row.usedBy !== '' ? row.usedBy : null,
      usedAt: usedAt > 0 ? usedAt : null,
    })
  }
  return out
}

export default function InviteAdmin() {
  const [invites, setInvites] = useState<Invite[]>([])
  const [loading, setLoading] = useState(true)
  // 正在忙哪一件事：'' 空闲、'create' 正在生成、否则是正在删除的那个 code。
  // 用一个字符串而不是几个布尔，是为了让"同一时刻只允许一个操作"这件事一目了然。
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [freshCode, setFreshCode] = useState('')   // 刚生成出来的码，单独亮出来方便复制
  const [customCode, setCustomCode] = useState('') // 可选的自定义码（留空就随机生成）

  const freshRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setInvites(parseInvites(await authRequest('/invites')))
      setError('')
    } catch (err) {
      setError(authErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // 新码一出现就聚焦并全选：用户接下来要做的是 Ctrl+C，
  // 让他还得先点一下输入框，等于白多一步。
  useEffect(() => {
    if (freshCode === '') return
    freshRef.current?.focus()
    freshRef.current?.select()
  }, [freshCode])

  async function handleCreate() {
    if (busy !== '') return

    const custom = customCode.trim()
    if (custom !== '') {
      // 自定义码先在本地拦一道，省一次注定 400 的请求
      const problem = validateInviteCode(custom)
      if (problem) {
        setError(problem)
        return
      }
    }

    setBusy('create')
    setError('')
    try {
      const body = await authRequest('/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 契约两种用法：body 里不带 code 由服务端随机生成，带 code 就用这个
        body: JSON.stringify(custom === '' ? {} : { code: custom }),
      })
      const code =
        typeof body === 'object' && body !== null && typeof (body as { code?: unknown }).code === 'string'
          ? (body as { code: string }).code
          : ''
      if (code === '') throw new AuthError('bad-response', '服务器没有返回新邀请码')

      setFreshCode(code)
      setCustomCode('')
      // 列表以服务端为准重新拉一遍：不要在本地手动 push 一条"猜出来的"记录，
      // 否则创建时间、排序、以及"服务端其实已经存在这个码"这类情况都会对不上。
      await load()
    } catch (err) {
      setError(authErrorMessage(err))
    } finally {
      setBusy('')
    }
  }

  async function handleDelete(invite: Invite) {
    if (busy !== '') return

    // 删之前问一句：误点一次就少一个邀请码，而且列表里再也看不到它。
    // 用过的那条删掉只是去掉记录，账号本身不受影响 —— 文案里要说清楚，免得以为会连带删账号。
    const confirmed = window.confirm(
      invite.usedBy === null
        ? `确定删除还没用过的邀请码 ${invite.code} 吗？`
        : `邀请码 ${invite.code} 已经被「${invite.usedBy}」用过了。\n\n删除只会去掉这条记录，那个账号不受影响。确定删除吗？`,
    )
    if (!confirmed) return

    setBusy(invite.code)
    setError('')
    try {
      await authRequest('/invites/' + encodeURIComponent(invite.code), { method: 'DELETE' })
    } catch (err) {
      // 404 = 它已经不在了（比如另一个标签页先删过）。这种情况刷新列表就行，不算失败；
      // 其它错误才需要显示出来。
      if (!(err instanceof AuthError && err.code === 'not-found')) {
        setError(authErrorMessage(err))
        setBusy('')
        return
      }
    }
    if (freshCode === invite.code) setFreshCode('')
    await load()
    setBusy('')
  }

  return (
    <section className="mt-6 border-t border-line-soft pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-fg-muted">邀请码</h3>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading || busy !== ''}
          className="btn btn-text btn-sm"
        >
          刷新
        </button>
      </div>
      <p className="mt-0.5 text-xs leading-relaxed text-fg-subtle">
        只有管理员能看到这一块。每个邀请码只能注册一个账号，用过的会记下是谁用的。
      </p>

      {/* ---- 生成 ---- */}
      <div className="mt-3 flex flex-wrap gap-2">
        <input
          type="text"
          value={customCode}
          onChange={(event) => setCustomCode(event.target.value)}
          placeholder="自定义邀请码（可留空，留空随机生成）"
          autoComplete="off"
          spellCheck={false}
          disabled={busy !== ''}
          className="field field-boxed min-w-0 flex-1 font-mono"
        />
        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={busy !== ''}
          className="btn btn-primary btn-sm shrink-0"
        >
          {busy === 'create' ? '生成中…' : '生成邀请码'}
        </button>
      </div>

      {/* ---- 刚生成的那个码 ---- */}
      {freshCode !== '' && (
        <div className="mt-3 rounded-btn bg-primary-soft px-3 py-2">
          <p className="text-xs font-medium text-primary">
            新邀请码：点一下输入框可全选，再 Ctrl+C 复制
          </p>
          <input
            ref={freshRef}
            type="text"
            readOnly
            value={freshCode}
            onClick={(event) => event.currentTarget.select()}
            aria-label="新生成的邀请码"
            className="mt-1 w-full select-all rounded-btn border border-line bg-surface px-2 py-1 font-mono text-sm text-fg"
          />
        </div>
      )}

      {error !== '' && (
        <p
          role="alert"
          className="mt-3 rounded-btn bg-danger-bg px-3 py-2 text-xs leading-relaxed text-danger"
        >
          {error}
        </p>
      )}

      {/* ---- 列表 ---- */}
      {loading ? (
        <p className="mt-4 text-xs text-fg-subtle">正在读取邀请码…</p>
      ) : invites.length === 0 ? (
        <p className="mt-4 rounded-btn border border-dashed border-line px-3 py-6 text-center text-xs text-fg-subtle">
          还没有生成过邀请码
        </p>
      ) : (
        <ul className="mt-4 space-y-2">
          {invites.map((invite) => (
            <li key={invite.code} className="rounded-btn border border-line px-3 py-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  {/* select-all：单击就把整串选中，跟复制邀请码这个唯一用途对得上 */}
                  <code className="block select-all break-all font-mono text-sm text-fg">
                    {invite.code}
                  </code>
                  <p className="mt-0.5 text-xs leading-relaxed text-fg-subtle">
                    {invite.createdAt > 0 ? formatTime(invite.createdAt) + ' 创建' : '创建时间未知'}
                    {' · '}
                    {invite.usedBy === null ? (
                      '未使用'
                    ) : (
                      <span className="text-success">
                        已被 {invite.usedBy} 使用
                        {invite.usedAt !== null ? '（' + formatTime(invite.usedAt) + '）' : ''}
                      </span>
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void handleDelete(invite)}
                  disabled={busy !== ''}
                  className="btn btn-danger btn-sm shrink-0"
                >
                  {busy === invite.code ? '删除中…' : '删除'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
