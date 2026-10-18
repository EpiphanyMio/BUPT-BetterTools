// 「云端同步」客户端：把本地数据同步到 /api/snapshot（后端由另一位同事实现）。
//
// ---------------------------------------------------------------- 鉴权：跟着账号会话走
//
// 以前每个请求带的是"共享令牌"（Cloudflare 上的 SYNC_TOKEN 环境变量）——
// 谁拿到那串字符，就能读写这个站的全部数据。
// 现在带的是**登录后拿到的会话令牌**（Authorization: Bearer <token>），
// 服务端据此找出它对应的那份快照：不同账号各存一份，互相看不见。
//
// 令牌本身不归这个文件管：读写都在 src/lib/auth.ts，这里只调 getSessionToken()。
// 没有令牌（没登录）时状态机停在 unauthenticated，一个请求都不发。
//
// ---------------------------------------------------------------- 策略：版本号 + 谁新听谁
//
// 云端只存**一整份**数据，每写一次 revision 加 1。每台设备记住"我上次看到的是第几版"：
//   云端 revision 更大 → 云端更新，拉下来覆盖本地；
//   否则               → 本地更新，把我的这份推上去。
//
// 为什么不做字段级合并（比如"工具按 id 取并集"）：
//   合并规则会越写越长 —— 一边删一边改算谁的？两边同名不同网址怎么办？
//   而且合并一旦出错是**静默**的：两边数据被揉在一起，用户根本不知道从哪一步开始错的。
//   一个版本号 + 明确的"谁赢"，代码少、行为可预测。代价是极端情况下丢一次改动，
//   这是 last-write-wins 的固有代价，接受它。
//
// ---------------------------------------------------------------- 为什么状态放在模块顶层
//
// "同步状态"是整个应用唯一的一份：顶栏的小圆点、设置面板里的按钮读的都是它。
// 放在模块顶层 + 订阅通知，多个组件看到的才是同一个值；
// 各组件自己 useState 的话，就会出现"一处显示已同步、另一处显示同步中"的错位。
// 界面用 useSyncExternalStore 订阅（见 src/hooks/useSync.ts）。
//
// ---------------------------------------------------------------- 三条底线
//
// ① 网络失败绝不让异常冒到界面：所有 fetch 都在这里 catch 掉，失败只改状态。
// ② 本地数据永远是真的：改本地成功了就算成功，云同步只是"有空再传一份"。
// ③ 状态对象必须缓存：getSyncState 永远返回同一个引用，否则订阅它的组件会无限重渲染。
//
// ---------------------------------------------------------------- 接线清单（给主程序）
//
//   1. setSyncSource(() => 当前本地数据)   —— 告诉它"要上传的是什么"
//   2. setSnapshotApplier((data) => 写回本地) —— 告诉它"拉下来的数据往哪放"
//   3. 本地数据每次变化后调 requestSync()（防抖 1500ms 自动推）
//   4. 登录成功后调一次 syncNow()（先把云端那份拉下来，再决定要不要推）
//   5. 登录状态切换时调一次 resetSyncState()（把内存里的版本号对齐本地存储）

import { ALL } from './constants'
import { getSessionToken } from './auth'
import type { SyncData, SyncSnapshot, SyncState, SyncStatus, Tool } from '../types'

// 类型也从这里再导出一遍，接线的同事只 import 这一个模块就够了
export type { SyncData, SyncSnapshot, SyncState, SyncStatus } from '../types'

// ---------------------------------------------------------------- 常量

// 注意：旧版的 'better-tools:sync-token'（共享令牌）已经不用了，
// 它的清理放在 src/lib/auth.ts 的 clearLocalAccountData() 里 —— 只留这一处清理入口。
const REVISION_KEY = 'better-tools:sync-revision'

// "本地有改动还没推上去"的标记。
// 为什么要落盘：改动之后、防抖等待的那 1.5 秒里用户把标签页关了，
// 只存在内存里的"待推送"就跟着没了。写进 localStorage，下次打开还能补推。
const DIRTY_KEY = 'better-tools:sync-dirty'

const API_BASE = '/api'

// 防抖时长。1.5 秒是"手停下来"和"改动不丢"之间的折中：
// 拖一次排序会连续触发几十次改动，每次都发请求既费流量又会互相打架。
const SYNC_DEBOUNCE_MS = 1500

