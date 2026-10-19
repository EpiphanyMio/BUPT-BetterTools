// 用户组管理：管理员查看所有注册用户的网盘用量、最近登录时间和 IP。
//
// 页面骨架照 ToolboxModule / FilesModule：顶部标题 + 返回 + 全局搜索，
// 内容区 max-w-5xl、bg-surface-2 打底，这样从首页点进来时视觉上是连续的。
//
// ---------------------------------------------------------------- 数据从哪来
//
// 只调 lib/userAdmin.ts 的 fetchAdminUsers()，不在组件里直接 fetch：
// 鉴权头、401/403 的翻译、响应体校验都在那一层做完了。
// 页面只负责三件事：加载中 / 出错 / 有数据。
//
// ---------------------------------------------------------------- 权限说明（很重要）
//
// 这里的 isAdmin 判断只决定"入口和页面显不显示"，不是安全边界。
// 真正的安全在服务端：GET /api/admin/users 对未登录回 401、对普通用户回 403。
// 所以就算有人绕过界面直接调接口，也拿不到任何人的数据。
// 页面底部那句提示就是把这个事实讲给管理员听，免得误以为前端藏起来就等于安全。

import { useCallback, useEffect, useMemo, useState } from 'react'
import { authErrorMessage } from '../lib/auth'
import { formatBytes, formatTime } from '../lib/fileUtils'
import { fetchAdminUsers } from '../lib/userAdmin'
import { useAuth } from '../hooks/useAuth'
import type { AdminUser } from '../types'

interface UserAdminModuleProps {
  onBack: () => void
  /** 打开「全局搜索」浮层 */
  onSearch: () => void
}

