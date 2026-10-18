// 「登录 / 注册 / 会话」的引擎：会话令牌、当前账号，以及所有需要身份的请求都从这里走。
//
// ---------------------------------------------------------------- 为什么状态放在模块顶层
//
// "现在登录的是谁"整个应用只有一份：登录门禁（App.tsx）、设置里的账号信息、
// 开发者设置里的邀请码区块，读的必须都是同一份。
// 放在模块顶层 + 订阅通知，多个组件看到的才是同一个值（和 lib/sync.ts 同一个套路），
// 界面用 useSyncExternalStore 订阅（见 hooks/useAuth.ts）。
//
// ---------------------------------------------------------------- 令牌为什么落在 localStorage
//
// 关掉标签页再打开也得是登录状态，所以只能存到浏览器里。
// 存的是服务器登录后发的一串随机数（服务端只存它的 sha256，见接口契约），不是密码 ——
// 密码一个字节都不留在浏览器里；令牌就算被偷，服务端 30 天过期也会兜底。
//
// ---------------------------------------------------------------- 为什么这些错误要抛给界面
//
// 同步（sync.ts）的原则是"失败就安静地改状态"，因为用户没在盯着它做事；
// 而登录 / 邀请码是用户点了按钮在等结果，"用户名或密码不对"必须显示在输入框旁边。
// 所以这一层的失败统一抛 AuthError，由界面决定怎么显示。
//
// ---------------------------------------------------------------- 退出登录为什么要清数据再刷新
//
// 本地那几份键（工具 / 分组 / 收藏 / 顺序 / 设置）**不分用户**，全站只有一套。
// A 退出后如果不清理，B 登录进来会先看到 A 的数据；更糟的是新用户注册后，
// 第一条云端快照会把 A 的数据推成自己的 —— 数据就串了。
// 删完直接 location.reload()：各个 Hook 的 useState 初始值只在挂载时读一次，
// 光删 localStorage 界面不会跟着变，刷新是最省事、也最不会漏的收尾。

import { APP_SETTINGS_KEY } from '../hooks/useAppSettings'
import { FAVORITES_KEY } from '../hooks/useFavorites'
import { GROUPS_KEY, TOOLS_KEY } from '../hooks/useTools'
import { ORDER_KEY } from '../hooks/useToolOrder'
import type { AuthState, AuthUser } from '../types'

// 会话令牌在浏览器里的键名。登录门禁和同步引擎都靠它判断"现在有没有身份"。
export const SESSION_KEY = 'better-tools:session'

const API_BASE = '/api'

// 用户名 / 邀请码 / 密码的规则。**必须和后端完全一致**（见接口契约）。
// 客户端先拦一道只是为了"不用等一圈网络就能看到提示"，
// 真正说了算的是服务端 —— 绕过网页直接 curl 一样能打这些接口。
const USERNAME_PATTERN = /^[A-Za-z0-9_-]{3,32}$/
const INVITE_PATTERN = /^[A-Za-z0-9-]{6,32}$/
const MIN_PASSWORD_LENGTH = 8

// 退出登录时等服务器作废会话的上限。断网不能把"退出"卡在这里。
const REVOKE_TIMEOUT_MS = 1200

// ---------------------------------------------------------------- 本机存储

// localStorage 用不了时（隐私模式会抛错）的兜底：本次打开还能用这个令牌。
// ⚠️ 必须声明在 state 之前：state 的初始值要用 getSessionToken()，
// 而 let/const 在声明前访问会抛"暂时性死区"错误。
let tokenFallback = ''

/** 读会话令牌。没登录就返回空字符串。 */
export function getSessionToken(): string {
  if (tokenFallback) return tokenFallback
  try {
    return (localStorage.getItem(SESSION_KEY) ?? '').trim()
  } catch {
    return ''
  }
}

/** 写入 / 清除令牌。传空字符串表示"忘掉这次登录"。 */
function saveSessionToken(token: string): void {
  tokenFallback = token.trim()
  try {
    if (tokenFallback) localStorage.setItem(SESSION_KEY, tokenFallback)
    else localStorage.removeItem(SESSION_KEY)
  } catch {
    // 存不进去只影响"下次打开还记不记得"，本次会话内存里的值仍然是对的
  }
}

// ---------------------------------------------------------------- 模块级状态

// 所有用 useSyncExternalStore 订阅的组件，谁订阅谁进这个集合
const listeners = new Set<() => void>()

// 缓存的状态对象。⚠️ 只在真的变化时才换成新对象（见 patchState）
//
// 初始值的写法有讲究：本地有令牌就说"正在检查"，没有就直接说"未登录"。
// 这样没登录的人第一帧就能看到登录界面，不会先闪一下"检查中"。
let state: AuthState = {
  status: getSessionToken() ? 'loading' : 'anonymous',
  user: null,
  lastError: '',
}

