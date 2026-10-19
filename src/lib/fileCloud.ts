// 文件云的 HTTP 客户端：/api/files/* 和公开分享这几组接口都从这里发。
//
// 为什么集中在一个文件：
//   鉴权头、URL 前缀、错误 JSON 的读法只写一遍。上层（fileSync / 界面）只调函数，
//   不直接碰 fetch —— 以后后端改路径或错误码，只改这里。
//
// 鉴权照抄 src/lib/sync.ts：请求带 Authorization: Bearer <会话令牌>，
// 令牌不归这个文件管（读写都在 ./auth，这里只调 getSessionToken()）。
// 没登录时这里不拦：服务端会回 401，由 fileSync 的状态机翻译成「登录已失效」。
// 这一层的职责只有一件：把 HTTP 响应变成数据，或者变成 FileCloudError 抛出去。

import { getSessionToken } from './auth'

// 单文件上限 / 每账号总配额。必须和 worker 里的常量保持一致（见三方契约第二节）。
export const MAX_FILE_BYTES = 50 * 1024 * 1024
export const USER_QUOTA_BYTES = 500 * 1024 * 1024

/**
 * 文件在哪个区域：
 *   private —— 我的文件，只有自己能看到；
 *   public  —— 公共文件池，所有登录用户都能看到、能往里放东西。
 *
 * 为什么放在这一层定义：fileStore 要 import fileCloud 的类型，反过来会成环；
 * 而 CloudNode 的解析就在这里，scope 的「默认值」也应该只写一遍。
 */
export type FileScope = 'private' | 'public'

const API_BASE = '/api'

// 后端规定一次最多提交 200 条节点 / id，超了整个请求回 400。
// 这里自动拆批，调用方不需要关心这个上限。
const BATCH_LIMIT = 200

export interface CloudNode {
  id: string
  parentId: string
  name: string
  kind: 'file' | 'folder'
  size: number
  mime: string
  // 墓碑：这条节点在云端已经被删了，同步时要照着删本地
  deleted: boolean
  updatedAt: number
  /** 云端没有这个字段的旧数据一律按私人文件处理（见 parseCloudNode） */
  scope: FileScope
}

/** 上传节点元数据时的形状（不含 deleted / updatedAt：这两个由服务端决定） */
export interface FileNodePayload {
  id: string
  parentId: string
  name: string
  kind: 'file' | 'folder'
  size: number
  mime: string
  /** 不传 = private，兼容旧版前端推上来的请求 */
  scope: FileScope
}

export interface CloudShare {
  token: string
  nodeId: string
  name: string
  createdAt: number
  expiresAt: number | null
}

export interface CloudUsage {
  used: number
  quota: number
}

/** 服务器明确回了非 2xx。fileSync 靠 status 区分断网 / 401 / 其它故障。 */
export class FileCloudError extends Error {
  status: number
  code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'FileCloudError'
    this.status = status
    this.code = code
  }
}

// 常见错误码的默认中文说明。服务端如果带了 message 就用它的，这里只是兜底。
const CODE_MESSAGES: Record<string, string> = {
  'bad-request': '请求参数不对',
  unauthorized: '登录已失效，请重新登录',
  'not-found': '云端找不到这一项',
  'payload-too-large': '单个文件超过大小上限',
  'quota-exceeded': '云端空间已满，请先删掉一些文件',
  // 个人配额用完和全站池子用完是两回事：前者找自己删文件或请管理员调额度，
  // 后者只能由管理员处理（全站 10 GB 是 R2 免费额度，超出会计费）。
  // 分开展示，用户才知道该找谁。
  'site-quota-exceeded': '全站云盘空间已满（10 GB 免费额度），请联系管理员',
  'storage-not-configured': '云端存储还没有配置好',
  expired: '分享链接已过期',
}

function authHeaders(): Record<string, string> {
  const token = getSessionToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/** 把错误响应翻译成 FileCloudError：优先用后端写的中文说明，读不到就用错误码兜底。 */
async function toCloudError(res: Response): Promise<FileCloudError> {
  let code = `http-${res.status}`
  let message = ''
  try {
    const body = (await res.json()) as { error?: unknown; message?: unknown } | null
    if (body && typeof body.error === 'string' && body.error) code = body.error
    if (body && typeof body.message === 'string' && body.message) message = body.message
  } catch {
    // 502 / 代理页面这些响应体不是 JSON，读不出来就按状态码兜底
  }
  if (!message) message = CODE_MESSAGES[code] ?? `服务器返回 ${res.status}`
  return new FileCloudError(res.status, code, message)
}

/** 统一发请求：带上鉴权头，非 2xx 一律抛 FileCloudError。 */
async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = { ...authHeaders() }
  const extra = init.headers as Record<string, string> | undefined
  if (extra) Object.assign(headers, extra)

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers })
  if (!res.ok) throw await toCloudError(res)
  return res
}

// ---------------------------------------------------------------- 响应体校验
//
// 为什么要逐字段核对：同步是**会改本地数据**的操作。后端改个字段名、
// 或者别的客户端写进脏数据，不检查就照单全收会把本地名册洗坏。
// 与 sync.ts 的方针一致：单条坏数据跳过，不让整次同步作废。

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function parseCloudNode(raw: unknown): CloudNode | null {
  if (!isRecord(raw)) return null
  if (typeof raw.id !== 'string' || raw.id === '') return null
  if (typeof raw.name !== 'string') return null
  if (raw.kind !== 'file' && raw.kind !== 'folder') return null
  const updatedAt = asFiniteNumber(raw.updatedAt)
  if (updatedAt === null) return null

  return {
    id: raw.id,
    parentId: typeof raw.parentId === 'string' ? raw.parentId : '',
    name: raw.name,
    kind: raw.kind,
    size: asFiniteNumber(raw.size) ?? 0,
    mime: typeof raw.mime === 'string' ? raw.mime : '',
    deleted: raw.deleted === true,
    updatedAt,
    // 旧 worker（还没上公共文件池）不返回 scope：按私人文件处理，不会把
    // 自己的文件误判成池内文件。
    scope: raw.scope === 'public' ? 'public' : 'private',
  }
}