// 后端限定的两个上限。超了就本地先拦住，省得白跑一趟只换回一个 400。
const MAX_TOOLS = 500
const MAX_PAYLOAD_BYTES = 256 * 1024

// ---------------------------------------------------------------- 模块级状态

// 有改动还没推上去。初值来自上次会话留下的标记。
let dirty = readDirtyFlag()

// 所有用 useSyncExternalStore 订阅的组件，谁订阅谁进这个集合
const listeners = new Set<() => void>()

// 缓存的状态对象。⚠️ 只在真的变化时才换成新对象（见 patchState）
let state: SyncState = {
  // 有会话令牌才可能"待同步"；没登录就停在 unauthenticated，一个请求都不发
  status: getSessionToken() ? 'idle' : 'unauthenticated',
  revision: readStoredRevision(),
  updatedAt: 0,
  lastError: '',
  lastSyncedAt: 0,
}

// "当前要上传的数据从哪来"和"拉下来的数据往哪写"，都由主程序注册
let source: (() => SyncData) | null = null
let applier: ((data: SyncData) => void) | null = null

// 防抖计时器。null 表示现在没有排队中的推送。
let debounceTimer: ReturnType<typeof setTimeout> | null = null

// 一次推送是否正在路上
let pushing = false

// 推送期间又攒了改动：这次结束后必须再推一次，否则用户最后那一下改动就丢了
let queuedPush = false

// 一次"拉 + 按需推"是否正在跑
let pulling = false

// ---------------------------------------------------------------- 本机存储

function readStoredRevision(): number {
  try {
    const value = Number(localStorage.getItem(REVISION_KEY))
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
  } catch {
    return 0
  }
}

function persistRevision(revision: number): void {
  try {
    localStorage.setItem(REVISION_KEY, String(revision))
  } catch {
    // 存不进去只影响"下次打开时还能不能接着判断"，本次会话内存里的值仍然准确
  }
}

function readDirtyFlag(): boolean {
  try {
    return localStorage.getItem(DIRTY_KEY) === '1'
  } catch {
    return false
  }
}

function markDirty(next: boolean): void {
  if (dirty === next) return
  dirty = next
  try {
    if (next) localStorage.setItem(DIRTY_KEY, '1')
    else localStorage.removeItem(DIRTY_KEY)
  } catch {
    // 同上：写不进去不影响本次会话
  }
}

// ---------------------------------------------------------------- 状态广播

/** 合并式更新状态。值都没变就保留旧对象（引用不变 → 订阅者不重渲染）。 */
function patchState(patch: Partial<SyncState>): void {
  const changed = (Object.keys(patch) as (keyof SyncState)[]).some(
    (key) => !Object.is(patch[key], state[key]),
  )
  if (!changed) return

  state = { ...state, ...patch }
  listeners.forEach((notify) => notify())
}

/** 订阅同步状态，返回取消订阅的函数。 */
export function subscribeSync(cb: () => void): () => void {
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
export function getSyncState(): SyncState {
  return state
}

// ---------------------------------------------------------------- 会话身份

/** 现在有没有登录（浏览器里存着会话令牌）。没登录就完全不联网。 */
function hasSession(): boolean {
  return getSessionToken().length > 0
}

/**
 * 【兼容旧接口】以前界面用这个函数填 / 清共享令牌，现在鉴权改成了账号会话
 * （src/lib/auth.ts）。令牌由那边保存，这里不再碰。
 *
 * 为什么还留着这个空函数：src/hooks/useSync.ts 仍然从本模块 import 它，
 * 而那个文件不在这次改动范围内。它现在已经不影响任何行为 ——
 * 登录 / 退出全部走 auth.ts。等 useSync 里那行 import 能删掉时，它就可以一起删。
 */
export function setToken(_token: string): void {
  // 故意留空：会话令牌不归这个文件管
}

// ---------------------------------------------------------------- HTTP 层
//
// 这一层只负责"发请求 + 把响应翻译成数据/错误"，不做任何状态判断。
// 它**会抛错**，界面请用 syncNow()（内部全 catch），别直接调这两个。

/** 服务器明确回了非 2xx。status 用来区分"断网"和"服务器说不行"。 */
class SyncHttpError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'SyncHttpError'
    this.status = status
  }
}