export default function UserAdminModule({ onBack, onSearch }: UserAdminModuleProps) {
  // 当前登录的管理员本人。只在"服务端没返回任何用户"这种异常空态里用一下，
  // 用来告诉管理员"你现在是以谁的身份在看"，而不是显示一张空白页面。
  const { user: me } = useAuth()

  const [users, setUsers] = useState<AdminUser[]>([])
  // 单人配额由后端下发；缺失时 lib/userAdmin.ts 已经兜底成 fileCloud 的默认值。
  const [quota, setQuota] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await fetchAdminUsers()
      setUsers(result.users)
      setQuota(result.quota)
    } catch (err) {
      // AuthError 的 message 已经是能给用户看的中文（401/403/断网都有对应说法）
      setError(authErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // 按用户名过滤：不区分大小写。
  // 用户名规则本身只允许字母数字，统一转小写后比较就够了，不需要正则或模糊匹配。
  const keyword = query.trim().toLowerCase()
  const visibleUsers = useMemo(() => {
    if (keyword === '') return users
    return users.filter((user) => user.username.toLowerCase().includes(keyword))
  }, [users, keyword])

  // 概览里的两个总数都按"全部用户"算（不受搜索框影响）：
  // 这个页面第一眼要回答的是"整个站点用了多少空间"，而不是"筛出来的这几个人用了多少"。
  const totalUsed = useMemo(
    () => users.reduce((sum, user) => sum + user.usedBytes, 0),
    [users],
  )
  const totalQuota = users.length * quota

  return (
    <div className="min-h-screen bg-surface-2 text-fg">
      <div className="mx-auto max-w-5xl px-4 py-8">
        {/* 标题区：窄屏纵向排列（和工具箱一致），避免按钮把标题挤成竖条 */}
        <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="min-w-0">
            <h1 className="text-3xl font-bold tracking-tight text-fg">👥 用户组管理</h1>
            <p className="mt-1 text-sm text-fg-subtle">
              所有注册用户的网盘用量、最近登录时间和 IP，数据来自云端。
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
            <button type="button" onClick={onBack} className="btn btn-neutral">
              ← 返回首页
            </button>

            <button
              type="button"
              onClick={onSearch}
              title="搜索工具和文件（Ctrl+K）"
              aria-label="搜索工具和文件"
              className="btn btn-neutral w-10 px-0 leading-none"
            >
              🔍
            </button>

            {/* 刷新：数据是实时统计出来的，用户刚上传完文件到这里想看到最新值，
                不能逼他刷新整页。加载中禁用，避免连点打出一串请求。 */}
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="btn btn-primary"
            >
              {loading ? '刷新中…' : '刷新'}
            </button>
          </div>
        </header>

        {/* ---- 概览 ----
            用"一条说明 + 一条总进度"的轻量卡片，不堆一堆数字卡片：
            管理员真正关心的是总用量占比，其它数字是佐证。 */}
        <section className="card mb-4 p-4">
          <p className="text-sm text-fg-muted">
            注册用户 <span className="font-medium text-fg">{users.length}</span> 位 · 云盘总用量{' '}
            <span className="font-medium text-fg">{formatBytes(totalUsed)}</span> /{' '}
            {formatBytes(totalQuota)}
          </p>
          <p className="mt-1 text-xs text-fg-subtle">
            单人配额 {formatBytes(quota)} · 总配额 = 用户数 × 单人配额
          </p>
          <div
            role="progressbar"
            aria-label="所有用户的云盘总用量"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={usagePercent(totalUsed, totalQuota)}
            className="mt-2 h-2 w-full overflow-hidden rounded-full bg-surface-3"
          >
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${usagePercent(totalUsed, totalQuota)}%` }}
            />
          </div>
        </section>

        {/* ---- 搜索 ---- */}
        <div className="mb-4">
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="按用户名搜索…"
            aria-label="按用户名搜索"
            autoComplete="off"
            spellCheck={false}
            className="field field-boxed"
          />
        </div>

        {/* ---- 错误态 ----
            role="alert" 让读屏器在出错时主动读出来（参考 InviteAdmin）。
            有旧数据时仍然保留下面的列表：刷新失败不等于"数据没了"，
            把已经看到的内容清空反而更难判断到底出了什么事。 */}
        {error !== '' && (
          <div
            role="alert"
            className="mb-4 flex flex-wrap items-center gap-3 rounded-btn bg-danger-bg px-3 py-2 text-sm text-danger"
          >
            <span className="min-w-0 flex-1">{error}</span>
            <button type="button" onClick={() => void load()} className="btn btn-text btn-sm">
              重试
            </button>
          </div>
        )}

        {/* ---- 加载 / 空态 / 列表 ----
            首次加载时列表还是空的，显示一句"正在读取"；已经有数据时刷新，
            直接保留旧列表 + 顶部按钮变"刷新中…"，不闪骨架屏。 */}
        {loading && users.length === 0 ? (
          <p className="rounded-card border border-dashed border-line bg-surface px-4 py-12 text-center text-sm text-fg-subtle">
            正在读取用户列表…
          </p>
        ) : visibleUsers.length === 0 ? (
          error === '' && (
            <div className="rounded-card border border-dashed border-line bg-surface px-4 py-12 text-center">
              <p className="text-sm text-fg-muted">
                {keyword !== ''
                  ? '没有找到匹配的用户，换个关键词试试'
                  : '还没有其他注册用户'}
              </p>
              {/* 空态也不能是一片空白：至少告诉管理员现在是谁在看这个页面。
                  正常情况下服务端会把管理员自己也算作一个用户返回，
                  所以这里只在"服务端返回 0 条"的异常情况才会派上用场。 */}
              {keyword === '' && me && (
                <p className="mt-2 text-xs text-fg-subtle">
                  当前登录：{me.username}（管理员）
                </p>
              )}
            </div>
          )
        ) : (
          <>
            {/* ---- 桌面：表格 ----
                hidden sm:block：窄屏放不下五列，改用下面的卡片列表；
                overflow-x-auto 兜住"窗口刚好比五列窄一点"的情况。 */}
            <div className="hidden overflow-x-auto rounded-card border border-line-soft bg-surface sm:block">
              <table className="w-full border-collapse text-left text-sm">
                <thead className="border-b border-line bg-surface-2 text-xs text-fg-muted">
                  <tr>
                    <th scope="col" className="px-4 py-3 font-medium">
                      用户
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      云盘用量
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      最近登录
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      IP
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      注册时间
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visibleUsers.map((user) => (
                    <tr
                      key={user.id}
                      className="border-b border-line-soft align-top last:border-b-0"
                    >
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-fg">{user.username}</span>
                          {user.isAdmin && <AdminBadge />}
                        </div>
                        {/* ID 放第二行小字：排查账号时后端日志里只有 id，
                            管理员能直接对上号，比再问一句"你 id 多少"省事。 */}
                        <p className="mt-0.5 text-xs text-fg-subtle">ID {user.id}</p>
                      </td>
                      <td className="px-4 py-3">
                        <UsageCell user={user} quota={quota} />
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-fg-muted">
                        {formatLastLogin(user.lastLoginAt)}
                      </td>
                      <td className="px-4 py-3 text-fg-muted">
                        <IpText ip={user.lastLoginIp} />
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-fg-muted">
                        {formatTime(user.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* ---- 移动端：卡片列表 ----
                五列表格在手机上会横向滚到没法看，所以拆成每人一张卡，
                用量、登录、IP 各占一行，从上往下读。 */}
            <ul className="space-y-3 sm:hidden">
              {visibleUsers.map((user) => (
                <li key={user.id} className="card p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-base font-medium text-fg">{user.username}</span>
                    {user.isAdmin && <AdminBadge />}
                  </div>
                  <p className="mt-0.5 text-xs text-fg-subtle">
                    ID {user.id} · 注册于 {formatTime(user.createdAt)}
                  </p>

                  <div className="mt-3">
                    <UsageCell user={user} quota={quota} />
                  </div>

                  <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-line-soft pt-3 text-xs">
                    <div>
                      <dt className="text-fg-subtle">最近登录</dt>
                      <dd className="mt-0.5 text-fg-muted">
                        {formatLastLogin(user.lastLoginAt)}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-fg-subtle">IP</dt>
                      <dd className="mt-0.5 text-fg-muted">
                        <IpText ip={user.lastLoginIp} />
                      </dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>

            {/* 只剩管理员自己时给一句提示：列表里只有一行很容易被误读成"数据没加载全"，
                说清楚"确实还没有别人注册"，比让人怀疑页面坏了要好。 */}
            {!loading && users.length === 1 && (
              <p className="mt-3 text-center text-xs text-fg-subtle">还没有其他注册用户</p>
            )}
          </>
        )}

        {/* ---- 权限与数据来源说明 ----
            两件事必须说清：① 普通用户看不到这个页面（而且接口会拦）；
            ② 这些数字来自云端实时统计，不是浏览器本地缓存的。 */}
        <p className="mt-6 rounded-card border border-dashed border-line px-4 py-3 text-xs leading-relaxed text-fg-subtle">
          只有管理员能看到这个页面；普通用户访问接口会返回 403。
          数据来自云端（D1 账号信息 + R2 文件统计），点右上角「刷新」获取最新用量。
        </p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- 小组件

/** 管理员徽标。用主色淡底 + 主色文字，不抢表格里用户名的主体地位。 */
function AdminBadge() {
  return (
    <span className="rounded-full bg-primary-soft px-2 py-0.5 text-xs font-medium text-primary">
      管理员
    </span>
  )
}

/** IP 单元格：空值 / "-" 统一显示破折号，IPv6 允许在任意位置换行。 */
function IpText({ ip }: { ip: string }) {
  if (ip === '' || ip === '-') {
    return <span className="text-fg-subtle">——</span>
  }
  // break-all：IPv6 可以长到 39 个字符，不强制换行会把表格撑宽
  return <span className="break-all font-mono text-xs">{ip}</span>
}

/** 一行的用量展示：已用 / 配额 + 进度条 + 文件/文件夹/分享数量。 */
function UsageCell({ user, quota }: { user: AdminUser; quota: number }) {
  const percent = usagePercent(user.usedBytes, quota)
  // 用超过 90% 变红来提示"快满了"。这里只改进度条颜色，不改文字色 ——
  // 数字本身还是普通信息，整行标红会让人以为这个账号出事了。
  const barClass = percent > 90 ? 'bg-danger' : 'bg-primary'

  return (
    <div>
      <p className="text-fg-muted">
        {formatBytes(user.usedBytes)} / {formatBytes(quota)}
        <span className="ml-2 text-xs text-fg-subtle">{percent}%</span>
      </p>
      <div
        role="progressbar"
        aria-label={`${user.username} 的云盘用量`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-surface-3"
      >
        <div className={'h-full rounded-full ' + barClass} style={{ width: `${percent}%` }} />
      </div>
      <p className="mt-1 text-xs text-fg-subtle">
        {user.fileCount} 个文件 · {user.folderCount} 个文件夹 · {user.shareCount} 条分享
      </p>
    </div>
  )
}

// ---------------------------------------------------------------- 格式化

/**
 * 已用 / 配额 → 0~100 的整数百分比。
 *
 * 为什么要夹住：宽度是行内 style 写死的百分比，后端若给出 used > quota
 * 或 quota 为 0，会算出大于 100 / Infinity，进度条直接撑出卡片。
 * 统一收进 0~100 后，再异常的数据最多也只显示"满格"。
 */
function usagePercent(used: number, quota: number): number {
  if (!Number.isFinite(quota) || quota <= 0) return 0
  const percent = (used / quota) * 100
  return Math.min(100, Math.max(0, Math.round(percent)))
}

/** 最近登录时间：null 是"从未登录"（注册后一次都没登录过），和"时间未知"要分开说。 */
function formatLastLogin(timestamp: number | null): string {
  return timestamp === null || timestamp <= 0 ? '从未登录' : formatTime(timestamp)
}