function parseCloudShare(raw: unknown): CloudShare | null {
  if (!isRecord(raw)) return null
  if (typeof raw.token !== 'string' || raw.token === '') return null
  if (typeof raw.nodeId !== 'string' || raw.nodeId === '') return null

  return {
    token: raw.token,
    nodeId: raw.nodeId,
    name: typeof raw.name === 'string' ? raw.name : '',
    createdAt: asFiniteNumber(raw.createdAt) ?? 0,
    expiresAt: asFiniteNumber(raw.expiresAt),
  }
}

// ---------------------------------------------------------------- 目录树

/**
 * 拉取整棵目录树（**含墓碑**）。
 *
 * cache: 'no-store' 很关键：这份数据被浏览器缓存住的话，删掉的文件会一直在
 * 本地"复活"，而且极难查。同步读的必须是服务端刚算出来的那一份。
 */
export async function fetchTree(): Promise<CloudNode[]> {
  const res = await request('/files/tree', { cache: 'no-store' })
  const body = (await res.json().catch(() => null)) as unknown
  const raw = isRecord(body) && Array.isArray(body.nodes) ? body.nodes : null
  if (!raw) throw new FileCloudError(res.status, 'bad-response', '云端返回的目录树格式不对')

  return raw.map(parseCloudNode).filter((node): node is CloudNode => node !== null)
}

/** 提交节点元数据（新建 / 改名 / 移动都用它）。 */
export async function pushNodes(nodes: FileNodePayload[]): Promise<void> {
  for (let start = 0; start < nodes.length; start += BATCH_LIMIT) {
    const batch = nodes.slice(start, start + BATCH_LIMIT)
    await request('/files/nodes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodes: batch }),
    })
  }
}

/** 删除节点（服务端会连带删子树、撤销分享、回收配额）。返回实际删掉的条数。 */
export async function pushDelete(ids: string[]): Promise<number> {
  let deleted = 0
  for (let start = 0; start < ids.length; start += BATCH_LIMIT) {
    const batch = ids.slice(start, start + BATCH_LIMIT)
    const res = await request('/files/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: batch }),
    })
    const body = (await res.json().catch(() => null)) as { deleted?: unknown } | null
    deleted += asFiniteNumber(body?.deleted) ?? batch.length
  }
  return deleted
}

// ---------------------------------------------------------------- 内容（二进制）

/**
 * 上传文件内容。
 *
 * Content-Length 不能手动写（浏览器会按 Blob 的真实字节数自动带上，契约要求必须有，
 * 缺失时服务端回 411）。Content-Type 交给 blob 自己，空类型时补一个通用二进制类型，
 * 否则有些服务端会把它当文本处理。
 */
export async function uploadContent(id: string, blob: Blob): Promise<void> {
  await request(`/files/content/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    body: blob,
  })
}

/** 下载文件内容。云端没有这份内容（404）返回 null，其它失败照常抛错。 */
export async function fetchContent(id: string): Promise<Blob | null> {
  const res = await fetch(`${API_BASE}/files/content/${encodeURIComponent(id)}`, {
    headers: authHeaders(),
    cache: 'no-store',
  })
  if (res.status === 404) return null
  if (!res.ok) throw await toCloudError(res)
  return await res.blob()
}

// ---------------------------------------------------------------- 用量

/** 查云端用量。未登录 / 断网 / 格式不对都返回 null —— 界面上只是少显示一行，不该报错。 */
export async function fetchUsage(): Promise<CloudUsage | null> {
  try {
    if (!getSessionToken()) return null
    const res = await request('/files/usage', { cache: 'no-store' })
    const body = (await res.json().catch(() => null)) as unknown
    if (!isRecord(body)) return null

    const used = asFiniteNumber(body.used)
    const quota = asFiniteNumber(body.quota)
    if (used === null || quota === null || quota <= 0) return null
    return { used, quota }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- 分享链接

/** 给某个节点生成分享链接。同一个节点重复调用由后端决定是否复用 token。 */
export async function createShare(
  nodeId: string,
  expiresAt: number | null = null,
): Promise<CloudShare> {
  const res = await request('/files/shares', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId, expiresAt }),
  })
  const body = (await res.json().catch(() => null)) as unknown
  const share = parseCloudShare(body)
  if (!share) throw new FileCloudError(res.status, 'bad-response', '云端返回的分享信息格式不对')
  return share
}

/** 列出当前账号所有分享。 */
export async function listShares(): Promise<CloudShare[]> {
  const res = await request('/files/shares', { cache: 'no-store' })
  const body = (await res.json().catch(() => null)) as unknown
  const raw = isRecord(body) && Array.isArray(body.shares) ? body.shares : null
  if (!raw) return []

  return raw.map(parseCloudShare).filter((share): share is CloudShare => share !== null)
}

/** 撤销分享。404 = 本来就没了，和撤销成功结果相同，不当失败。 */
export async function revokeShare(token: string): Promise<void> {
  const res = await fetch(`${API_BASE}/files/shares/${encodeURIComponent(token)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  })
  if (res.status === 404) return
  if (!res.ok) throw await toCloudError(res)
}
