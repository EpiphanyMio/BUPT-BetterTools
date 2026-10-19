// 「用户组管理」的数据入口：从 GET /api/admin/users 拉取所有注册用户的用量概览。
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

import { AuthError, authRequest } from './auth'
import { USER_QUOTA_BYTES } from './fileCloud'
import type { AdminUser, AdminUsersResult } from '../types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 只接受"有限数字"：NaN / Infinity / 字符串都不算，避免页面上出现 NaN 或 "0.0 B"。 */
function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 把一行原始数据解析成 AdminUser；形状不对返回 null（调用方跳过这一行）。
 *
 * 为什么必填字段缺失时整行丢弃、而不是填默认值：
 *   用户名或 id 是列表的"身份"，编不出来；硬填默认值只会让管理员看到
 *   一行根本不存在（或对应错账号）的数据，比少一行危险得多。
 *   而统计字段（用量、文件数…）缺失时填 0 是安全的 —— 页面会表现为"看起来没用过"，
 *   不会指向别的账号。
 */
function parseAdminUser(raw: unknown): AdminUser | null {
  if (!isRecord(raw)) return null

  const id = asFiniteNumber(raw.id)
  const createdAt = asFiniteNumber(raw.createdAt)
  const username = typeof raw.username === 'string' ? raw.username.trim() : ''

  if (id === null || createdAt === null || username === '') return null
  // isAdmin 必须是真正的布尔值：字符串 "false" 会被 JS 当成真值，
  // 不检查的话普通用户会被错误地打上"管理员"徽标。
  if (typeof raw.isAdmin !== 'boolean') return null

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
  }
}

/**
 * 拉取所有注册用户（含管理员自己）的网盘用量与登录信息。
 *
 * 失败（未登录 401 / 非管理员 403 / 断网）时抛 AuthError，页面用 authErrorMessage 显示。
 * quota 是"每个账号的配额"，正常情况下由后端下发；缺失或不是正数时退回
 * lib/fileCloud.ts 的 USER_QUOTA_BYTES —— 这样至少概览里的"总配额"不会变成 0 或 NaN。
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

  const users = rawUsers
    .map(parseAdminUser)
    .filter((user): user is AdminUser => user !== null)

  const rawQuota = asFiniteNumber(body.quota)
  const quota = rawQuota !== null && rawQuota > 0 ? rawQuota : USER_QUOTA_BYTES

  return { users, quota }
}