/**
 * 409 专用错误：意味着"别人先写了"，不是故障。
 * 把云端那一份带在错误里，上层直接采用它 —— 这就是约定的"云端胜"。
 */
export class SyncConflictError extends Error {
  snapshot: SyncSnapshot

  constructor(snapshot: SyncSnapshot) {
    super('云端已被另一台设备更新，已采用云端数据')
    this.name = 'SyncConflictError'
    this.snapshot = snapshot
  }
}

function authHeaders(): Record<string, string> {
  // 会话令牌由 src/lib/auth.ts 保管；这里只负责把它放进 Authorization 头。
  // 服务端靠它认出"这是谁"，从而只返回这个人自己那份快照。
  const token = getSessionToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function textOf(err: unknown): string {
  if (err instanceof Error) return err.message
  return typeof err === 'string' ? err : ''
}

/** 从错误响应里尽量掏出后端写的中文说明，掏不到就用状态码兜底。 */
async function toHttpError(res: Response): Promise<SyncHttpError> {
  let message = `服务器返回 ${res.status}`
  try {
    const body = (await res.json()) as { error?: unknown; message?: unknown }
    if (typeof body?.message === 'string' && body.message) message = body.message
    else if (body?.error === 'unauthorized') message = '登录已失效，请重新登录'
    else if (typeof body?.error === 'string') message = body.error
  } catch {
    // 响应体不是 JSON（比如开发时后端没起来、返回了 index.html），
    // body 已经读不出来了，用状态码那句就行
  }
  return new SyncHttpError(res.status, message)
}

/**
 * 拉取云端快照。
 *
 * cache: 'no-store' 很关键：GET /api/snapshot 一旦被浏览器或 CDN 缓存住，
 * 我们读到的 revision 会一直停在旧值，于是"该不该推"永远判断错，
 * 而且每次推都撞 409 —— 那种 bug 极难查，不如一开始就明确不要缓存。
 */
export async function pullSnapshot(): Promise<SyncSnapshot> {
  const res = await fetch(`${API_BASE}/snapshot`, {
    headers: authHeaders(),
    cache: 'no-store',
  })
  if (!res.ok) throw await toHttpError(res)

  const snapshot = parseSnapshotBody(await res.json())
  if (!snapshot) throw new SyncHttpError(res.status, '云端返回的快照格式不对，这次先不同步')
  return snapshot
}

/**
 * 把本地这一份推上去。
 *
 * baseRevision 是"我以为云端现在是第几版"，服务端拿它当乐观锁：
 * 只有云端确实是这个版本才允许写，否则回 409 —— 这样两台设备同时改也不会把对方的数据抹掉。
 */
export async function pushSnapshot(
  baseRevision: number,
  data: SyncData,
): Promise<{ revision: number; updatedAt: number }> {
  const res = await fetch(`${API_BASE}/snapshot`, {
    method: 'PUT',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseRevision, data }),
  })

  if (res.status === 409) {
    // 409 不是"出故障"，是"你手里的版本过期了"。把云端那份交给上层去采用。
    const body: unknown = await res.json().catch(() => null)
    const snapshot = isRecord(body) ? parseSnapshotBody(body.snapshot) : null
    if (!snapshot) {
      // 连冲突内容都读不出来，就当成普通失败：宁可这次不同步，
      // 也不能拿一份看不懂的"云端数据"去覆盖本地。
      throw new SyncHttpError(409, '云端报告了冲突，但返回的快照看不懂，请稍后重试')
    }
    throw new SyncConflictError(snapshot)
  }

  if (!res.ok) throw await toHttpError(res)

  const body = (await res.json()) as { revision?: unknown; updatedAt?: unknown }
  const revision = asFiniteNumber(body?.revision)
  if (revision === null) throw new SyncHttpError(res.status, '服务器返回的版本号看不懂')
  return { revision, updatedAt: asFiniteNumber(body?.updatedAt) ?? 0 }
}