// 启动校验只做一次（StrictMode 会把 effect 跑两遍，靠这个标记兜住）
let started = false

/** 合并式更新状态。值都没变就保留旧对象（引用不变 → 订阅者不重渲染）。 */
function patchState(patch: Partial<AuthState>): void {
  const changed = (Object.keys(patch) as (keyof AuthState)[]).some(
    (key) => !Object.is(patch[key], state[key]),
  )
  if (!changed) return

  state = { ...state, ...patch }
  listeners.forEach((notify) => notify())
}

/** 订阅登录状态，返回取消订阅的函数。 */
export function subscribeAuth(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/**
 * 读当前状态。
 *
 * ⚠️ 返回的是缓存对象，调用方**只能读不能改**：
 * 一旦有人在外面改了字段，React 记下的"上一次快照"就跟着变了，
 * Object.is 比较会失效，界面可能莫名其妙不更新。
 */
export function getAuthState(): AuthState {
  return state
}

// ---------------------------------------------------------------- 错误

export type AuthErrorCode =
  | 'bad-request'
  | 'invalid-credentials'
  | 'invalid-invite'
  | 'username-taken'
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'network'
  | 'bad-response'
  | 'server'
  | 'unknown'

/** 认证 / 邀请码接口抛出的错误。message 永远是能直接显示的中文。 */
export class AuthError extends Error {
  code: AuthErrorCode
  status: number

  constructor(code: AuthErrorCode, message: string, status = 0) {
    super(message)
    this.name = 'AuthError'
    this.code = code
    this.status = status
  }
}

/** 把任意异常翻译成一句能显示给用户的中文。 */
export function authErrorMessage(err: unknown, fallback = '操作失败，请稍后重试'): string {
  if (err instanceof AuthError) return err.message
  if (err instanceof Error && err.message) return err.message
  return fallback
}

// ---------------------------------------------------------------- HTTP 层
//
// 只做三件事：带上门牌（Authorization）、把响应体解析出来、
// 把失败翻译成 AuthError。业务判断留在调用方。

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

async function readJsonOrNull(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    // 后端没起来时 /api 会回 index.html，读 JSON 会抛错 —— 这里当"没有响应体"
    return null
  }
}

/** 把失败响应翻译成 AuthError：优先认后端给的 error 码，其次按状态码兜底。 */
async function readAuthError(res: Response): Promise<AuthError> {
  const body = await readJsonOrNull(res)
  const code = isRecord(body) && typeof body.error === 'string' ? body.error : ''
  const serverMessage = isRecord(body) && typeof body.message === 'string' ? body.message : ''
  const status = res.status

  // 契约里的错误码，逐个翻成人话。为什么不用后端那句 message 直接显示：
  // 后端偶尔会写得比较技术，而这几句是给用户看的固定说法。
  switch (code) {
    case 'invalid-credentials':
      // 用户名不存在和密码错返回同一个码，前端也只说一句话 —— 对齐后端防用户枚举的意图
      return new AuthError('invalid-credentials', '用户名或密码不对', status)
    case 'invalid-invite':
      return new AuthError('invalid-invite', '邀请码无效，或已经被用过了', status)
    case 'username-taken':
      return new AuthError('username-taken', '这个用户名已经被注册了，换一个试试', status)
    case 'forbidden':
      return new AuthError('forbidden', '只有管理员能做这个操作', status)
    case 'unauthorized':
      return new AuthError('unauthorized', '登录已失效，请重新登录', status)
    case 'bad-request':
      return new AuthError('bad-request', serverMessage || '提交的内容不合规', status)
    default:
      break
  }

  // 没给 error 码（或者给了没见过的值）时按状态码猜。契约里 404 就是这种"光有状态码"的响应。
  if (status === 404) return new AuthError('not-found', '要操作的记录已经不存在了', status)
  if (status === 403) return new AuthError('forbidden', '只有管理员能做这个操作', status)
  if (status === 401) return new AuthError('unauthorized', '登录已失效，请重新登录', status)
  if (status >= 500) return new AuthError('server', `服务器出错了（${status}），稍后再试`, status)
  return new AuthError('unknown', serverMessage || `服务器返回 ${status}`, status)
}

/**
 * 发一个需要身份的请求，返回解析好的响应体（204 返回 null）。
 *
 * path 从 /api 后面开始写，例如 authRequest('/invites')。
 * cache: 'no-store' 很关键：这类响应一旦被浏览器缓存住，
 * 邀请码列表会一直显示旧内容、/me 的结论也可能是过期 —— 和 sync.ts 里同一个理由。
 */
