// 「用户组管理」的数据入口：拉取所有注册用户的用量概览，以及修改单个账号的存储配额。
//
// ---------------------------------------------------------------- 为什么校验放在这一层
//
// 这份数据是管理员用来判断"谁占满了云盘、谁最近在哪儿登录"的。
// 数字或用户名一旦是脏的，管理员会据此做出错误判断（比如误以为某个账号没在用）。
// 而现在的数据链路上有三个不受这个文件控制的地方：
//   ① 后端并行开发时，契约可能还没对齐（字段改名、忘了返回 quota）；
//   ② 中间层（代理、Worker 的兜底页）可能返回一段结构不对的 JSON；
//   ③ 以后别的客户端写进 D1 的数据，也可能缺字段。
// 如果把这些检查塞进页面，渲染逻辑会被一堆 if 淹没；
// 所以这里统一做"形状校验"：**坏行跳过，好的照常显示**，不让一条脏数据废掉整页。
// 这和 lib/fileCloud.ts、components/InviteAdmin.tsx 的处理方针保持一致。
//
// 鉴权走 lib/auth.ts 的 authRequest：它会自动带上 Bearer 令牌，
// 并把 401 / 403 / 断网翻译成带中文说明的 AuthError，页面直接显示即可。
// 注意 isAdmin 只用来决定"显示什么"，真正的权限由服务端 403 兜底 ——
// 非管理员就算绕过界面直接调这个接口，也拿不到数据。
//
// ---------------------------------------------------------------- 为什么配额以字节传输、界面用 MB 输入
//
// 接口契约里 quota 一律是**整数字节**，而输入框用 MB，这是两件不同的事：
//   · 字节是存储层唯一真实的单位：R2 计费、文件大小、用量统计都按字节，
//     接口只传一个数，不传"这个数是 MB 还是 GB"，就不存在单位歧义；
//   · MB 只是给人读的：10240 比 10737418240 好敲、好核对。MB 换算放在界面里做，
//     后端只认字节，这样以后有人想用 GB 展示也不用改接口；
//   · 为什么用 1024 进制（1 MB = 1048576 字节）：和 formatBytes 的展示、
//     浏览器里文件大小的习惯一致，避免同一个 500 MB 在页面上显示成 476.8 MB 这种别扭数字。
// 所以这个文件只负责收发字节，取整/换算 MB 是 UserAdminModule.tsx 的事。

import { AuthError, authRequest } from './auth'
import { USER_QUOTA_BYTES } from './fileCloud'
import type { AdminUser, AdminUsersResult } from '../types'

// 后端没下发默认配额时的兜底。500 MB 是契约里的默认值，与 fileCloud 的
// USER_QUOTA_BYTES 保持同一份来源，免得两处各写一个数、将来只改了一处。
const DEFAULT_USER_QUOTA_BYTES = USER_QUOTA_BYTES

// 全站总配额兜底（10 GB，R2 免费额度）。
// 为什么不放进 fileCloud.ts：这个值前端只用来"展示 + 输入框上限"，
// 真正拦截上传的是 Worker；放在这里能明确它只是"响应缺字段时的兜底"，
// 不会让人误以为前端也在做配额拦截。
const SITE_QUOTA_BYTES = 10 * 1024 * 1024 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 只接受"有限数字"：NaN / Infinity / 字符串都不算，避免页面上出现 NaN 或 "0.0 B"。 */
function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 读一个"必须是正数"的配额字段，坏了就用兜底值。 */
function positiveQuota(value: unknown, fallback: number): number {
  const parsed = asFiniteNumber(value)
  return parsed !== null && parsed > 0 ? parsed : fallback
}

/**
 * 把一行原始数据解析成 AdminUser；形状不对返回 null（调用方跳过这一行）。
 *
 * 为什么必填字段缺失时整行丢弃、而不是填默认值：
 *   用户名或 id 是列表的"身份"，编不出来；硬填默认值只会让管理员看到
 *   一行根本不存在（或对应错账号）的数据，比少一行危险得多。
 *   而统计字段（用量、文件数…）缺失时填 0 是安全的 —— 页面会表现为"看起来没用过"，
 *   不会指向别的账号。
 *
 * defaultQuota 必须由调用方先解析好再传进来：它是每一行 quota 的兜底值。
 * 如果先解析用户、后解析默认配额，缺 quota 的行就只能填 0，
 * 页面上会出现"这个人配额 0 B"这种明显错误的信息。
 */