// ---------------------------------------------------------------- 响应体校验
//
// 为什么要逐字段核对：同步是会**覆盖本地**的操作。
// 后端改个字段名、或者别的客户端写进脏数据，如果不检查就照单全收，
// 用户的工具列表会被一份残缺数据洗掉。宁可这次不同步，也不能污染本地。

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function parseSyncData(raw: unknown): SyncData | null {
  if (!isRecord(raw)) return null

  const { tools: rawTools, groups: rawGroups, favorites: rawFavorites, order: rawOrder } = raw
  if (
    !Array.isArray(rawTools) ||
    !Array.isArray(rawGroups) ||
    !Array.isArray(rawFavorites) ||
    !Array.isArray(rawOrder)
  ) {
    return null
  }

  const tools: Tool[] = []
  for (const item of rawTools) {
    // 单个工具字段不全就跳过它，而不是让整份数据作废 ——
    // 一条坏数据不该毁掉另外四百多条
    if (!isRecord(item)) continue
    if (typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.url !== 'string') continue
    tools.push({
      id: item.id,
      name: item.name,
      url: item.url,
      description: typeof item.description === 'string' ? item.description : '',
      category: typeof item.category === 'string' ? item.category : '',
      icon: typeof item.icon === 'string' && item.icon !== '' ? item.icon : undefined,
    })
  }

  const appSettings = isRecord(raw.appSettings) ? raw.appSettings : {}
  const defaultCategory =
    typeof appSettings.defaultCategory === 'string' && appSettings.defaultCategory !== ''
      ? appSettings.defaultCategory
      : ALL

  return {
    tools,
    groups: rawGroups.filter((item): item is string => typeof item === 'string'),
    favorites: rawFavorites.filter((item): item is string => typeof item === 'string'),
    order: rawOrder.filter((item): item is string => typeof item === 'string'),
    appSettings: { defaultCategory },
  }
}

function parseSnapshotBody(raw: unknown): SyncSnapshot | null {
  if (!isRecord(raw)) return null

  const revision = asFiniteNumber(raw.revision)
  if (revision === null || revision < 0) return null
  const updatedAt = asFiniteNumber(raw.updatedAt) ?? 0

  // data 是 null（或缺字段）= 云端从没存过东西。这是契约里明确允许的，不是错误。
  if (raw.data === null || raw.data === undefined) return { revision, updatedAt, data: null }

  const data = parseSyncData(raw.data)
  return data ? { revision, updatedAt, data } : null
}

// ---------------------------------------------------------------- 数据来源 / 写回

/**
 * 注册"当前要上传的数据从哪来"。
 *
 * 传函数而不是传数据：数据一直在变，每次推送前现读一份最新的，
 * 才不会把"点同步那一刻的旧数据"传上去。
 */
export function setSyncSource(fn: (() => SyncData) | null): void {
  source = fn
}

/**
 * 注册"把云端数据写回本地"。
 *
 * 这一步必须由主程序做：只有它知道这些数据该拆到哪几个 localStorage 键里、
 * 又要怎么通知界面刷新。sync.ts 不认识那几个 Hook，也不该绕开它们直接写存储。
 */
export function setSnapshotApplier(fn: ((data: SyncData) => void) | null): void {
  applier = fn
}

/**
 * 把一份云端快照写回本地（只写本地，不联网）。
 *
 * 返回 false 表示没写成，两种情况：没注册写回函数、或者写回过程抛错。
 * 调用方（adoptSnapshot）看到 false 就**不会**推进本地 revision ——
 * 否则会出现"本地数据还是旧的、却记成了已同步"的假一致，
 * 下次启动就会把旧数据当成新数据推上去。
 */
export function applySnapshotToSources(snapshot: SyncSnapshot): boolean {
  // 云端是空的，没有东西要写回本地
  if (!snapshot.data) return true

  if (!applier) {
    patchState({
      status: 'error',
      lastError: '还没注册本地写回函数（setSnapshotApplier），云端数据没法落地',
    })
    return false
  }

  try {
    applier(snapshot.data)
    return true
  } catch (err) {
    patchState({ status: 'error', lastError: `写回本地失败：${textOf(err)}` })
    return false
  }
}

// ---------------------------------------------------------------- 内部动作

function clearTimer(): void {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
}

/** 记下"已和云端一致"，三件事一起做：版本号、清脏标记、改状态。 */
function markSynced(revision: number, updatedAt: number): void {
  persistRevision(revision)
  markDirty(false)
  patchState({
    revision,
    updatedAt,
    status: 'synced',
    lastError: '',
    lastSyncedAt: Date.now(),
  })
}

