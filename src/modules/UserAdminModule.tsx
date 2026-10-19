// 用户组管理：管理员查看所有注册用户的网盘用量、最近登录时间和 IP，
// 并在「开发者设置」里给每个账号单独分配存储配额。
//
// 页面骨架照 ToolboxModule / FilesModule：顶部标题 + 返回 + 全局搜索，
// 内容区 max-w-5xl、bg-surface-2 打底，这样从首页点进来时视觉上是连续的。
//
// ---------------------------------------------------------------- 数据从哪来
//
// 只调 lib/userAdmin.ts 的 fetchAdminUsers() / updateUserQuota() / resetUserQuota()，
// 不在组件里直接 fetch：鉴权头、401/403/404 的翻译、响应体校验都在那一层做完了。
// 页面只负责四件事：加载中 / 出错 / 有数据 / 把用户输入换算成字节再提交。
//
// ---------------------------------------------------------------- 权限说明（很重要）
//
// 这里的 isAdmin 判断只决定"入口和页面显不显示"，不是安全边界。
// 真正的安全在服务端：GET /api/admin/users 对未登录回 401、对普通用户回 403；
// PUT/DELETE /api/admin/users/{id}/quota 同理，参数不对回 400、账号不存在回 404。
// 所以就算有人绕过界面直接调接口，也改不了任何人的配额、拿不到任何人的数据。
// 页面底部那句提示就是把这个事实讲给管理员听，免得误以为前端藏起来就等于安全。
//
// ---------------------------------------------------------------- 配额为什么用 MB 输入
//
// 契约里 quota 是字节，但让管理员填 10737418240 既不直观也容易多数/少数一位。
// 这里统一用 MB 作输入单位（1 MB = 1024 × 1024 字节）：页面上显示、校验都在 MB，
// 只有真正发请求时才 × 1048576 换成字节。换算集中在这一处，别的地方不再做单位转换。

import { useCallback, useEffect, useMemo, useState } from 'react'
import { authErrorMessage } from '../lib/auth'
import { formatBytes, formatTime } from '../lib/fileUtils'
import { fetchAdminUsers, resetUserQuota, updateUserQuota } from '../lib/userAdmin'
import { useAuth } from '../hooks/useAuth'
import type { AdminUser } from '../types'