function parseAdminUser(raw: unknown, defaultQuota: number): AdminUser | null {
  if (!isRecord(raw)) return null

  const id = asFiniteNumber(raw.id)
  const createdAt = asFiniteNumber(raw.createdAt)
  const username = typeof raw.username === 'string' ? raw.username.trim() : ''

  if (id === null || createdAt === null || username === '') return null
  // isAdmin 必须是真正的布尔值：字符串 "false" 会被 JS 当成真值，
  // 不检查的话普通用户会被错误地打上"管理员"徽标。
  if (typeof raw.isAdmin !== 'boolean') return null

  // quota 允许是 0（管理员可以把某个账号的空间清零），
  // 所以这里不能用"正数"判断，非负即可；缺失 / 负数 / 非数字才退回默认配额。
  const rawQuota = asFiniteNumber(raw.quota)

  return {
    id,
    username,
    isAdmin: raw.isAdmin,
    createdAt,
    // 最近登录时间允许为空（从没登录过），读不出来就按"从未登录"处理
    lastLoginAt: asFiniteNumber(raw.lastLoginAt),
    lastLoginIp: typeof raw.lastLoginIp === 'string' ? raw.lastLoginIp.trim() : '',
    usedBytes: asFiniteNumber(raw.usedBytes) ?? 0,
    fileCount: asFiniteNumber(raw.fileCount) ?? 0,
    folderCount: asFiniteNumber(raw.folderCount) ?? 0,
    shareCount: asFiniteNumber(raw.shareCount) ?? 0,
    quota: rawQuota !== null && rawQuota >= 0 ? rawQuota : defaultQuota,
  }
}

/**
 * 拉取所有注册用户（含管理员自己）的网盘用量与登录信息。
 *
 * 失败（未登录 401 / 非管理员 403 / 断网）时抛 AuthError，页面用 authErrorMessage 显示。
 * 三个配额字段（defaultQuota / siteQuota / 每行 quota）都可能因为后端旧版本而缺失，
 * 缺失时分别退回 500 MB / 10 GB / 默认配额 —— 这样概览里的总配额和进度条
 * 不会变成 0、NaN，也不会让管理员以为"全站一点空间都没有"。
 */
export async function fetchAdminUsers(): Promise<AdminUsersResult> {
  const body = await authRequest('/admin/users')

  // 整份响应连对象都不是（例如后端没起来、/api 回了 index.html），
  // 没法逐行恢复，只能当作一次失败让页面显示错误 + 重试，而不是假装"没有用户"。
  if (!isRecord(body)) {
    throw new AuthError('bad-response', '服务器返回的用户列表看不懂，请刷新重试')
  }

  // 把 rawUsers 抽成变量再判断类型：直接写 Array.isArray(body.users) 不会把
  // body.users 的类型收窄成 unknown[]，下面的 map 在 strict 模式下会报错。
  const rawUsers = body.users
  if (!Array.isArray(rawUsers)) {
    throw new AuthError('bad-response', '服务器返回的用户列表格式不对，请刷新重试')
  }

  // ⚠️ 顺序很重要：先解析 siteQuota / defaultQuota，再解析用户行 ——
  // 每行的 quota 缺失时要用 defaultQuota 兜底。
  const defaultQuota = positiveQuota(body.defaultQuota, DEFAULT_USER_QUOTA_BYTES)
  const siteQuota = positiveQuota(body.siteQuota, SITE_QUOTA_BYTES)

  const users = rawUsers
    .map((raw) => parseAdminUser(raw, defaultQuota))
    .filter((user): user is AdminUser => user !== null)

  return { users, defaultQuota, siteQuota }
}

/**
 * 修改某个账号的存储配额。quota 单位是**字节**（整数），返回服务端确认后的值。
 *
 * 为什么要把服务端确认值返回给页面、而不是让页面直接相信用户输入：
 *   服务端可能做上限夹取或修正（比如全站池子调小之后）。页面拿确认值回写列表，
 *   显示的数字才和真正生效的一致，不会出现"界面上写着 8 GB、实际只批了 6 GB"。
 */
export async function updateUserQuota(userId: number, quota: number): Promise<number> {
  // 契约要求整数字节；这里先拦一道，免得把一个小数发给后端换回一个 400，
  // 白白多一次网络往返（真正说了算的仍然是服务端）。
  if (!Number.isInteger(quota) || quota < 0) {
    throw new AuthError('bad-request', '配额必须是不小于 0 的整数字节数')
  }

  const body = await authRequest(`/admin/users/${userId}/quota`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quota }),
  })

  // 2xx 但响应体不是 { userId, quota } 时不能当作成功：
  // 页面要拿这个 quota 回写列表，读不到就说明这次修改的结果不可信。
  if (!isRecord(body)) {
    throw new AuthError('bad-response', '服务器没有返回配额确认，请刷新后重试')
  }
  const confirmedUserId = asFiniteNumber(body.userId)
  const confirmedQuota = asFiniteNumber(body.quota)
  if (confirmedUserId === null || confirmedQuota === null || confirmedQuota < 0) {
    throw new AuthError('bad-response', '服务器返回的配额确认格式不对，请刷新后重试')
  }

  return confirmedQuota
}

/**
 * 把某个账号的配额恢复成默认值（DELETE，服务端回 204）。
 *
 * 为什么"恢复默认"不直接调 updateUserQuota(userId, defaultQuota)：
 *   默认配额将来可能调整（比如从 500 MB 改成 1 GB）。走 DELETE 让服务端
 *   自己决定"默认是多少"，前端不用跟着改；而且行上也能区分"显式设成 500 MB"
 *   和"没有单独设置、跟随默认"这两种状态。
 */
export async function resetUserQuota(userId: number): Promise<void> {
  await authRequest(`/admin/users/${userId}/quota`, { method: 'DELETE' })
}