/** 采用云端快照（云端胜）。写回失败就停在 error 状态，不推进 revision。 */
function adoptSnapshot(snapshot: SyncSnapshot): void {
  if (!applySnapshotToSources(snapshot)) return
  markSynced(snapshot.revision, snapshot.updatedAt)
}

/** 本地先自查一遍，超限就别发了 —— 后端只会回一个 400，白跑一趟。 */
function checkPayload(data: SyncData): string {
  if (data.tools.length > MAX_TOOLS) {
    return `工具已经有 ${data.tools.length} 条，超过同步上限 ${MAX_TOOLS} 条，请先删掉一些`
  }

  // 用 TextEncoder 数真实字节：一个汉字在 UTF-8 里占 3 个字节，
  // 字符串的 .length 只算 1，拿它当体积会低估好几倍。
  const bytes = new TextEncoder().encode(JSON.stringify(data)).length
  if (bytes > MAX_PAYLOAD_BYTES) {
    return `数据大约 ${Math.round(bytes / 1024)} KB，超过同步上限 256 KB，请先精简内容`
  }
  return ''
}

/** 把各种异常翻译成"状态 + 一句人话"，界面直接显示。 */
function describeError(err: unknown): { status: SyncStatus; message: string } {
  if (err instanceof SyncHttpError) {
    if (err.status === 401) return { status: 'error', message: '登录已失效，请在设置里退出后重新登录' }
    if (err.status === 400) return { status: 'error', message: err.message || '云端拒收：数据格式不对' }
    if (err.status >= 500) return { status: 'error', message: `服务器出错了（${err.status}），稍后会自动重试` }
    return { status: 'error', message: err.message }
  }

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { status: 'offline', message: '设备没有联网，改动先留在本地' }
  }

  // fetch 只在"根本没连上"时抛 TypeError（断网、域名解析失败、服务没起来）。
  // 归到 offline：界面提示"本地照常可用"，本地一个字都不动。
  if (err instanceof TypeError) {
    return { status: 'offline', message: '连不上服务器，改动先留在本地' }
  }

  return { status: 'error', message: textOf(err) || '同步失败，原因不明' }
}

function failWith(err: unknown): void {
  const { status, message } = describeError(err)
  patchState({ status, lastError: message })
}

/**
 * 把本地数据推上去。
 *
 * 默认拿 state.revision 当 baseRevision —— 也就是"我上次见到的云端版本"。
 */
async function pushLocal(baseRevision: number = state.revision): Promise<void> {
  if (!hasSession()) {
    patchState({ status: 'unauthenticated' })
    return
  }

  if (pushing) {
    // 上一次请求还没回来。这里绝不能再发一个：两个请求带着同一个 baseRevision 冲上去，
    // 后一个必然 409，把好好的数据判成"冲突"。
    // 记一笔，等这轮结束后补推一次 —— 这就是"推送中又有新改动不能丢"的落点。
    queuedPush = true
    return
  }

  if (!source) {
    patchState({ status: 'error', lastError: '还没注册本地数据来源（setSyncSource），没法上传' })
    return
  }

  let data: SyncData
  try {
    data = source()
  } catch (err) {
    patchState({ status: 'error', lastError: `读取本地数据出错：${textOf(err)}` })
    return
  }

  const problem = checkPayload(data)
  if (problem) {
    patchState({ status: 'error', lastError: problem })
    return
  }

  pushing = true
  patchState({ status: 'syncing', lastError: '' })

  let ok = false
  try {
    const result = await pushSnapshot(baseRevision, data)
    markSynced(result.revision, result.updatedAt)
    ok = true
  } catch (err) {
    if (err instanceof SyncConflictError) {
      // 409：别的设备抢先写了。按约定"云端胜"—— 采用云端那份，本地这次的改动作废。
      // 既然本地马上要被云端数据覆盖，排队中的那一次推送也就没有意义了。
      queuedPush = false
      adoptSnapshot(err.snapshot)
    } else {
      failWith(err)
    }
  } finally {
    pushing = false
    if (queuedPush) {
      queuedPush = false
      // 只有这次成功了才立刻补推。失败（断网 / 401）马上重试也一样失败，
      // 脏标记还留着，等下一次改动或用户手动点同步。
      if (ok) void pushLocal()
    }
  }
}

// ---------------------------------------------------------------- 对外动作