export async function authRequest(path: string, init?: RequestInit): Promise<unknown> {
  const headers = new Headers(init?.headers)
  const token = getSessionToken()
  if (token) headers.set('authorization', `Bearer ${token}`)

  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, { cache: 'no-store', ...init, headers })
  } catch {
    // fetch 只在"根本没连上"时抛 TypeError（断网、域名解析失败、服务没起来）
    throw new AuthError('network', '连不上服务器，请检查网络后重试')
  }

  if (!res.ok) throw await readAuthError(res)
  if (res.status === 204) return null
  return readJsonOrNull(res)
}

// ---------------------------------------------------------------- 校验规则

/** 用户名合法性检查，返回中文提示；空串表示没问题。 */
export function validateUsername(value: string): string {
  if (value === '') return '请输入用户名'
  if (!USERNAME_PATTERN.test(value)) {
    return '用户名要 3-32 位，只能用字母、数字、下划线或短横线'
  }
  return ''
}

/** 密码合法性检查（只在校验注册时用）。 */
export function validatePassword(value: string): string {
  if (value === '') return '请输入密码'
  if (value.length < MIN_PASSWORD_LENGTH) return `密码至少 ${MIN_PASSWORD_LENGTH} 位`
  return ''
}

/** 邀请码格式检查。空串算不合法 —— 注册必须有邀请码。 */
export function validateInviteCode(value: string): string {
  if (value === '') return '请输入邀请码'
  if (!INVITE_PATTERN.test(value)) return '邀请码要 6-32 位，只能用字母、数字或短横线'
  return ''
}

// ---------------------------------------------------------------- 响应体校验
//
// 为什么要逐字段核对：这个 user 决定了界面上"管理员的邀请码区块"显不显示。
// 服务端改个字段名，或者中间出了个残缺响应，宁可当场报错，
// 也不要拿一个 isAdmin 为 undefined 的对象当"已登录的管理员"。

function readUser(raw: unknown): AuthUser | null {
  if (!isRecord(raw)) return null

  const { id, username, isAdmin } = raw
  if (typeof id !== 'number' || !Number.isFinite(id)) return null
  if (typeof username !== 'string' || username === '') return null
  if (typeof isAdmin !== 'boolean') return null

  return { id, username, isAdmin }
}

/** 采用登录 / 注册响应里的 { token, user }，并把状态切到"已登录"。 */
function adoptSession(body: unknown): AuthUser {
  if (!isRecord(body)) throw new AuthError('bad-response', '服务器返回的登录结果看不懂')

  const token = typeof body.token === 'string' ? body.token.trim() : ''
  if (token === '') throw new AuthError('bad-response', '服务器没有返回登录令牌')

  const user = readUser(body.user)
  if (!user) throw new AuthError('bad-response', '服务器返回的账号信息不完整')

  saveSessionToken(token)
  patchState({ status: 'authenticated', user, lastError: '' })
  return user
}

// ---------------------------------------------------------------- 启动校验

/**
 * 应用启动时调用一次（hooks/useAuth.ts 里触发）：本地存着令牌的话，先问服务器它还有效吗。
 *
 * 为什么不能"有令牌就当已登录"：
 *   令牌可能已经过期（30 天）、或者在别处被登出了。带着一个失效令牌进主界面，
 *   接下来每个同步请求都是 401 —— 界面显示"已登录"却什么都存不上去，反而更难懂。
 */
export function ensureAuthStarted(): void {
  if (started) return
  started = true

  if (!getSessionToken()) {
    // 没令牌：同步地把状态定成匿名，界面第一帧就画登录页，不闪"检查中"
    patchState({ status: 'anonymous', user: null })
    return
  }
  void verifySession()
}

async function verifySession(): Promise<void> {
  try {
    const body = await authRequest('/auth/me')
    const user = isRecord(body) ? readUser(body.user) : null
    if (!user) throw new AuthError('bad-response', '服务器返回的账号信息不完整')

    patchState({ status: 'authenticated', user, lastError: '' })
  } catch (err) {
    if (err instanceof AuthError && err.code === 'unauthorized') {
      // 令牌过期 / 已在别处退出：连本地那份数据一起清掉，再回到未登录。
      // 为什么连数据也清：下一个登录的可能是新用户，
      // 留着上一个人的数据，他注册成功后就会把它当自己的第一份快照推上云。
      forgetSession('登录已失效，请重新登录')
      return
    }

    // 连不上服务器时**保留令牌**（也许只是断网），但不能假装已登录 ——
    // 没经过服务器确认的 isAdmin 不该用来决定要不要显示管理员功能。
    patchState({
      status: 'anonymous',
      user: null,
      lastError: authErrorMessage(err, '无法确认登录状态，请检查网络后重试'),
    })
  }
}