// MB 与字节的换算系数。写成常量而不是到处写 1048576：
// 一旦有人手滑少写一位，全页面所有配额会一起错，集中一处更好核对。
const BYTES_PER_MB = 1024 * 1024

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
  // 两个站点级配额都由后端下发；lib/userAdmin.ts 已经为缺失字段做了兜底。
  // 分开存而不是合成一个对象，是为了让下面的概览和输入框上限各取所需、互不牵连。
  const [defaultQuota, setDefaultQuota] = useState(0)
  const [siteQuota, setSiteQuota] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')

  // ---- 开发者设置的本地状态 ----
  //
  // 输入框草稿单独放在 quotaInputs，而不是直接改 users：
  //   管理员在输入框里打字时，数字还不是"已生效的配额"。直接写回 users 会让
  //   概览里的"已分配合计"、主表格的用量条在打字过程中不停变化，看起来像已经保存了，
  //   而且这时候刷新一次列表还会把半截输入冲掉。草稿和已生效数据分开最不容易出错。
  // 键用 user.id 而不是用户名：用户名将来可能允许改名，id 是稳定的。
  const [quotaInputs, setQuotaInputs] = useState<Record<number, string>>({})
  // 正在保存/重置的用户 id；null 表示空闲。
  // 用单个 id 而不是每条一个 boolean，是因为需求要求"同一时间只允许一个保存操作"
  // （两个请求并发回来时，后到的响应可能用旧数据覆盖新数据）。
  const [busyUserId, setBusyUserId] = useState<number | null>(null)
  // 逐行的错误与成功反馈。放在行内而不是只放顶部，是因为管理员可能一次改多行，
  // 必须一眼看出"是哪个账号失败了"，否则只能对着一句"操作失败"猜。
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({})
  const [rowNotices, setRowNotices] = useState<Record<number, string>>({})

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await fetchAdminUsers()
      setUsers(result.users)
      setDefaultQuota(result.defaultQuota)
      setSiteQuota(result.siteQuota)
      // 刷新后输入框回到服务端的最新值：旧的草稿可能对应已经过期的配额，
      // 留着它再点保存会用旧值把刚改好的设置覆盖回去。
      setQuotaInputs(quotaInputsFromUsers(result.users))
      setRowErrors({})
      setRowNotices({})
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

  // 概览里的三个总数都按"全部用户"算（不受搜索框影响）：
  // 这个页面第一眼要回答的是"整个站点用了多少、还能装多少"，
  // 而不是"筛出来的这几个人用了多少"。搜索只影响下面的列表和开发者设置行。
  const totalUsed = useMemo(
    () => users.reduce((sum, user) => sum + user.usedBytes, 0),
    [users],
  )
  const totalAssigned = useMemo(
    () => users.reduce((sum, user) => sum + user.quota, 0),
    [users],
  )
  // 全站池子是按 siteQuota 算的：已分配额度之和可能超过它（管理员把每个人的额度都调大），
  // 但真正会触发拒绝的是"实际用量"到达 siteQuota，所以两个数字要分开显示、分开判断。
  const assignedOverSite = totalAssigned > siteQuota

  // 输入框允许的最大 MB。siteQuota 不一定是整 MB，向下取整保证 "MB × 1048576" 不会超上限。
  const maxQuotaMb = siteQuota > 0 ? Math.floor(siteQuota / BYTES_PER_MB) : 0

  /** 清掉某一行的错误与成功反馈（用户重新输入 / 开始下一次操作时调用）。 */
  const clearRowFeedback = (userId: number) => {
    setRowErrors((prev) => withoutKey(prev, userId))
    setRowNotices((prev) => withoutKey(prev, userId))
  }

  /** 输入框内容变化：只改草稿，不碰 users —— 点「保存」之前列表里的配额保持不变。 */
  const handleQuotaInputChange = (userId: number, value: string) => {
    setQuotaInputs((prev) => ({ ...prev, [userId]: value }))
    clearRowFeedback(userId)
  }

  /** 校验输入框里的 MB 数，返回中文错误；空串表示合法。 */
  const validateQuotaInput = (raw: string): string => {
    const text = raw.trim()
    if (text === '') return '请输入配额（MB）'
    const mb = Number(text)
    if (!Number.isFinite(mb) || !Number.isInteger(mb)) return '配额必须是整数（MB）'
    if (mb < 0) return '配额不能小于 0 MB'
    if (mb > maxQuotaMb) return `不能超过 ${maxQuotaMb} MB（全站总配额）`
    return ''
  }

  /** 保存某一行的配额：校验 → 转成字节发 PUT → 用服务端确认值就地回写列表。 */
  const handleSaveQuota = async (user: AdminUser) => {
    // 额外兜一层：按钮已经禁用，但键盘回车 / 连点理论上仍可能触发两次。
    if (busyUserId !== null) return

    const raw = quotaInputs[user.id] ?? ''
    const problem = validateQuotaInput(raw)
    if (problem !== '') {
      setRowErrors((prev) => ({ ...prev, [user.id]: problem }))
      setRowNotices((prev) => withoutKey(prev, user.id))
      return
    }

    const quota = Number(raw.trim()) * BYTES_PER_MB
    setBusyUserId(user.id)
    clearRowFeedback(user.id)
    try {
      const confirmed = await updateUserQuota(user.id, quota)
      // 用服务端确认的 quota 回写（而不是本地输入值）：服务端可能做了夹取，
      // 页面显示的数字必须和真正生效的一致。map 保持原数组顺序，列表不会跳行。
      setUsers((prev) =>
        prev.map((item) => (item.id === user.id ? { ...item, quota: confirmed } : item)),
      )
      setQuotaInputs((prev) => ({ ...prev, [user.id]: String(Math.round(confirmed / BYTES_PER_MB)) }))
      setRowNotices((prev) => ({ ...prev, [user.id]: '已保存' }))
    } catch (err) {
      // 401 / 403 / 404 / 断网都会在这里变成中文；留在该行显示，看得出是哪个账号失败。
      setRowErrors((prev) => ({ ...prev, [user.id]: authErrorMessage(err) }))
    } finally {
      setBusyUserId(null)
    }
  }

  /** 恢复默认配额：DELETE 让服务端决定默认值，成功后行内配额改为页面已知的 defaultQuota。 */
  const handleResetQuota = async (user: AdminUser) => {
    if (busyUserId !== null) return

    setBusyUserId(user.id)
    clearRowFeedback(user.id)
    try {
      await resetUserQuota(user.id)
      setUsers((prev) =>
        prev.map((item) =>
          item.id === user.id ? { ...item, quota: defaultQuota } : item,
        ),
      )
      setQuotaInputs((prev) => ({
        ...prev,
        [user.id]: String(Math.round(defaultQuota / BYTES_PER_MB)),
      }))
      setRowNotices((prev) => ({ ...prev, [user.id]: '已恢复默认' }))
    } catch (err) {
      setRowErrors((prev) => ({ ...prev, [user.id]: authErrorMessage(err) }))
    } finally {
      setBusyUserId(null)
    }
  }

  // 保存 / 重置期间（以及刷新列表期间）禁用所有配额操作按钮：
  // 一次只让一个写请求在飞，避免两个响应互相覆盖成"看起来保存了、其实没保存"。
  const quotaControlsDisabled = busyUserId !== null || loading

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
                不能逼他刷新整页。加载中或正在保存时禁用，避免请求互相打架。 */}
            <button
              type="button"
              onClick={() => void load()}
              disabled={quotaControlsDisabled}
              className="btn btn-primary"
            >
              {loading ? '刷新中…' : '刷新'}
            </button>
          </div>
        </header>

        {/* ---- 概览：全站视角 ----
            管理员真正关心的是"全站池子用了多少、还剩多少"，所以第一行先给已用 / 总配额，
            再把"已分配额度合计"和"默认配额"作为佐证放在下面：
            已分配是管理员自己设的额度之和，跟实际用量不是一回事，两个都看才判断得准。 */}
        <section className="card mb-4 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <p className="text-sm text-fg-muted">
              注册用户 <span className="font-medium text-fg">{users.length}</span> 位 · 全站已用{' '}
              <span className="font-medium text-fg">{formatBytes(totalUsed)}</span> /{' '}
              <span className="font-medium text-fg">{formatBytes(siteQuota)}</span>
            </p>
            <span className="text-xs text-fg-subtle">
              {usagePercent(totalUsed, siteQuota)}%
            </span>
          </div>
          <div
            role="progressbar"
            aria-label="全站云盘总用量"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={usagePercent(totalUsed, siteQuota)}
            className="mt-2 h-2 w-full overflow-hidden rounded-full bg-surface-3"
          >
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${usagePercent(totalUsed, siteQuota)}%` }}
            />
          </div>

          <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-fg-subtle">全站总配额</dt>
              <dd className="mt-0.5 font-medium text-fg">{formatBytes(siteQuota)}</dd>
              <dd className="text-xs text-fg-subtle">R2 免费额度，超出会计费</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-subtle">已分配配额合计</dt>
              <dd
                className={
                  'mt-0.5 font-medium ' + (assignedOverSite ? 'text-warn' : 'text-fg')
                }
              >
                {formatBytes(totalAssigned)}
              </dd>
              <dd className="text-xs text-fg-subtle">所有账号额度之和</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-subtle">默认配额</dt>
              <dd className="mt-0.5 font-medium text-fg">{formatBytes(defaultQuota)}</dd>
              <dd className="text-xs text-fg-subtle">未单独设置的账号使用它</dd>
            </div>
          </dl>

          {/* 已分配额度之和超过全站池子本身不产生费用（空着就是空着），
              但说明额度分配超过了池子能装下的总量，需要管理员自己再调小。
              单独用一行提示而不是只把数字标黄，是为了把"为什么"讲清楚。 */}
          {assignedOverSite && (
            <p className="mt-3 rounded-btn bg-warn-bg px-3 py-2 text-xs leading-relaxed text-warn">
              已分配配额合计（{formatBytes(totalAssigned)}）超过全站总配额（
              {formatBytes(siteQuota)}）。实际云盘用量仍受 {formatBytes(siteQuota)}{' '}
              硬上限保护，超出部分的上传会被服务端拒绝；但额度之和超过了池子，建议调小部分账号。
            </p>
          )}
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
            <button
              type="button"
              onClick={() => void load()}
              disabled={quotaControlsDisabled}
              className="btn btn-text btn-sm"
            >
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
                        {/* 每个账号的配额可能不同，所以只传 user，让组件内部读 user.quota */}
                        <UsageCell user={user} />
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
                    <UsageCell user={user} />
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

        {/* ---- 开发者设置：逐账号配额 ----
            放在主列表之后、底部说明之前：管理员先看清"谁用了多少"，再决定给谁调额度，
            顺序和实际操作流程一致。用 card 而不是 modal，是希望调配额时还能对照上面的用量。
            只用 visibleUsers，和顶部搜索框共用关键字 —— 用户多了以后不用在一长串里找。 */}
        {users.length > 0 && visibleUsers.length > 0 && (
          <section
            aria-labelledby="dev-quota-title"
            className="card mt-4 p-4 sm:p-5"
          >
            <h2 id="dev-quota-title" className="text-lg font-medium text-fg">
              🛠 开发者设置 · 存储配额
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-fg-subtle">
              只有管理员能修改配额；单位 MB，范围 0–{maxQuotaMb} MB；不单独设置就使用默认的{' '}
              {formatBytes(defaultQuota)}。全站实际用量的硬上限是 {formatBytes(siteQuota)}
              （R2 免费额度，超出会计费），所有账号加起来也超不过它。
            </p>

            <ul className="mt-2 divide-y divide-line-soft">
                {visibleUsers.map((user) => {
                  const saving = busyUserId === user.id
                  // 当前额度已经等于默认额度时，"恢复默认"不会有任何变化，直接禁用。
                  const canReset = user.quota !== defaultQuota
                  const rowError = rowErrors[user.id] ?? ''
                  const rowNotice = rowNotices[user.id] ?? ''

                  return (
                    <li
                      key={user.id}
                      className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                    >
                      {/* 左半：身份 + 已用 + 当前生效配额 */}
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-fg">{user.username}</span>
                          {user.isAdmin && <AdminBadge />}
                        </div>
                        <p className="mt-0.5 text-xs text-fg-subtle">
                          已用 {formatBytes(user.usedBytes)} · 当前配额{' '}
                          {formatBytes(user.quota)}
                        </p>
                      </div>

                      {/* 右半：输入框 + 两个按钮。窄屏整块落到下一行（flex-col），
                          按钮行用 flex-wrap，极窄的屏幕也只会换行、不会横向溢出。 */}
                      <div className="flex flex-col gap-2 sm:items-end">
                        <div className="flex flex-wrap items-center gap-2">
                          <label className="flex items-center gap-2 text-xs text-fg-muted">
                            <span className="whitespace-nowrap">配额</span>
                            <input
                              type="number"
                              inputMode="numeric"
                              min={0}
                              max={maxQuotaMb}
                              step={1}
                              value={quotaInputs[user.id] ?? ''}
                              onChange={(event) =>
                                handleQuotaInputChange(user.id, event.target.value)
                              }
                              disabled={saving || loading}
                              // aria-label 带用户名：读屏器 / 自动化测试在只有输入框时
                              // 也能知道这一格属于哪个账号。
                              aria-label={`${user.username} 的配额（MB）`}
                              className="field field-boxed w-24 text-right"
                            />
                            <span className="text-fg-subtle">MB</span>
                          </label>

                          <button
                            type="button"
                            onClick={() => void handleSaveQuota(user)}
                            disabled={quotaControlsDisabled}
                            className="btn btn-primary btn-sm"
                          >
                            {saving ? '保存中…' : '保存'}
                          </button>

                          <button
                            type="button"
                            onClick={() => void handleResetQuota(user)}
                            disabled={quotaControlsDisabled || !canReset}
                            className="btn btn-neutral btn-sm"
                          >
                            恢复默认
                          </button>
                        </div>

                        {/* 行内反馈：失败用 danger + role=alert，成功用 success + role=status。
                            文案里已经带了服务端给的中文原因，不用再写一遍"失败"。 */}
                        {(rowError !== '' || rowNotice !== '') && (
                          <p
                            role={rowError !== '' ? 'alert' : 'status'}
                            className={
                              'text-xs ' + (rowError !== '' ? 'text-danger' : 'text-success')
                            }
                          >
                            {rowError !== '' ? rowError : rowNotice}
                          </p>
                        )}
                      </div>
                    </li>
                  )
                })}
            </ul>
          </section>
        )}

        {/* ---- 权限与数据来源说明 ----
            三件事必须说清：① 普通用户看不到这个页面、也改不了配额（接口会拦）；
            ② 全站 10 GB 是 R2 免费额度，超出会产生费用；③ 这些数字来自云端实时统计。 */}
        <p className="mt-6 rounded-card border border-dashed border-line px-4 py-3 text-xs leading-relaxed text-fg-subtle">
          只有管理员能看到这个页面、修改存储配额；普通用户访问接口会返回 403，
          只能在自己的首页看到「我的网盘用量」。全站总配额 {formatBytes(siteQuota)}
          是 Cloudflare R2 的免费额度，超出会计费 —— 调大某个账号的配额不会让全站池子变大，
          超量的上传会被服务端拒绝。数据来自云端（D1 账号信息 + R2 文件统计），
          点右上角「刷新」获取最新用量。
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

/**
 * 一行的用量展示：已用 / 该账号自己的配额 + 进度条 + 文件/文件夹/分享数量。
 *
 * 为什么只接收 user、不在外面传一个统一 quota：现在每个账号的额度可以不同，
 * 外面传值很容易在某处漏改、把别人的额度显示到这一行上。数据只从 user 读，
 * "这一行的配额"就永远只可能是这个账号的。
 */
function UsageCell({ user }: { user: AdminUser }) {
  const percent = usagePercent(user.usedBytes, user.quota)
  // 已用超过配额时整行标红并写「已超额」——这是管理员最该先看到的一类账号。
  // 没超额但已经用了 90% 以上，也让进度条提前变红，作为"快满了"的预警。
  const overQuota = user.usedBytes > user.quota
  const barClass = overQuota || percent > 90 ? 'bg-danger' : 'bg-primary'

  return (
    <div>
      <p className={overQuota ? 'text-danger' : 'text-fg-muted'}>
        {formatBytes(user.usedBytes)} / {formatBytes(user.quota)}
        <span className="ml-2 text-xs text-fg-subtle">{percent}%</span>
        {overQuota && <span className="ml-2 text-xs font-medium">已超额</span>}
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

// ---------------------------------------------------------------- 格式化 / 小工具

/** 把用户列表变成输入框草稿：按 MB 取整显示，而不是把字节数原样塞进输入框。 */
function quotaInputsFromUsers(users: AdminUser[]): Record<number, string> {
  const inputs: Record<number, string> = {}
  for (const user of users) {
    inputs[user.id] = String(Math.round(user.quota / BYTES_PER_MB))
  }
  return inputs
}

/** 从 Record 里删掉一个键；键本来就不存在时原样返回，避免制造无意义的新对象。 */
function withoutKey<T>(record: Record<number, T>, key: number): Record<number, T> {
  if (!(key in record)) return record
  const next = { ...record }
  delete next[key]
  return next
}

/**
 * 已用 / 配额 → 0~100 的整数百分比。
 *
 * 为什么要夹住：宽度是行内 style 写死的百分比，后端若给出 used > quota
 * 或 quota 为 0，会算出大于 100 / Infinity，进度条直接撑出卡片。
 * 统一收进 0~100 后，再异常的数据最多也只显示"满格"；
 * 真正"超额了"这件事由文字「已超额」和红色表达，不靠进度条突破 100%。
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