/**
 * 把内存里的同步状态对齐到当前浏览器存储。
 *
 * 什么时候要调：登录状态切换的时候（退出后换个人登录、令牌失效后重新登录）。
 * 内存里的 revision 是**上一个人**留下的 —— 拿它去和下一个人的云端比大小，
 * 会把"云端更新"误判成"本地更新"，于是用一份本地数据把人家的云端覆盖掉。
 * 这种事故是静默的，所以宁可每次切换都重新对一遍。
 */
export function resetSyncState(): void {
  clearTimer()
  queuedPush = false
  markDirty(false)
  patchState({
    status: getSessionToken() ? 'idle' : 'unauthenticated',
    revision: readStoredRevision(),
    updatedAt: 0,
    lastError: '',
    lastSyncedAt: 0,
  })
}

/**
 * "本地刚改过"的信号：防抖 1.5 秒后自动推。
 *
 * 主程序在每次数据变化后调它即可，不用关心当前是第几版、有没有在推送 ——
 * 那些判断都在 pushLocal 里。
 */
export function requestSync(): void {
  // 没登录时连"待推"都不记：这份数据还不属于任何账号，
  // 等登录后由 syncNow 决定（云端是空的就把本地推上去，云端有就拉下来）。
  // 记了脏标记反而危险：下一个人登录时，它会把这轮同步判成"本地要推、云端要丢弃"。
  if (!hasSession()) {
    patchState({ status: 'unauthenticated' })
    return
  }

  markDirty(true)

  // 连续改动只推最后一次：每来一次就重置计时器，等用户真的停下来再发请求。
  clearTimer()
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    void pushLocal()
  }, SYNC_DEBOUNCE_MS)
}

/**
 * 立即同步一次：先拉，再按需推。
 *
 * 这是"登录成功后"和"用户点同步按钮"都该调的那个函数。
 * 它永远不会抛错 —— 出什么事都只体现在 getSyncState().status / lastError 上。
 */
export async function syncNow(): Promise<void> {
  // 没登录就完全不发请求：连 401 都不该去领，状态停在 unauthenticated 最诚实
  if (!hasSession()) {
    patchState({ status: 'unauthenticated' })
    return
  }

  if (pulling) return // 已经在跑了，别叠第二份

  if (pushing) {
    // 有推送在路上时先让它跑完：它自己会处理成功或 409（并更新 revision）。
    // 这时候硬插一次拉取，两边各写一次 revision，状态显示会来回跳。
    return
  }

  pulling = true
  clearTimer() // 手动同步优先：把排队中的那次推送并进来，别重复发一遍
  patchState({ status: 'syncing', lastError: '' })

  try {
    const cloud = await pullSnapshot()

    if (cloud.data === null) {
      // 云端从来没有过数据 → 本地这份就是第一版，直接推上去
      await pushLocal(cloud.revision)
    } else if (cloud.revision > state.revision) {
      // 云端更新（另一台设备改过，或者这台设备第一次同步）→ 云端胜，覆盖本地
      adoptSnapshot(cloud)
    } else if (cloud.revision < state.revision) {
      // 本地记的版本比云端还新（云端被重置过？）→ 以本地为准推上去。
      // baseRevision 必须用云端**当前**的值，不然服务端一定判我们 409。
      await pushLocal(cloud.revision)
    } else if (dirty) {
      // 版本一样，但本地有没推出去的改动 → 补推
      await pushLocal(cloud.revision)
    } else {
      // 版本一样、也没有待推的改动：已经一致，更新一下"最后同步时间"就够了
      markSynced(cloud.revision, cloud.updatedAt)
    }
  } catch (err) {
    failWith(err)
  } finally {
    pulling = false
  }
}

// ---------------------------------------------------------------- 网络状态
//
// 断网 / 恢复网络时浏览器会各通知一次。顺手把状态改对、
// 把断网期间压着的改动补推一次，用户不用自己去点"重试"。

if (typeof window !== 'undefined') {
  window.addEventListener('offline', () => {
    if (hasSession()) patchState({ status: 'offline', lastError: '设备已断网，改动会先留在本地' })
  })

  window.addEventListener('online', () => {
    // 没登录时连"恢复网络"也不用管：登录界面自己会让用户重新提交
    if (!hasSession()) return
    if (dirty || state.status === 'offline') void syncNow()
  })
}