// ---------------------------------------------------------------- 登录 / 注册

/**
 * 登录。成功时状态会变成 authenticated（界面随之重渲染），失败抛 AuthError。
 *
 * 为什么 username 要 trim：手机键盘和复制粘贴经常带首尾空格，
 * 而用户名里不允许空格，带着空格去查只会得到"用户名或密码不对"，白费一次尝试。
 */
export async function login(username: string, password: string): Promise<AuthUser> {
  const name = username.trim()
  // 登录时只拦"空"，不复用注册那套格式规则：
  // 格式规则将来一改，老账号就再也登不进来了 —— 登录能不能过，交给服务器判断。
  if (name === '') throw new AuthError('bad-request', '请输入用户名')
  if (password === '') throw new AuthError('bad-request', '请输入密码')

  const body = await authRequest('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: name, password }),
  })
  return adoptSession(body)
}

/** 注册（需要邀请码）。成功时同样是"直接登录"，状态变成 authenticated。 */
export async function register(
  username: string,
  password: string,
  inviteCode: string,
): Promise<AuthUser> {
  const name = username.trim()
  const code = inviteCode.trim()

  const nameProblem = validateUsername(name)
  if (nameProblem) throw new AuthError('bad-request', nameProblem)
  const passwordProblem = validatePassword(password)
  if (passwordProblem) throw new AuthError('bad-request', passwordProblem)
  const inviteProblem = validateInviteCode(code)
  if (inviteProblem) throw new AuthError('bad-request', inviteProblem)

  const body = await authRequest('/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: name, password, inviteCode: code }),
  })
  return adoptSession(body)
}

// ---------------------------------------------------------------- 退出登录

/** 退出登录要清掉的业务数据键。它们不分用户，全站只有一套。 */
const ACCOUNT_KEYS = [TOOLS_KEY, GROUPS_KEY, FAVORITES_KEY, ORDER_KEY, APP_SETTINGS_KEY]

// 同步引擎的三个键也要清：
//   sync-revision / sync-dirty 记的是"上一个人在云端的版本号和待推改动"，
//   留着会让下一个登录的人拿错的 baseRevision 去推，甚至把人家云端的数据覆盖掉；
//   sync-token 是旧版共享令牌时代留下的，早就没用了。
const SYNC_KEYS = [
  'better-tools:sync-revision',
  'better-tools:sync-dirty',
  'better-tools:sync-token',
]

/**
 * 清空这台浏览器里属于"某个用户"的数据。
 *
 * 只删键名写死在这里的这几项，不做"删掉 better-tools: 开头的全部" ——
 * 主题（better-tools:theme）是这台设备自己的显示偏好，不该跟着账号走；
 * seed-version 是"默认清单补到第几版"的标记，也不属于某个用户。
 */
export function clearLocalAccountData(): void {
  for (const key of [...ACCOUNT_KEYS, ...SYNC_KEYS]) {
    try {
      localStorage.removeItem(key)
    } catch {
      // 隐私模式下删不掉也没关系：令牌已经清空，刷新后是登录界面
    }
  }
}

/** 忘掉这次登录：清令牌 + 清本地数据 + 回到未登录。 */
function forgetSession(reason = ''): void {
  saveSessionToken('')
  clearLocalAccountData()
  patchState({ status: 'anonymous', user: null, lastError: reason })
}

/** 等一会儿（给"退出登录时等服务器作废会话"用）。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 通知服务器作废这条会话。失败无所谓，本地照样退出。 */
async function revokeSession(): Promise<void> {
  try {
    await authRequest('/auth/logout', { method: 'POST' })
  } catch {
    // 断网 / 服务器出错都不该挡住退出：令牌马上就从浏览器里删掉了
  }
}

/**
 * 退出登录：作废会话 → 清本地数据 → 刷新回登录界面。
 *
 * 为什么"等服务器"要设上限：断网时这个请求会一直挂着，
 * 而用户点了"退出登录"就期待立刻回到登录页。最多等 1.2 秒，等不到就先走
 * （服务端那条会话会自己按 30 天过期，浏览器里的令牌已经删了，别人也用不上）。
 *
 * 为什么要 reload 而不是在内存里改状态：所有数据 Hook 的 useState 初始值
 * 只在挂载时读一次。删掉 localStorage 之后必须让它们重新走一遍初始化，
 * 否则界面上还挂着一份"已经是 A 的数据"的旧 state。刷新最省事，也不会漏。
 */
export async function logout(): Promise<void> {
  await Promise.race([revokeSession(), delay(REVOKE_TIMEOUT_MS)])
  forgetSession()
  window.location.reload()
}
