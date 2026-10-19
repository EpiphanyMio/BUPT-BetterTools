// BetterTools 的同源 API：账号体系（邀请码注册）+ 按用户隔离的云端快照。
//
// ---------------------------------------------------------------- 它负责哪些请求
//
// 网站本身还是纯静态的 —— 这个 Worker 只接管 /api/* 这几条路径，
// 其余请求原样交回静态资源层（env.ASSETS），所以加了后端之后
// 页面、字体、图片的访问方式和以前完全一样。
// 同源也意味着**不需要 CORS**：浏览器认为 /api 和页面是一个源，不带预检、不拦响应。
//
// ---------------------------------------------------------------- v1 → v2 变了什么
//
// v1 是「单用户 + 一个共享令牌」：谁拿到令牌谁就能读写全部数据，
// 所以那个令牌其实是**密码**，没法发给第二个人。
// v2 换成账号：username + password 换一个会话令牌，数据按 user_id 分行存。
// 共享令牌 SYNC_TOKEN 从这一版起不再参与任何鉴权（Env 里留着字段只是为了让老配置不报错）。
//
// ---------------------------------------------------------------- 数据为什么还是一整包
//
// 每个用户在 snapshot 表里占**一行**（user_id 是主键，见 worker/schema.sql）。
// 为什么不拆成 tools / groups / favorites 多张表：
//   一个人全部的数据才十几 KB。拆表就要处理「两台设备各改一条」的字段级合并，
//   而合并规则写错是**静默**的 —— 数据被揉在一起，用户不知道从哪一步开始错的。
//   单行快照把冲突变成一个数字比较：revision 对不上就 409，谁新谁赢，行为可预测。
// 多用户没有改变这个判断，只是把「那一行」变成了「每人各一行」。
//
// ---------------------------------------------------------------- 乐观锁：一条 WHERE 挡掉并发覆盖
//
// revision 由服务器维护，每成功写一次 +1。客户端 PUT 时带 baseRevision
// （「我以为云端现在是第几版」），服务端把它塞进 UPDATE 的 WHERE 里：
//
//   UPDATE snapshot SET revision = revision + 1, ... WHERE user_id = ? AND revision = ?baseRevision
//
// 如果别的设备先写过，这个 WHERE 一行都匹配不到 → meta.changes === 0 → 回 409，
// 并把当前快照带回去。为什么不能「先 SELECT 再 UPDATE」：查完到改之间别的请求
// 可能已经写进去了，那个空档就是数据被覆盖的地方。把版本号放进 WHERE，
// 判断和写入由数据库一句完成，中间没有缝。
//
// ---------------------------------------------------------------- 三条硬性要求
//
// ① **先鉴权再读 body**：没令牌的请求连 256KB 的数据都不该让我们解析，
//    否则谁都能靠狂发大包白烧 Worker 的 CPU 和内存（Worker 是按调用计费的）。
// ② 密码和令牌都用**定长时间**比较：直接 === 会在第一个不同的字符处提前返回，
//    攻击者能从响应耗时差里一位一位地试。具体实现在 worker/auth.ts。
// ③ 所有响应都是 JSON（Content-Type: application/json; charset=utf-8）。
//    哪怕是 404 / 500 —— 一旦漏成 HTML，前端 res.json() 只会抛一句看不懂的语法错误，
//    「路径写错了」「服务端炸了」这些真正的原因就被埋掉了。
//
// ---------------------------------------------------------------- 路由（顺序即优先级）
//
//   OPTIONS 预检                       → 204
//   非 /api/*                          → 交给 env.ASSETS（页面、静态文件、SPA 回落）
//   POST   /api/auth/register          → 201 { token, user }
//   POST   /api/auth/login             → 200 { token, user }
//   POST   /api/auth/logout   需登录    → 204
//   GET    /api/auth/me       需登录    → 200 { user }
//   GET    /api/invites       需管理员  → 200 { invites }
//   POST   /api/invites       需管理员  → 201 { code }
//   DELETE /api/invites/{code} 需管理员 → 204
//   GET    /api/snapshot      需登录    → 200 { revision, updatedAt, data }
//   PUT    /api/snapshot      需登录    → 200 | 409
//   GET    /api/files/tree    需登录    → 200 { nodes }（含墓碑）
//   POST   /api/files/nodes   需登录    → 200 { ok }（一次 ≤200 条）
//   POST   /api/files/delete  需登录    → 200 { ok, deleted }
//   GET    /api/files/usage   需登录    → 200 { used, quota }
//   PUT    /api/files/content/{id}  需登录 → 200 { ok, size }
//   GET    /api/files/content/{id}  需登录 → 二进制
//   GET    /api/files/shares  需登录    → 200 { shares }
//   POST   /api/files/shares  需登录    → 201 { token, nodeId, expiresAt }
//   DELETE /api/files/shares/{token} 需登录 → 204
//   GET    /api/share/{token} 无需鉴权  → 二进制（公开分享）
//   其它 /api/*                        → 404 { error: "not-found" }
//
// 为什么把 /api/auth/* 放在最前面：注册和登录是**唯一**不需要令牌的接口，
// 先按前缀分流，后面的处理函数就不用再考虑「这个请求可能还没身份」这件事。

import type { D1Database, D1PreparedStatement } from './d1.ts'
import type { R2Bucket } from './r2.ts'
import {
  authenticate,
  createSession,
  destroySession,
  hashPassword,
  DUMMY_PASSWORD_RECORD,
  parsePassword,
  parseUsername,
  verifyPassword,
} from './auth.ts'
import type { User } from './auth.ts'

/** 静态资源绑定：把我管不了的请求原样交回去 */
interface Fetcher {
  fetch(request: Request): Promise<Response>
}

interface Env {
  DB: D1Database
  ASSETS: Fetcher
  /**
   * R2 桶：文件管理里文件的实际内容。
   *
   * 为什么是可选的：本地开发 / 旧配置里可能没有这个绑定。
   * 缺了它时文件接口会明确回 503「云存储未配置」，而不是抛一个看不懂的异常 ——
   * 工具清单、账号、快照这些功能完全不受影响。
   */
  FILES?: R2Bucket
  /**
   * v1 的共享令牌。v2 起**不再作为鉴权依据**，这里留着只是为了让
   * 老的 .dev.vars / 线上 secret 存在时不报错。别再把任何逻辑挂到它上面。
   */
  SYNC_TOKEN?: string
}

// ---------------------------------------------------------------- 契约里的数据形状

interface ToolRow {
  id: string
  name: string
  url: string
  description: string
  category: string
  /** 空字符串等于「没设图标」，见下面 readSyncData 里的说明 */
  icon?: string
}

interface SyncData {
  tools: ToolRow[]
  groups: string[]
  favorites: string[]
  order: string[]
  appSettings: { defaultCategory: string }
}

interface SnapshotRow {
  revision: number
  updated_at: number
  data: string
}

interface UserPasswordRow {
  id: number
  username: string
  passwordHash: string
  salt: string
  iterations: number
  isAdmin: number
}

interface InviteRow {
  code: string
  createdAt: number
  usedAt: number | null
  usedBy: string | null
}

/** 一条目录节点（含墓碑）。和前端 src/lib/fileCloud.ts 的 CloudNode 一一对应。 */
interface CloudNode {
  id: string
  /** 根目录用空字符串表示，和前端 FileNode.parentId 一致 */
  parentId: string
  name: string
  kind: 'file' | 'folder'
  size: number
  mime: string
  deleted: boolean
  updatedAt: number
}

/** 客户端推上来的节点：只有这些字段，deleted / updatedAt 由服务端决定，不接受客户端传。 */
interface FileNodePayload {
  id: string
  parentId: string
  name: string
  kind: 'file' | 'folder'
  size: number
  mime: string
}

/** file_nodes 的查询行：列名用 AS 转成驼峰，省得下面每处都手写 snake→camel */
interface CloudNodeRow {
  id: string
  parentId: string
  name: string
  kind: string
  size: number
  mime: string
  deleted: number
  updatedAt: number
}

interface CloudShare {
  token: string
  nodeId: string
  name: string
  createdAt: number
  expiresAt: number | null
}

interface CloudShareRow {
  token: string
  nodeId: string
  name: string
  createdAt: number
  expiresAt: number | null
}

/** 公开分享查出来的那一行：分享本身 + 节点元数据（节点可能已经不在了，所以字段可空） */
interface PublicShareRow {
  nodeId: string
  userId: number
  expiresAt: number | null
  revoked: number
  name: string | null
  mime: string | null
  deleted: number | null
}

// ---------------------------------------------------------------- 常量

// 请求体上限 256KB、工具最多 500 条：与前端 src/lib/sync.ts 里的 MAX_PAYLOAD_BYTES /
// MAX_TOOLS 保持一致。两边都拦一次是有意的 —— 前端拦是为了省一次白跑的请求，
// 后端拦是因为**不能信任客户端**：绕过网页直接 curl 一样能打这个接口。
const MAX_BODY_BYTES = 256 * 1024
const MAX_TOOLS = 500

// 邀请码领取的租约：注册要先把邀请码「占住」（防两个请求同时用同一个码），
// 占住之后如果进程在后面那几步里挂了，这个码会在租约到期后恢复可用。
// 2 分钟远大于一次注册本身的耗时（一次 PBKDF2 才几十毫秒）。
const INVITE_CLAIM_LEASE_MS = 2 * 60 * 1000

const INVITE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const INVITE_LENGTH = 12
const INVITE_CODE_RE = /^[A-Za-z0-9-]{6,32}$/

// ---------------------------------------------------------------- 文件管理常量
//
// MAX_FILE_BYTES / USER_QUOTA_BYTES 与前端 src/lib/fileCloud.ts 里的同名常量保持一致
// （契约第二节）。和 MAX_BODY_BYTES 一样两边各拦一次：前端拦是为了省一次白跑的请求，
// 后端拦是因为**不能信任客户端** —— 绕过网页直接 curl 一样能打这些接口。
const MAX_FILE_BYTES = 50 * 1024 * 1024
const USER_QUOTA_BYTES = 500 * 1024 * 1024

// 一次请求最多带多少个节点 / 删除多少个 id。拖 200 个文件进来已经是极端情况，
// 再大就不该靠一次请求：D1 的 batch 语句越多，一次失败重试的成本越高。
const MAX_FILE_BATCH = 200

// 目录树一次最多拉 5000 行（契约第二节）。这个上限是给客户端内存兜底的：
// 整棵树是一次性 JSON 返回的，行数再多，首屏同步的响应体就会大到没法接受。
const MAX_TREE_ROWS = 5000

// 节点 id 由前端生成（'file-' / 'folder-' + crypto.randomUUID()）。
// 这里只放行字母、数字、下划线、连字符：它同时会被拼进 R2 的 key（u/{userId}/{nodeId}），
// 一旦允许 '/' 或 '..'，key 就能被引到别人的前缀下面。校验比前端实际生成的格式更严，
// 换来的是「R2 key 永远落在本用户目录里」这条不变量。
const NODE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

// 文件名只卡长度和「会破坏界面 / 响应头」的字符：
// 换行等控制字符会污染 Content-Disposition，斜杠会被前端当成路径分隔符。
const FILE_NAME_RE = /^[^\u0000-\u001f\u007f/\\]{1,255}$/
const MIME_MAX = 200
// 归一化之后的基础 MIME 类型；空串也表示「未知类型」，下载时按 octet-stream 处理。
const MIME_RE = /^$|^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/

// 只有这些类型允许浏览器**内联打开**（inline），其余一律 application/octet-stream +
// attachment 强制下载。原因：/api 和页面同源，一个 .html 或 .svg 传上来再被 inline 打开，
// 里面的脚本就等于在站点自己的源上执行了 —— 这是最直接的 XSS 入口。
// svg 不在白名单里也是同一个理由（SVG 里能写 <script>）。
const INLINE_MIME_TYPES = new Set([
  'application/pdf',
  'text/plain',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/mp4',
  'video/mp4',
  'video/webm',
])

// 分享 token：16 字节随机数转 32 位小写 hex（128 位，猜不出来）。
// 只含 [0-9a-f]，放进 URL 不需要转义；库里存的也是它本身（见 schema.sql 的说明）。
const SHARE_TOKEN_BYTES = 16
const SHARE_TOKEN_RE = /^[a-f0-9]{32}$/

// 所有 JSON 响应共用。cache-control: no-store 很重要：
// GET /api/snapshot 一旦被浏览器或 CDN 缓存住，客户端读到的 revision 会一直停在旧值，
// 于是「该不该推」永远判断错、每次推都撞 409 —— 那种 bug 极难查，不如一开始就声明不缓存。
const JSON_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

// ---------------------------------------------------------------- 响应小工具
//
// 错误码是前端要 switch 的东西，所以这里每个都收成一个函数：
// 文案、状态码、字段名只写一处，改的时候不会漏。

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

function noContent(): Response {
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
}

function unauthorized(): Response {
  return json({ error: 'unauthorized' }, 401)
}

function forbidden(): Response {
  return json({ error: 'forbidden' }, 403)
}

function badRequest(message: string): Response {
  return json({ error: 'bad-request', message }, 400)
}

function methodNotAllowed(allow: string): Response {
  return new Response(JSON.stringify({ error: 'method-not-allowed' }), {
    status: 405,
    headers: { ...JSON_HEADERS, allow },
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  // 数组也是 object，这里要排除掉 —— 否则 { tools: [...] } 里的 tools 被当成对象会一路错下去
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ---------------------------------------------------------------- 读 body

type BodyResult = { ok: true; text: string } | { ok: false; message: string }

/**
 * 读请求体，顺便卡住 256KB。
 *
 * 先看 Content-Length 再读：声明就超了，连读都不用读，省下的内存和 CPU 是实打实的。
 * 但长度头可以撒谎、也可以没有，所以读完还要按真实字节再数一遍。
 * 用 TextEncoder 而不是 text.length：一个汉字在 UTF-8 里占 3 个字节、.length 只算 1，
 * 拿它当体积会把中文数据低估三倍。
 */
async function readBodyLimited(request: Request): Promise<BodyResult> {
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, message: '请求体 ' + Math.round(declared / 1024) + ' KB，超过上限 256 KB' }
  }

  const text = await request.text()
  const bytes = new TextEncoder().encode(text).length
  if (bytes > MAX_BODY_BYTES) {
    return { ok: false, message: '请求体 ' + Math.round(bytes / 1024) + ' KB，超过上限 256 KB' }
  }
  return { ok: true, text }
}

type JsonResult = { ok: true; value: unknown } | { ok: false; response: Response }

/**
 * 读 body + 解析 JSON，任何一步不成立都直接给出该回的那个 400。
 *
 * 空 body 当成 {}：POST /api/invites 的契约就是「body {}」，
 * 前端可能干脆不发 body，JSON.parse('') 会抛错，这里替它兜住。
 */
async function readJson(request: Request): Promise<JsonResult> {
  const body = await readBodyLimited(request)
  if (!body.ok) return { ok: false, response: badRequest(body.message) }
  if (body.text.trim() === '') return { ok: true, value: {} }
  try {
    return { ok: true, value: JSON.parse(body.text) }
  } catch {
    return { ok: false, response: badRequest('请求体不是合法的 JSON') }
  }
}

// ---------------------------------------------------------------- 快照数据校验
//
// 为什么要逐字段校验，而不是 JSON.parse 完直接存：
//   存进去的东西下次会被**原样返回给这台设备**。一份形状不对的数据一旦落库，
//   就会变成「每次同步回来都是坏的」，比拒收一次难受得多。
//   代价是这里多几十行，换来的是一个永远只有合法数据的数据源。
//
// 但校验只管「形状对不对」（是不是字符串、是不是数组），不管业务规则
// （比如「id 不能为空」）—— 业务规则变起来快，写死在服务端会变成客户端的枷锁。

type Validated<T> = { ok: true; value: T } | { ok: false; message: string }

/**
 * 取一个字符串字段：不存在（undefined / null）当作空串，类型不对返回 null 让调用方报 400。
 *
 * 两者区别对待的理由：字段缺席通常只是客户端版本旧一点，用空串填上就完了；
 * 而「字段是数字 / 对象」说明两边理解已经不一致，得当场暴露，不然会存进一份
 * 前端读不懂的数据。
 */
function readTextField(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key]
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value : null
}

/** 读一个字符串数组，顺便复制一份（不直接引用请求里的对象） */
function readStringList(raw: unknown, key: string): Validated<string[]> {
  if (!Array.isArray(raw)) return { ok: false, message: 'data.' + key + ' 必须是字符串数组' }

  const out: string[] = []
  for (let i = 0; i < raw.length; i += 1) {
    if (typeof raw[i] !== 'string') return { ok: false, message: 'data.' + key + '[' + i + '] 必须是字符串' }
    out.push(raw[i])
  }
  return { ok: true, value: out }
}

/** 校验并规整一份 SyncData。返回的对象只含契约里的字段，请求里混进来的杂物不会落库。 */
function readSyncData(raw: unknown): Validated<SyncData> {
  if (!isRecord(raw)) return { ok: false, message: 'data 必须是一个对象' }

  const tools = raw.tools
  if (!Array.isArray(tools)) return { ok: false, message: 'data.tools 必须是数组' }
  if (tools.length > MAX_TOOLS) {
    return { ok: false, message: '工具数量 ' + tools.length + ' 条，超过上限 ' + MAX_TOOLS + ' 条' }
  }

  const cleanTools: ToolRow[] = []
  for (let i = 0; i < tools.length; i += 1) {
    const item = tools[i]
    if (!isRecord(item)) return { ok: false, message: 'data.tools[' + i + '] 不是一个对象' }

    const id = readTextField(item, 'id')
    const name = readTextField(item, 'name')
    const url = readTextField(item, 'url')
    const description = readTextField(item, 'description')
    const category = readTextField(item, 'category')
    const icon = readTextField(item, 'icon')
    if (id === null || name === null || url === null || description === null || category === null || icon === null) {
      return { ok: false, message: 'data.tools[' + i + '] 的 id/name/url/description/category/icon 必须都是字符串' }
    }

    // 空字符串的 icon 等于「没设图标」：前端类型是 icon?: string，
    // 留着空串会让 <img src=""> 在部分浏览器里对整个页面再发一次请求，白白多一次 200。
    if (icon) cleanTools.push({ id, name, url, description, category, icon })
    else cleanTools.push({ id, name, url, description, category })
  }

  const groups = readStringList(raw.groups, 'groups')
  if (!groups.ok) return groups
  const favorites = readStringList(raw.favorites, 'favorites')
  if (!favorites.ok) return favorites
  const order = readStringList(raw.order, 'order')
  if (!order.ok) return order

  // appSettings 整个缺席时用空串兜底（前端会把空串转成「全部」分组）：
  // 这个字段只是「默认打开哪个分组」，缺了不影响数据正确性，没必要为它 400。
  const rawSettings = raw.appSettings
  if (rawSettings !== undefined && rawSettings !== null && !isRecord(rawSettings)) {
    return { ok: false, message: 'data.appSettings 必须是一个对象' }
  }
  const defaultCategory = isRecord(rawSettings) ? readTextField(rawSettings, 'defaultCategory') : ''
  if (defaultCategory === null) return { ok: false, message: 'data.appSettings.defaultCategory 必须是字符串' }

  return {
    ok: true,
    value: {
      tools: cleanTools,
      groups: groups.value,
      favorites: favorites.value,
      order: order.value,
      appSettings: { defaultCategory },
    },
  }
}

/** 校验 PUT 的整个请求体：{ baseRevision, data } */
function readPayload(raw: unknown): Validated<{ baseRevision: number; data: SyncData }> {
  if (!isRecord(raw)) return { ok: false, message: '请求体必须是一个 JSON 对象' }

  const baseRevision = raw.baseRevision
  if (typeof baseRevision !== 'number' || !Number.isInteger(baseRevision) || baseRevision < 0) {
    return { ok: false, message: 'baseRevision 必须是 0 或正整数' }
  }

  const data = readSyncData(raw.data)
  if (!data.ok) return data
  return { ok: true, value: { baseRevision, data: data.value } }
}

/**
 * 把库里存的 JSON 文本还原成 SyncData。
 *
 * 读出来也再校验一遍（而不是 JSON.parse 完直接返回）：库里的数据只可能来自
 * PUT 的校验，但「只可能」不等于「一定」。万一有人用 wrangler d1 execute 手改过、
 * 或者将来的版本写法不同，这里应当返回 null 让接口报错，而不是把半坏的数据
 * 推给设备 —— 那会把客户端的工具列表洗成残缺的。
 */
function parseStoredData(text: string): SyncData | null {
  try {
    const parsed = readSyncData(JSON.parse(text))
    return parsed.ok ? parsed.value : null
  } catch {
    return null
  }
}

/** 组装 409：把**当前用户**云端那一份一起带回去，客户端可以直接采用（约定「云端胜」） */
function conflict(row: SnapshotRow | null): Response {
  if (!row) return json({ error: 'conflict', snapshot: { revision: 0, updatedAt: 0, data: null } }, 409)

  return json(
    {
      error: 'conflict',
      snapshot: {
        revision: row.revision,
        updatedAt: row.updated_at,
        // 库里的数据坏到读不出来时给 null：宁可让客户端这次不同步，
        // 也不能让它拿一份残缺数据去覆盖本地。
        data: parseStoredData(row.data),
      },
    },
    409,
  )
}

// ---------------------------------------------------------------- 认证接口

/** 从 Authorization 头取身份；取不到就回 401 */
async function requireUser(request: Request, env: Env): Promise<{ user: User; tokenHash: string } | Response> {
  const identity = await authenticate(request, env.DB, Date.now())
  return identity ?? unauthorized()
}

function isResponse(value: unknown): value is Response {
  return value instanceof Response
}

/** 只有管理员能碰的接口（邀请码） */
async function requireAdmin(request: Request, env: Env): Promise<{ user: User; tokenHash: string } | Response> {
  const identity = await requireUser(request, env)
  if (isResponse(identity)) return identity
  // 已登录但不是管理员 → 403；没有身份 / 会话过期 → 上面的 401。
  // 分开是有意的：前端 401 时该跳登录页，403 时该提示「没有权限」。
  if (!identity.user.isAdmin) return forbidden()
  return identity
}

/**
 * POST /api/auth/register —— 邀请码注册。
 *
 * 顺序是「格式 → 查重名 → 占邀请码 → 建用户」，每一步都为了少浪费一次哈希或写库：
 *   ① 格式不对直接 400，不碰数据库；
 *   ② 重名先查出来 409：**不能用掉邀请码再报重名**，否则用户填了一个已被占的名字，
 *      手里那张码就白白作废了；
 *   ③ 占码是一步原子的 UPDATE ... WHERE used_by IS NULL，两个请求同时用同一个码时
 *      只有一个能改到行（changes = 1），另一个 changes = 0，直接 403，不会双开；
 *   ④ 最后把 used_by 补上，这张码从此作废。
 */
async function handleRegister(request: Request, env: Env): Promise<Response> {
  const payload = await readJson(request)
  if (!payload.ok) return payload.response
  if (!isRecord(payload.value)) return badRequest('请求体必须是一个 JSON 对象')

  const username = parseUsername(payload.value.username)
  if (!username) return badRequest('用户名需为 3-32 位，只能用字母、数字、下划线、连字符')

  const password = parsePassword(payload.value.password)
  if (!password) return badRequest('密码至少 8 位，最多 128 位')

  const rawInvite = payload.value.inviteCode
  const inviteCode = typeof rawInvite === 'string' ? rawInvite.trim() : ''
  // 邀请码格式不对 = 这个码必然不存在，按契约直接回 invalid-invite，
  // 不再单独造一个 400：前端只需要处理「码不能用」这一种结果。
  if (!inviteCode) return json({ error: 'invalid-invite' }, 403)

  const db = env.DB
  const now = Date.now()

  // users.username 上带了 COLLATE NOCASE（见 worker/schema.sql），所以这里的 =
  // 天然忽略大小写：EpiphanyMio 和 epiphanymio 会被当成同一个名字。
  const taken = await db.prepare('SELECT 1 AS x FROM users WHERE username = ?').bind(username).first<{ x: number }>()
  if (taken) return json({ error: 'username-taken' }, 409)

  const record = await hashPassword(password)

  // 占码：WHERE used_by IS NULL 保证同一个码只有一个请求能改到；
  // 租约条件让「占住之后进程挂了」的码在 2 分钟后能重新用，不会凭空锁死。
  const claimed = await db
    .prepare('UPDATE invites SET used_at = ? WHERE code = ? AND used_by IS NULL AND (used_at IS NULL OR used_at < ?)')
    .bind(now, inviteCode, now - INVITE_CLAIM_LEASE_MS)
    .run()
  if (claimed.meta.changes === 0) return json({ error: 'invalid-invite' }, 403)

  try {
    await db
      .prepare('INSERT INTO users (username, password_hash, salt, iterations, is_admin, created_at) VALUES (?, ?, ?, ?, 0, ?)')
      .bind(username, record.hash, record.salt, record.iterations, now)
      .run()
  } catch (error) {
    // 能走到这里的唯一可能：查重之后、插入之前，别人抢注了同名用户。
    // 把刚占住的邀请码放回去，否则用户平白丢一张码。
    // 放回失败也不能盖掉真正的错误（用户的码过期会自动恢复，这里吞掉就行）。
    await releaseInvite(db, inviteCode).catch(() => {})
    if (isUniqueViolation(error)) return json({ error: 'username-taken' }, 409)
    throw error
  }

  const created = await db
    .prepare('SELECT id AS id, username AS username FROM users WHERE username = ?')
    .bind(username)
    .first<{ id: number; username: string }>()
  if (!created) return json({ error: 'server-error', message: '用户写入后读不回来' }, 500)

  await db
    .prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL')
    .bind(Number(created.id), now, inviteCode)
    .run()

  const token = await createSession(db, Number(created.id), now)
  return json({ token, user: { id: Number(created.id), username: created.username, isAdmin: false } }, 201)
}

/**
 * POST /api/auth/login。
 *
 * 用户名不存在和密码错**都**回 401 invalid-credentials：分开回等于给了攻击者
 * 一个「这个用户名存在」的探测器，接下来只需要专心猜密码。
 */
async function handleLogin(request: Request, env: Env): Promise<Response> {
  const payload = await readJson(request)
  if (!payload.ok) return payload.response
  if (!isRecord(payload.value)) return badRequest('请求体必须是一个 JSON 对象')

  const rawUsername = payload.value.username
  const rawPassword = payload.value.password
  // 登录只要求「有值」，不套注册时的格式规则：
  // 将来要是放宽过用户名规则，老用户还能照常登录。
  if (typeof rawUsername !== 'string' || rawUsername.trim() === '') return badRequest('缺少用户名')
  if (typeof rawPassword !== 'string' || rawPassword === '') return badRequest('缺少密码')

  const db = env.DB
  const now = Date.now()

  const row = await db
    .prepare(
      'SELECT id AS id, username AS username, password_hash AS passwordHash, salt AS salt, iterations AS iterations, is_admin AS isAdmin ' +
        'FROM users WHERE username = ?',
    )
    .bind(rawUsername.trim())
    .first<UserPasswordRow>()

  if (!row) {
    // 查无此人也要照样算一次哈希：否则这条路径比「密码错」快几十毫秒，
    // 响应时间本身就把用户名泄露了，401 只回一个错误码的努力也就白费。
    await verifyPassword(rawPassword, DUMMY_PASSWORD_RECORD)
    return json({ error: 'invalid-credentials' }, 401)
  }

  const ok = await verifyPassword(rawPassword, {
    hash: row.passwordHash,
    salt: row.salt,
    iterations: Number(row.iterations),
  })
  if (!ok) return json({ error: 'invalid-credentials' }, 401)

  // 顺手清掉所有过期会话：sessions 表只增不减的话，几年后就是一堆没人认领的行
  await db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now).run()

  const token = await createSession(db, Number(row.id), now)
  return json({
    token,
    user: { id: Number(row.id), username: row.username, isAdmin: Number(row.isAdmin) === 1 },
  })
}

/** POST /api/auth/logout —— 删掉这条会话，之后这个令牌就再也换不到身份了 */
async function handleLogout(request: Request, env: Env): Promise<Response> {
  const identity = await requireUser(request, env)
  if (isResponse(identity)) return identity
  await destroySession(env.DB, identity.tokenHash)
  return noContent()
}

/** GET /api/auth/me —— 前端刷新页面时用它确认「我还登着吗」 */
async function handleMe(request: Request, env: Env): Promise<Response> {
  const identity = await requireUser(request, env)
  if (isResponse(identity)) return identity
  return json({ user: identity.user })
}

// ---------------------------------------------------------------- 邀请码
//
// 邀请码是这个站唯一的注册入口：没有它谁都注册不了，所以它同时也是
// 「谁能用这个服务」的闸门。管理员的身份写在 users.is_admin 里。

/** 生成 12 位 [A-Z0-9] 的邀请码 */
function generateInviteCode(): string {
  const bytes = new Uint8Array(INVITE_LENGTH)
  crypto.getRandomValues(bytes)
  let out = ''
  for (let i = 0; i < bytes.length; i += 1) {
    // 62 个字符取模 36 会有极小的偏斜（前 4 个字符概率略高），
    // 邀请码只需要「猜不到」，不需要密码学上的均匀分布，这点偏斜无所谓
    out += INVITE_ALPHABET[bytes[i] % INVITE_ALPHABET.length]
  }
  return out
}

/**
 * GET /api/invites —— 邀请码列表，按创建时间倒序。
 *
 * usedAt 只在「真的有人用掉」时才给值：占码是两段式（先写 used_at、建完用户再补 used_by），
 * 中间那一小段 used_by 是空的，对外要看起来和没被用一样，否则管理员会看到
 * 一堆「用了但不知道谁用的」记录。
 */
async function handleListInvites(request: Request, env: Env): Promise<Response> {
  const identity = await requireAdmin(request, env)
  if (isResponse(identity)) return identity

  const rows = await env.DB
    .prepare(
      'SELECT i.code AS code, i.created_at AS createdAt, i.used_at AS usedAt, u.username AS usedBy ' +
        'FROM invites i LEFT JOIN users u ON u.id = i.used_by ORDER BY i.created_at DESC, i.code ASC',
    )
    .all<InviteRow>()

  const invites = rows.results.map((row) => ({
    code: row.code,
    createdAt: Number(row.createdAt),
    usedBy: row.usedBy ?? null,
    usedAt: row.usedBy ? Number(row.usedAt) : null,
  }))
  return json({ invites })
}

/**
 * POST /api/invites —— 建邀请码。body {} 用服务端生成的，body { code } 用自定义的。
 *
 * 自定义时回 409 code-taken（契约里没写这一个，但重复的码必须有个说法；
 * 前端按「非 201 就是失败」处理即可）。
 */
async function handleCreateInvite(request: Request, env: Env): Promise<Response> {
  const identity = await requireAdmin(request, env)
  if (isResponse(identity)) return identity

  const payload = await readJson(request)
  if (!payload.ok) return payload.response
  const body: Record<string, unknown> = isRecord(payload.value) ? payload.value : {}

  const db = env.DB
  const now = Date.now()
  const custom = body.code

  if (custom !== undefined && custom !== null && custom !== '') {
    if (typeof custom !== 'string' || !INVITE_CODE_RE.test(custom.trim())) {
      return badRequest('邀请码需为 6-32 位，只能用字母、数字、连字符')
    }
    const code = custom.trim()
    const exists = await db.prepare('SELECT 1 AS x FROM invites WHERE code = ?').bind(code).first<{ x: number }>()
    // message 是给界面直接显示用的：前端对没见过的 error 码会吃掉 message，没有它只能显示"服务器返回 409"
    if (exists) return json({ error: 'code-taken', message: '这个邀请码已经存在了，换一个吧' }, 409)
    await db
      .prepare('INSERT INTO invites (code, created_by, created_at, used_by, used_at) VALUES (?, ?, ?, NULL, NULL)')
      .bind(code, identity.user.id, now)
      .run()
    return json({ code }, 201)
  }

  // 自动生成：36^12 的取值空间里撞车概率极低，但「极低」不是「没有」，
  // INSERT OR IGNORE + changes 判断让撞车变成「换一个再试」，而不是 500。
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateInviteCode()
    const inserted = await db
      .prepare('INSERT OR IGNORE INTO invites (code, created_by, created_at, used_by, used_at) VALUES (?, ?, ?, NULL, NULL)')
      .bind(code, identity.user.id, now)
      .run()
    if (inserted.meta.changes > 0) return json({ code }, 201)
  }
  return json({ error: 'server-error', message: '生成邀请码失败，请重试' }, 500)
}

/** DELETE /api/invites/{code} —— 作废一张还没用掉的码；已经用掉的也可以删，历史记录不留 */
async function handleDeleteInvite(request: Request, env: Env, code: string): Promise<Response> {
  const identity = await requireAdmin(request, env)
  if (isResponse(identity)) return identity

  const deleted = await env.DB.prepare('DELETE FROM invites WHERE code = ?').bind(code).run()
  if (deleted.meta.changes === 0) return json({ error: 'not-found' }, 404)
  return noContent()
}

/** 把占住但没能用掉的邀请码放回去（只有 username-taken 这一条路会走到） */
async function releaseInvite(db: D1Database, code: string): Promise<void> {
  await db.prepare('UPDATE invites SET used_at = NULL WHERE code = ? AND used_by IS NULL').bind(code).run()
}

/** D1 / SQLite 的唯一约束报错长这样：UNIQUE constraint failed: users.username */
function isUniqueViolation(error: unknown): boolean {
  return /UNIQUE constraint failed/i.test(String(error))
}

// ---------------------------------------------------------------- 快照接口
//
// 每条查询都带 user_id：**隔离就是这几处 WHERE**。
// 只要有一处漏了，用户 A 读到的就是用户 B 的数据，而且这种错不会报异常，
// 只会「数据看起来不太对」。所以这两个函数里出现 snapshot 表的地方，一律先 bind user_id。

/** GET /api/snapshot —— 拉当前用户自己的快照。没存过时返回 revision: 0 / data: null。 */
async function handleGetSnapshot(request: Request, env: Env): Promise<Response> {
  // ① 先鉴权：没身份的请求连库都不该查
  const identity = await requireUser(request, env)
  if (isResponse(identity)) return identity

  const row = await env.DB
    .prepare('SELECT revision AS revision, updated_at AS updated_at, data AS data FROM snapshot WHERE user_id = ?')
    .bind(identity.user.id)
    .first<SnapshotRow>()

  // 空云端不是 404：客户端靠 revision === 0 判断「我这份就是第一版，推上去」
  if (!row) return json({ revision: 0, updatedAt: 0, data: null })

  const data = parseStoredData(row.data)
  if (!data) return json({ error: 'server-error', message: '云端数据已损坏，无法解析' }, 500)

  return json({ revision: Number(row.revision), updatedAt: Number(row.updated_at), data })
}

/** PUT /api/snapshot —— 整包覆盖写入，baseRevision 当乐观锁。 */
async function handlePutSnapshot(request: Request, env: Env): Promise<Response> {
  // ① 鉴权必须在解析 body 之前：解析等于是替陌生人干活
  const identity = await requireUser(request, env)
  if (isResponse(identity)) return identity

  // ② 读 body（顺带卡体积）
  const body = await readBodyLimited(request)
  if (!body.ok) return badRequest(body.message)

  // ③ 解析 JSON
  let raw: unknown
  try {
    raw = JSON.parse(body.text)
  } catch {
    return badRequest('请求体不是合法的 JSON')
  }

  // ④ 校验形状
  const payload = readPayload(raw)
  if (!payload.ok) return badRequest(payload.message)

  const userId = identity.user.id
  const { baseRevision, data } = payload.value
  const now = Date.now()
  const serialized = JSON.stringify(data)
  const db = env.DB

  const readRow = async (): Promise<SnapshotRow | null> => {
    const row = await db
      .prepare('SELECT revision AS revision, updated_at AS updated_at, data AS data FROM snapshot WHERE user_id = ?')
      .bind(userId)
      .first<SnapshotRow>()
    return row ?? null
  }

  // ⑤ 先看这个用户有没有行：第一次写入是 INSERT，之后才是带乐观锁的 UPDATE
  const current = await readRow()

  if (!current) {
    // 云端是空的。只有 baseRevision === 0 才允许写：
    // 客户端手里拿着大于 0 的版本号却面对一个空云端（数据库被重置过），
    // 直接让它写会让两台设备的版本号从此错位，所以照样判冲突。
    if (baseRevision !== 0) return conflict(null)

    // INSERT OR IGNORE + 看 changes：两个请求同时「第一次写」时，
    // 后到的那个主键撞车、changes 为 0，于是也走冲突分支，不会把先到的那份覆盖掉。
    const inserted = await db
      .prepare('INSERT OR IGNORE INTO snapshot (user_id, revision, updated_at, data) VALUES (?, 1, ?, ?)')
      .bind(userId, now, serialized)
      .run()

    if (inserted.meta.changes === 0) return conflict(await readRow())
    return json({ revision: 1, updatedAt: now })
  }

  // ⑥ 真正的乐观锁：revision 不是我以为的那一版，这条 UPDATE 就一行都改不到
  const updated = await db
    .prepare('UPDATE snapshot SET revision = revision + 1, updated_at = ?, data = ? WHERE user_id = ? AND revision = ?')
    .bind(now, serialized, userId, baseRevision)
    .run()

  if (updated.meta.changes === 0) {
    // 冲突：重新读一次（而不是用上面那个 current）——从读到写之间别的设备可能又改了，
    // 要回的是此刻最新的那份，客户端拿它覆盖本地才不会倒退一个版本。
    return conflict(await readRow())
  }

  return json({ revision: baseRevision + 1, updatedAt: now })
}

// ---------------------------------------------------------------- 文件管理（云端）
//
// 数据分两处存：文件内容进 R2（key = u/{userId}/{nodeId}），目录树进 D1 的
// file_nodes / file_usage / file_shares（见 worker/schema.sql）。
// 为什么不塞进上面那个 snapshot：快照是整包覆盖、上限 256KB，几百个文件的目录树就装不下；
// 而且改一个文件名要重传整包，两台设备同时改必然互相覆盖。拆成「每人一批节点行」之后，
// 每次只动自己那一行，冲突面小得多。
//
// 这段代码里所有文件接口的共同要求：
//   ① **先鉴权再碰 body**：上传接口的 body 可能是 50MB，没身份就不该开始收流。
//   ② 每条查询都带 user_id：跨账号一律 404（而不是 403），不让人拿 id 探测别人有没有这个文件。
//   ③ 内容下载一律 nosniff；只有白名单类型允许 inline，其余强制 attachment（防 XSS）。
//   ④ R2 绑定可能不存在（本地开发 / 旧配置），缺了就回 503 storage-not-configured，
//      而不是抛异常把整个 Worker 打挂 —— 工具清单、账号、快照这些功能不该受牵连。

/** 类型白名单之外的东西：改 MIME 参数、转小写，只留基础类型 */
function normalizeMime(raw: string): string {
  // 只取第一个分号之前的部分（'text/plain;charset=utf-8' → 'text/plain'）。
  // 不写完整的 MIME 解析器：白名单比较只需要基础类型。
  return raw.split(';')[0].trim().toLowerCase()
}

/** R2 里的 key。带上 userId 的好处：将来「按用户清理」不用扫全桶，也不会和别人撞 key。 */
function fileKey(userId: number, nodeId: string): string {
  return 'u/' + userId + '/' + nodeId
}

/** D1 不支持数组展开成占位符，只能按个数自己拼 '(?, ?, ?)' */
function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ')
}

// D1 单条 SQL 最多 100 个绑定参数（官方限制，超了整个请求直接报错）。
// 删除一次最多 200 个 id，IN 列表必须切开：80 个 id + user_id（+ now）也还在 100 以内。
const MAX_IN_PARAMS = 80

/** 把 id 列表切成若干块，配合 IN (...) 使用 */
function chunkIds(ids: string[], size: number): string[][] {
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size))
  return chunks
}

/** 从路径里取出并校验 id；格式不对当作「这条路径不存在」 */
function readPathId(path: string, prefix: string): string | null {
  let raw = ''
  try {
    // 路径里的 id 可能被 URL 编码过（%2D 之类），先解回来再判断
    raw = decodeURIComponent(path.slice(prefix.length))
  } catch {
    return null
  }
  return NODE_ID_RE.test(raw) ? raw : null
}

function storageNotConfigured(): Response {
  return json({ error: 'storage-not-configured', message: '云存储未配置（缺少 R2 绑定）' }, 503)
}

function lengthRequired(): Response {
  return json({ error: 'length-required', message: '上传必须带 Content-Length 头' }, 411)
}

function payloadTooLarge(): Response {
  return json({ error: 'payload-too-large', message: '单个文件不能超过 50 MB' }, 413)
}

function quotaExceeded(): Response {
  return json({ error: 'quota-exceeded', message: '账号空间不足（上限 500 MB）' }, 413)
}

/**
 * 把文件名编码成 Content-Disposition 里 filename* 的值。
 *
 * 标准写法是 RFC 5987 的 ext-value（`UTF-8''<百分号编码>`），但 encodeURIComponent
 * 会原样留下 ' ( ) * —— 这几个字符不在 attr-char 允许集里，遇到严格实现的浏览器
 * 可能把文件名解析错。这里把它们补编码掉，其余交给 encodeURIComponent。
 * 名字本身已经在校验里排除了控制字符，所以这里不存在往响应头里注入换行的可能。
 */
function encodeHeaderFilename(name: string): string {
  return encodeURIComponent(name).replace(/['()*]/g, (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase())
}

/**
 * 下载响应的公共头：类型白名单决定 inline / attachment。
 *
 * 为什么白名单在**响应**这一侧判，而不是上传时就把类型改掉：
 * 库里的 mime 是客户端写的，任何时候都不能直接信；每次返回前重新过一遍白名单，
 * 才能保证「以后新增一种危险类型」不会从旧数据里漏出来。
 */
function downloadHeaders(mime: string, name: string): Record<string, string> {
  const base = normalizeMime(mime)
  const inline = base !== '' && INLINE_MIME_TYPES.has(base)
  return {
    'content-type': inline ? base : 'application/octet-stream',
    // 中文文件名走 RFC 5987 的 filename* 形式；filename="download" 是给老浏览器的兜底。
    // 不用原名做 ASCII 回退：原名里可能有引号、分号，拼进头里就变成注入点了。
    'content-disposition': (inline ? 'inline' : 'attachment') + '; filename="download"; filename*=UTF-8\'\'' + encodeHeaderFilename(name),
    // 不管什么类型都加 nosniff：禁止浏览器把 octet-stream 猜成 HTML。
    'x-content-type-options': 'nosniff',
    // 文件内容只属于某个账号或某个分享，不放进任何共享缓存
    'cache-control': 'no-store',
  }
}

/** 读用户已用字节数；没有记录就是 0（从没上传过） */
async function readUsedBytes(db: D1Database, userId: number): Promise<number> {
  const row = await db.prepare('SELECT bytes AS bytes FROM file_usage WHERE user_id = ?').bind(userId).first<{ bytes: number }>()
  return row ? Math.max(0, Number(row.bytes)) : 0
}

/**
 * 生成一条「改用量」的语句（delta 可正可负）。
 *
 * 用 INSERT ... ON CONFLICT 一条语句同时覆盖两种情况：第一次上传时插入，
 * 之后在原值上累加。MAX(0, ...) 是删除侧的保护：库里的计数和实际文件万一错位，
 * 也不该出现负数（负的 used 会让配额检查永远通过）。
 */
function usageStatement(db: D1Database, userId: number, delta: number, now: number): D1PreparedStatement {
  return db
    .prepare(
      'INSERT INTO file_usage (user_id, bytes, updated_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(user_id) DO UPDATE SET bytes = MAX(0, file_usage.bytes + ?), updated_at = excluded.updated_at',
    )
    .bind(userId, Math.max(0, delta), now, delta)
}

/**
 * 取 R2 put 返回对象里的真实字节数。
 *
 * worker/r2.ts 把返回值写成了 unknown（用不到别的字段，不值得为一个类型拉 workers-types），
 * 这里就地收窄。为什么不用客户端的 Content-Length 了事：长度头可以撒谎，
 * 而配额和库里的 size 都该按真实字节算。
 */
function readR2ObjectSize(result: unknown, fallback: number): number {
  if (typeof result === 'object' && result !== null && 'size' in result) {
    const size = (result as { size?: unknown }).size
    if (typeof size === 'number' && Number.isFinite(size) && size >= 0) return size
  }
  return fallback
}

/** 校验一条客户端推上来的节点。deleted / updatedAt 不接受客户端传（墓碑只能由删除接口写）。 */
function readFileNode(raw: unknown, index: number): Validated<FileNodePayload> {
  const where = 'nodes[' + index + ']'
  if (!isRecord(raw)) return { ok: false, message: where + ' 不是一个对象' }

  const id = raw.id
  if (typeof id !== 'string' || !NODE_ID_RE.test(id)) {
    return { ok: false, message: where + '.id 不合法（只允许字母、数字、下划线、连字符，1-64 位）' }
  }

  const parentId = readTextField(raw, 'parentId')
  if (parentId === null) return { ok: false, message: where + '.parentId 必须是字符串' }
  if (parentId !== '' && !NODE_ID_RE.test(parentId)) {
    return { ok: false, message: where + '.parentId 不合法（空串表示根目录）' }
  }
  if (parentId === id) return { ok: false, message: where + ' 不能以自己为父目录' }

  const name = readTextField(raw, 'name')
  if (name === null) return { ok: false, message: where + '.name 必须是字符串' }
  // trim 之后为空的名字在界面上就是一个看不见的条目，直接拒收
  if (name.trim() === '' || !FILE_NAME_RE.test(name)) {
    return { ok: false, message: where + '.name 不合法（1-255 位，不能含斜杠或控制字符）' }
  }

  const kind = raw.kind
  if (kind !== 'file' && kind !== 'folder') return { ok: false, message: where + '.kind 只能是 file 或 folder' }

  const size = raw.size
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 0 || size > MAX_FILE_BYTES) {
    return { ok: false, message: where + '.size 必须是 0 到 ' + MAX_FILE_BYTES + ' 之间的整数' }
  }

  const rawMime = readTextField(raw, 'mime')
  if (rawMime === null) return { ok: false, message: where + '.mime 必须是字符串' }
  const mime = normalizeMime(rawMime)
  if (mime.length > MIME_MAX || !MIME_RE.test(mime)) {
    return { ok: false, message: where + '.mime 不是合法的 MIME 类型' }
  }

  // 文件夹的大小恒为 0（schema 里也是这么注释的）：前端传什么都归零，
  // 免得一条「文件夹占 3MB」的脏数据把用量算歪。
  return { ok: true, value: { id, parentId, name, kind, size: kind === 'folder' ? 0 : size, mime } }
}

/** 校验 POST /api/files/nodes 的整个请求体 */
function readFileNodes(raw: unknown): Validated<FileNodePayload[]> {
  if (!isRecord(raw)) return { ok: false, message: '请求体必须是一个 JSON 对象' }

  const list = raw.nodes
  if (!Array.isArray(list)) return { ok: false, message: 'nodes 必须是数组' }
  if (list.length > MAX_FILE_BATCH) {
    return { ok: false, message: '一次最多推送 ' + MAX_FILE_BATCH + ' 个节点，这次有 ' + list.length + ' 个' }
  }

  const out: FileNodePayload[] = []
  for (let i = 0; i < list.length; i += 1) {
    const node = readFileNode(list[i], i)
    if (!node.ok) return node
    out.push(node.value)
  }
  return { ok: true, value: out }
}

/** 校验 POST /api/files/delete 的 { ids }，顺手去重（删整棵子树时父子 id 都会在列表里） */
function readDeleteIds(raw: unknown): Validated<string[]> {
  if (!isRecord(raw)) return { ok: false, message: '请求体必须是一个 JSON 对象' }

  const list = raw.ids
  if (!Array.isArray(list)) return { ok: false, message: 'ids 必须是数组' }
  if (list.length > MAX_FILE_BATCH) {
    return { ok: false, message: '一次最多删除 ' + MAX_FILE_BATCH + ' 个节点，这次有 ' + list.length + ' 个' }
  }

  const seen = new Set<string>()
  const out: string[] = []
  for (let i = 0; i < list.length; i += 1) {
    const id = list[i]
    if (typeof id !== 'string' || !NODE_ID_RE.test(id)) {
      return { ok: false, message: 'ids[' + i + '] 不合法' }
    }
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return { ok: true, value: out }
}

/** 生成 32 位 hex 分享 token（每字节两位 hex） */
function generateShareToken(): string {
  const bytes = new Uint8Array(SHARE_TOKEN_BYTES)
  crypto.getRandomValues(bytes)
  let out = ''
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0')
  }
  return out
}

/**
 * GET /api/files/tree —— 拉当前用户的完整目录树。
 *
 * 墓碑（deleted = 1）也要返回：另一台设备删掉的东西，本机下次拉树时必须知道
 * 「它没了」，否则会把本地那份当成本地新增又传回来，删了又活。
 */
async function handleFileTree(request: Request, env: Env): Promise<Response> {
  const identity = await requireUser(request, env)
  if (isResponse(identity)) return identity

  const rows = await env.DB
    .prepare(
      'SELECT id AS id, parent_id AS parentId, name AS name, kind AS kind, size AS size, mime AS mime, deleted AS deleted, updated_at AS updatedAt ' +
        // 按更新时间倒序取最新的 5000 行：真的超过上限时，最近改动（以及新传的文件）
        // 不能掉在截断线外，否则表现成「新文件同步不上」。超限本身是契约给定的事实。
        'FROM file_nodes WHERE user_id = ? ORDER BY updated_at DESC, id ASC LIMIT ?',
    )
    .bind(identity.user.id, MAX_TREE_ROWS)
    .all<CloudNodeRow>()

  const nodes: CloudNode[] = rows.results.map((row) => ({
    id: row.id,
    parentId: row.parentId,
    name: row.name,
    kind: row.kind === 'folder' ? 'folder' : 'file',
    size: Number(row.size),
    mime: row.mime,
    deleted: Number(row.deleted) === 1,
    updatedAt: Number(row.updatedAt),
  }))
  return json({ nodes })
}

/**
 * POST /api/files/nodes —— 批量推送节点（新建 / 改名 / 移动都走这条）。
 *
 * 冲突时**不更新 size**：size 只由内容上传接口写。客户端在上传内容之前
 * 只能报一个自己猜的大小，如果这里也改 size，客户端就可以用一条节点请求
 * 随便改大小（谎报 / 抵消配额），而内容其实没传。
 *
 * updated_at 一律用服务端 Date.now()：两台设备的时钟不可比，客户端传时间戳
 * 只会让「谁更新」变得不可判断。
 *
 * 冲突时把 deleted 置回 0：一条节点请求的语义就是「这一条现在是活的」。
 * 墓碑只用来告诉**别的设备**「它没了」；如果本机还有 pending 的改名 / 移动操作，
 * 按「本地改动优先」的约定就该把它重新顶成活的，而不是让客户端永远删不掉。
 */
async function handlePushNodes(request: Request, env: Env): Promise<Response> {
  // ① 先鉴权，再读 body
  const identity = await requireUser(request, env)
  if (isResponse(identity)) return identity

  const payload = await readJson(request)
  if (!payload.ok) return payload.response
  const parsed = readFileNodes(payload.value)
  if (!parsed.ok) return badRequest(parsed.message)
  const nodes = parsed.value
  if (nodes.length === 0) return json({ ok: true })

  const db = env.DB
  const userId = identity.user.id
  const now = Date.now()

  // 一次 batch 提交：要么整批都进库，要么一条都不进，不会留下半批数据。
  // ON CONFLICT 的 DO UPDATE 里故意没有 size —— 见上面函数注释。
  const statements = nodes.map((node) =>
    db
      .prepare(
        'INSERT INTO file_nodes (user_id, id, parent_id, name, kind, size, mime, deleted, updated_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?) ' +
          'ON CONFLICT(user_id, id) DO UPDATE SET ' +
          'parent_id = excluded.parent_id, name = excluded.name, kind = excluded.kind, ' +
          'mime = excluded.mime, deleted = 0, updated_at = excluded.updated_at',
      )
      .bind(userId, node.id, node.parentId, node.name, node.kind, node.size, node.mime, now),
  )
  await db.batch(statements)
  return json({ ok: true })
}

/**
 * POST /api/files/delete —— 删一批节点（客户端会把整棵子树的 id 一起发上来）。
 *
 * 删除不是真删，而是「墓碑 + 撤销分享 + 删 R2 对象 + 配额减回去」：
 *   ① 墓碑让别的设备下次拉树时知道这条没了；
 *   ② 分享链接必须一起撤销，否则删掉的文件还能被公开链接读到；
 *   ③ R2 对象要删，不然内容会一直占着桶；
 *   ④ 配额按实际删掉的字节减回去（MAX(0, bytes - n)），否则删完再传会撞配额上限。
 */
async function handleDeleteFiles(request: Request, env: Env): Promise<Response> {
  const identity = await requireUser(request, env)
  if (isResponse(identity)) return identity

  const payload = await readJson(request)
  if (!payload.ok) return payload.response
  const parsed = readDeleteIds(payload.value)
  if (!parsed.ok) return badRequest(parsed.message)
  const ids = parsed.value
  if (ids.length === 0) return json({ ok: true, deleted: 0 })

  const db = env.DB
  const userId = identity.user.id

  // 先查这一批里**还活着**的节点：不存在的 id（已经删过）不该重复减配额，
  // 也不该出现在 deleted 计数里。按 MAX_IN_PARAMS 分块查，避开 D1 的参数上限。
  const alive: { id: string; kind: string; size: number }[] = []
  for (const chunk of chunkIds(ids, MAX_IN_PARAMS)) {
    const rows = await db
      .prepare(
        'SELECT id AS id, kind AS kind, size AS size FROM file_nodes ' +
          'WHERE user_id = ? AND deleted = 0 AND id IN (' + placeholders(chunk.length) + ')',
      )
      .bind(userId, ...chunk)
      .all<{ id: string; kind: string; size: number }>()
    alive.push(...rows.results)
  }

  const now = Date.now()
  const statements: D1PreparedStatement[] = []
  const fileIds: string[] = []
  let freedBytes = 0
  for (const row of alive) {
    if (row.kind !== 'file') continue
    fileIds.push(row.id)
    // 退多少字节以 R2 对象的真实大小为准，而不是库里的 size：
    // 库里的 size 可能是客户端在内容传上来之前报的「猜测值」，
    // 拿它减会让配额越删越少（减多了还会把别的文件的空间一起吃掉）。
    try {
      const meta = env.FILES ? await env.FILES.head(fileKey(userId, row.id)) : null
      freedBytes += meta ? Math.max(0, meta.size) : 0
    } catch (error) {
      // 读不到元数据就退回库里的大小：宁可少退一点，也不能让 quota 卡死
      console.error('[bettertools] 读 R2 对象大小失败：', row.id, error)
      freedBytes += Math.max(0, Number(row.size))
    }
  }

  // 墓碑按块一条 UPDATE 写完（同一块里的 updated_at 用同一个 now，本来也该一样）：
  // 200 个 id 就是 3 条语句，而不是 200 条，batch 的体积小得多。
  for (const chunk of chunkIds(alive.map((row) => row.id), MAX_IN_PARAMS)) {
    statements.push(
      db
        .prepare(
          'UPDATE file_nodes SET deleted = 1, updated_at = ? ' +
            'WHERE user_id = ? AND deleted = 0 AND id IN (' + placeholders(chunk.length) + ')',
        )
        .bind(now, userId, ...chunk),
    )
  }

  // 撤分享对**请求里的所有 id** 都做（不只看活着的）：万一库里的状态曾经错位过，
  // 这一步也能把残留的公开链接一并关掉。和写墓碑放在同一个 batch 里，
  // 避免出现「墓碑写了、分享还没撤」的中间态。
  for (const chunk of chunkIds(ids, MAX_IN_PARAMS)) {
    statements.push(
      db
        .prepare(
          'UPDATE file_shares SET revoked = 1 ' +
            'WHERE user_id = ? AND revoked = 0 AND node_id IN (' + placeholders(chunk.length) + ')',
        )
        .bind(userId, ...chunk),
    )
  }
  if (freedBytes > 0) statements.push(usageStatement(db, userId, -freedBytes, now))

  // ids 非空时这里至少有「撤分享」的语句，batch 不会是空数组
  await db.batch(statements)

  // R2 的删除放在 D1 提交之后：墓碑已经生效，即使这里失败也只是留一个读不到的
  // 垃圾对象；反过来先删 R2 再写墓碑，中途失败就会出现「目录里还在、内容没了」。
  // 单条失败只记日志、不把整个请求判失败 —— 否则客户端会重试，而墓碑已经写过了。
  const bucket = env.FILES
  if (bucket) {
    await Promise.all(
      fileIds.map(async (id) => {
        try {
          await bucket.delete(fileKey(userId, id))
        } catch (error) {
          console.error('[bettertools] 删除 R2 对象失败：', id, error)
        }
      }),
    )
  }

  return json({ ok: true, deleted: alive.length })
}

/**
 * PUT /api/files/content/{id} —— 上传（或重传）文件内容。
 *
 * 检查顺序是有意的：鉴权 → R2 绑定 → Content-Length → 节点归属 → 配额 → 才收流。
 * 每一步都在「开始收 50MB 数据」之前完成，避免替一个注定失败的请求白干活。
 *
 * 配额按 **delta**（新长度 - 旧 size）算，而不是「新长度直接加上去」：
 * 重传同一个文件时旧大小已经算在 used 里了，只该补差额；换成一个更小的文件时
 * delta 是负数，对应地会把空间退回去。
 */
async function handlePutFileContent(request: Request, env: Env, nodeId: string): Promise<Response> {
  // ① 先鉴权：没身份就不该让我们开始收流
  const identity = await requireUser(request, env)
  if (isResponse(identity)) return identity

  const bucket = env.FILES
  if (!bucket) return storageNotConfigured()

  // ② Content-Length 必须有：没有它就没法在上传前判断大小，
  //    等收完 50MB 再说「太大」等于白烧一次 Worker 的内存和流量。
  //    注意不能写成 Number(header ?? '')：Number('') === 0，缺头会被误当成空文件。
  const rawLength = request.headers.get('content-length')
  if (rawLength === null) return lengthRequired()
  const declared = Number(rawLength)
  if (!Number.isInteger(declared) || declared < 0) return badRequest('Content-Length 不合法')
  if (declared > MAX_FILE_BYTES) return payloadTooLarge()

  const db = env.DB
  const userId = identity.user.id

  // ③ 跨账号 / 已删除 / 文件夹一律 404：不区分「不存在」和「不是你的」，
  //    避免这个接口变成探测别人 node id 是否存在的工具。
  const node = await db
    .prepare('SELECT kind AS kind, mime AS mime FROM file_nodes WHERE user_id = ? AND id = ? AND deleted = 0')
    .bind(userId, nodeId)
    .first<{ kind: string; mime: string }>()
  if (!node || node.kind !== 'file') return json({ error: 'not-found' }, 404)

  const now = Date.now()
  const key = fileKey(userId, nodeId)

  // 旧内容占了多少字节，以 R2 里的对象为准 —— **不能信库里的 node.size**：
  // 客户端在传内容之前会先推一份「猜测的大小」用于列表显示，拿它算 delta 的话，
  // 第一次上传会得到负的增量，配额永远记成 0（库里的 size 和实际占用会脱节）。
  const existing = await bucket.head(key)
  const oldSize = existing ? Math.max(0, existing.size) : 0

  const used = await readUsedBytes(db, userId)
  if (declared - oldSize > 0 && used + (declared - oldSize) > USER_QUOTA_BYTES) return quotaExceeded()

  // request.body 是 ReadableStream，直接交给 R2：50MB 的文件不会在 Worker 内存里堆成一整块。
  const written = await bucket.put(key, request.body ?? new ArrayBuffer(0), {
    httpMetadata: { contentType: normalizeMime(node.mime) || 'application/octet-stream' },
  })

  // ④ 再按 R2 记的真实大小复核一次：Content-Length 可以撒谎（声明 1KB 实际 40MB）。
  //    走到这里说明客户端在骗人，宁可把这对象删掉、让这次上传失败，也不能让配额被绕过。
  const storedSize = readR2ObjectSize(written, declared)
  if (storedSize > MAX_FILE_BYTES) {
    await bucket.delete(key).catch(() => {})
    return payloadTooLarge()
  }
  const delta = storedSize - oldSize
  if (delta > 0 && used + delta > USER_QUOTA_BYTES) {
    await bucket.delete(key).catch(() => {})
    return quotaExceeded()
  }

  // ⑤ 节点大小和用量在同一个 batch 里更新，不会出现「大小写进去了、用量没加」的错位。
  await db.batch([
    db
      .prepare('UPDATE file_nodes SET size = ?, updated_at = ? WHERE user_id = ? AND id = ? AND deleted = 0')
      .bind(storedSize, now, userId, nodeId),
    usageStatement(db, userId, delta, now),
  ])

  return json({ ok: true, size: storedSize })
}

/** GET /api/files/content/{id} —— 私有下载，只有文件所属账号能读 */
async function handleGetFileContent(request: Request, env: Env, nodeId: string): Promise<Response> {
  const identity = await requireUser(request, env)
  if (isResponse(identity)) return identity

  const bucket = env.FILES
  if (!bucket) return storageNotConfigured()

  const userId = identity.user.id
  const node = await env.DB
    .prepare('SELECT name AS name, mime AS mime FROM file_nodes WHERE user_id = ? AND id = ? AND deleted = 0 AND kind = ?')
    .bind(userId, nodeId, 'file')
    .first<{ name: string; mime: string }>()
  if (!node) return json({ error: 'not-found' }, 404)

  const object = await bucket.get(fileKey(userId, nodeId))
  // 目录里有这条、R2 里没有（内容还没传上来 / 传失败了）也按 404 处理：
  // 「元数据存在但内容没有」对客户端来说就是「这个文件读不到」，没必要发明第四种状态。
  if (!object) return json({ error: 'not-found' }, 404)

  return new Response(object.body, { headers: downloadHeaders(node.mime, node.name) })
}

/** GET /api/files/usage —— 当前账号已用 / 总配额 */
async function handleFileUsage(request: Request, env: Env): Promise<Response> {
  const identity = await requireUser(request, env)
  if (isResponse(identity)) return identity
  const used = await readUsedBytes(env.DB, identity.user.id)
  return json({ used, quota: USER_QUOTA_BYTES })
}

/** GET /api/files/shares —— 当前账号仍然有效的分享链接 */
async function handleListShares(request: Request, env: Env): Promise<Response> {
  const identity = await requireUser(request, env)
  if (isResponse(identity)) return identity

  const now = Date.now()
  // 用 JOIN 而不是 LEFT JOIN：节点行没了（理论上不会，删除只写墓碑）这条分享也不该出现。
  // 已撤销、已过期、节点已墓碑的一律过滤掉 —— 列表要展示的是「现在点开还能用的链接」。
  const rows = await env.DB
    .prepare(
      'SELECT s.token AS token, s.node_id AS nodeId, n.name AS name, s.created_at AS createdAt, s.expires_at AS expiresAt ' +
        'FROM file_shares s JOIN file_nodes n ON n.user_id = s.user_id AND n.id = s.node_id ' +
        'WHERE s.user_id = ? AND s.revoked = 0 AND n.deleted = 0 AND (s.expires_at IS NULL OR s.expires_at > ?) ' +
        'ORDER BY s.created_at DESC, s.token ASC',
    )
    .bind(identity.user.id, now)
    .all<CloudShareRow>()

  const shares: CloudShare[] = rows.results.map((row) => ({
    token: row.token,
    nodeId: row.nodeId,
    name: row.name,
    createdAt: Number(row.createdAt),
    expiresAt: row.expiresAt === null ? null : Number(row.expiresAt),
  }))
  return json({ shares })
}

/**
 * POST /api/files/shares —— 给某个文件生成公开分享链接。
 *
 * 同一个文件允许存在多条链接（各自独立撤销）：契约里 UI 是「列表里没有才创建」，
 * 正常流程不会重复建；真并发建出两条也不是错误，少一条「隐式撤销别人刚建的链接」的惊喜。
 */
async function handleCreateShare(request: Request, env: Env): Promise<Response> {
  const identity = await requireUser(request, env)
  if (isResponse(identity)) return identity

  const payload = await readJson(request)
  if (!payload.ok) return payload.response
  if (!isRecord(payload.value)) return badRequest('请求体必须是一个 JSON 对象')

  const rawNodeId = payload.value.nodeId
  if (typeof rawNodeId !== 'string' || !NODE_ID_RE.test(rawNodeId)) return badRequest('nodeId 不合法')

  const now = Date.now()
  const rawExpires = payload.value.expiresAt
  let expiresAt: number | null = null
  if (rawExpires !== undefined && rawExpires !== null) {
    if (typeof rawExpires !== 'number' || !Number.isInteger(rawExpires)) {
      return badRequest('expiresAt 必须是毫秒时间戳或 null')
    }
    // 过期的分享建出来就是死链，不如当场拒绝 —— 客户端多半是时间算错了
    if (rawExpires <= now) return badRequest('expiresAt 必须晚于当前时间')
    expiresAt = rawExpires
  }

  const userId = identity.user.id
  const db = env.DB
  // 只能分享自己的、活着的**文件**（文件夹没有内容可分享）
  const node = await db
    .prepare('SELECT 1 AS x FROM file_nodes WHERE user_id = ? AND id = ? AND deleted = 0 AND kind = ?')
    .bind(userId, rawNodeId, 'file')
    .first<{ x: number }>()
  if (!node) return json({ error: 'not-found' }, 404)

  // token 撞车概率是 1 / 2^128，但「极低」不等于「没有」：INSERT OR IGNORE + changes
  // 判断让撞车变成「换一个再试」，而不是 500（和邀请码生成同一个套路）。
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const token = generateShareToken()
    const inserted = await db
      .prepare(
        'INSERT OR IGNORE INTO file_shares (token, user_id, node_id, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, ?, 0)',
      )
      .bind(token, userId, rawNodeId, now, expiresAt)
      .run()
    if (inserted.meta.changes > 0) return json({ token, nodeId: rawNodeId, expiresAt }, 201)
  }
  return json({ error: 'server-error', message: '生成分享链接失败，请重试' }, 500)
}

/** DELETE /api/files/shares/{token} —— 撤销一条分享（软撤销：revoked = 1） */
async function handleRevokeShare(request: Request, env: Env, token: string): Promise<Response> {
  const identity = await requireUser(request, env)
  if (isResponse(identity)) return identity

  // token 形状不对 = 不可能存在，连库都不用查
  if (!SHARE_TOKEN_RE.test(token)) return json({ error: 'not-found' }, 404)

  const revoked = await env.DB
    .prepare('UPDATE file_shares SET revoked = 1 WHERE token = ? AND user_id = ? AND revoked = 0')
    .bind(token, identity.user.id)
    .run()
  // changes = 0：这个 token 不存在、不是自己的、或者已经撤销过 —— 三种都按 404 回
  if (revoked.meta.changes === 0) return json({ error: 'not-found' }, 404)
  return noContent()
}

/**
 * GET /api/share/{token} —— 公开分享，**不需要登录**。
 *
 * 这是整个 Worker 里唯一一个不鉴权的文件读取口，所以安全处理要单独说清楚：
 *   - 返回前重新过一遍类型白名单（inline / attachment）和 nosniff；
 *   - 加 CSP `default-src 'none'; sandbox`：即使某个类型被浏览器内联打开，
 *     页面里的脚本、外链、表单也全都跑不了，沙箱化后也无法操作本站的存储；
 *   - cache-control: no-store：分享可以随时撤销，缓存住就等于撤销不掉。
 */
async function handlePublicShare(env: Env, token: string): Promise<Response> {
  if (!SHARE_TOKEN_RE.test(token)) return json({ error: 'not-found' }, 404)

  const row = await env.DB
    .prepare(
      'SELECT s.node_id AS nodeId, s.user_id AS userId, s.expires_at AS expiresAt, s.revoked AS revoked, ' +
        'n.name AS name, n.mime AS mime, n.deleted AS deleted ' +
        'FROM file_shares s LEFT JOIN file_nodes n ON n.user_id = s.user_id AND n.id = s.node_id ' +
        'WHERE s.token = ?',
    )
    .bind(token)
    .first<PublicShareRow>()
  if (!row || Number(row.revoked) === 1) return json({ error: 'not-found' }, 404)
  if (row.name === null || Number(row.deleted) === 1) return json({ error: 'not-found' }, 404)

  // 过期和不存在分开回：410 让前端能显示「链接已过期」，404 就是「没这个链接」。
  // 撤销过的按 404 处理（对访问者来说，撤销和删除是一个意思）。
  if (row.expiresAt !== null && Number(row.expiresAt) <= Date.now()) {
    return json({ error: 'expired', message: '分享链接已过期' }, 410)
  }

  const bucket = env.FILES
  if (!bucket) return storageNotConfigured()

  const object = await bucket.get(fileKey(Number(row.userId), row.nodeId))
  if (!object) return json({ error: 'not-found' }, 404)

  const headers = downloadHeaders(row.mime ?? '', row.name)
  headers['content-security-policy'] = "default-src 'none'; sandbox"
  return new Response(object.body, { headers })
}

// ---------------------------------------------------------------- 路由

/** 结尾多余的斜杠不影响含义：/api/snapshot/ 和 /api/snapshot 走同一条路由 */
function normalizePath(raw: string): string {
  if (raw.length <= 1) return raw
  return raw.replace(/\/+$/, '') || '/'
}

async function route(request: Request, env: Env): Promise<Response> {
  const path = normalizePath(new URL(request.url).pathname)

  // OPTIONS 预检：同源请求其实不会触发它，但用别的端口（比如 vite 代理）或
  // curl 手动试的时候会有。不做 CORS（这个接口只给同源的网页用），回个空 204 就行。
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { allow: 'GET, POST, PUT, DELETE, OPTIONS' },
    })
  }

  // 非 /api 的请求交回静态资源层。
  // 平时带文件名的路径在 Worker 之前就被静态资源处理掉了，走到这里的基本都是
  // 前端路由（/settings 这种没有对应文件的地址），由 assets 的
  // not_found_handling: single-page-application 回落成 index.html。
  if (!path.startsWith('/api/') && path !== '/api') {
    if (!env.ASSETS) return new Response('Not Found', { status: 404 })
    return env.ASSETS.fetch(request)
  }

  // ---- 认证：唯一不需要令牌的三条（register / login）也在这一组里 ----
  if (path.startsWith('/api/auth/')) {
    if (path === '/api/auth/register') {
      if (request.method !== 'POST') return methodNotAllowed('POST')
      return handleRegister(request, env)
    }
    if (path === '/api/auth/login') {
      if (request.method !== 'POST') return methodNotAllowed('POST')
      return handleLogin(request, env)
    }
    if (path === '/api/auth/logout') {
      if (request.method !== 'POST') return methodNotAllowed('POST')
      return handleLogout(request, env)
    }
    if (path === '/api/auth/me') {
      if (request.method !== 'GET') return methodNotAllowed('GET')
      return handleMe(request, env)
    }
    return json({ error: 'not-found' }, 404)
  }

  // ---- 邀请码 ----
  if (path === '/api/invites') {
    if (request.method === 'GET') return handleListInvites(request, env)
    if (request.method === 'POST') return handleCreateInvite(request, env)
    return methodNotAllowed('GET, POST')
  }
  if (path.startsWith('/api/invites/')) {
    let code = ''
    try {
      // 路径里的码可能被 URL 编码过（%2D 之类），先解回来再查库
      code = decodeURIComponent(path.slice('/api/invites/'.length))
    } catch {
      return json({ error: 'not-found' }, 404)
    }
    if (!code) return json({ error: 'not-found' }, 404)
    if (request.method !== 'DELETE') return methodNotAllowed('DELETE')
    return handleDeleteInvite(request, env, code)
  }

  // ---- 快照 ----
  if (path === '/api/snapshot') {
    if (request.method === 'GET') return handleGetSnapshot(request, env)
    if (request.method === 'PUT') return handlePutSnapshot(request, env)
    return methodNotAllowed('GET, PUT')
  }

  // ---- 文件管理（R2 存内容 + D1 存目录树） ----
  //
  // 这些接口全部要登录。公开分享的读取口 /api/share/{token} 单独放在下面：
  // 它不带 /api/files/ 前缀、也不需要令牌 —— 任何人拿到 token 都能读那一个文件。
  if (path === '/api/files/tree') {
    if (request.method !== 'GET') return methodNotAllowed('GET')
    return handleFileTree(request, env)
  }
  if (path === '/api/files/nodes') {
    if (request.method !== 'POST') return methodNotAllowed('POST')
    return handlePushNodes(request, env)
  }
  if (path === '/api/files/delete') {
    if (request.method !== 'POST') return methodNotAllowed('POST')
    return handleDeleteFiles(request, env)
  }
  if (path === '/api/files/usage') {
    if (request.method !== 'GET') return methodNotAllowed('GET')
    return handleFileUsage(request, env)
  }
  if (path === '/api/files/shares') {
    if (request.method === 'GET') return handleListShares(request, env)
    if (request.method === 'POST') return handleCreateShare(request, env)
    return methodNotAllowed('GET, POST')
  }
  if (path.startsWith('/api/files/shares/')) {
    let token = ''
    try {
      token = decodeURIComponent(path.slice('/api/files/shares/'.length))
    } catch {
      return json({ error: 'not-found' }, 404)
    }
    if (request.method !== 'DELETE') return methodNotAllowed('DELETE')
    return handleRevokeShare(request, env, token)
  }
  if (path.startsWith('/api/files/content/')) {
    const nodeId = readPathId(path, '/api/files/content/')
    if (!nodeId) return json({ error: 'not-found' }, 404)
    if (request.method === 'GET') return handleGetFileContent(request, env, nodeId)
    if (request.method === 'PUT') return handlePutFileContent(request, env, nodeId)
    return methodNotAllowed('GET, PUT')
  }

  // ---- 公开分享：唯一不需要令牌的文件读取口 ----
  // 必须单独匹配：它不是 /api/files/ 前缀，漏了这一条的话前端生成的所有分享链接都会 404。
  if (path.startsWith('/api/share/')) {
    if (request.method !== 'GET') return methodNotAllowed('GET')
    let token = ''
    try {
      token = decodeURIComponent(path.slice('/api/share/'.length))
    } catch {
      return json({ error: 'not-found' }, 404)
    }
    // 形状校验（32 位 hex）在 handlePublicShare 里：不在路由层重复一遍
    return handlePublicShare(env, token)
  }

  // 未知的 /api/* 一律 404 JSON。
  // 为什么不能让它落到静态资源：SPA 回落会拿 index.html（HTML）当 200 返回，
  // 前端 res.json() 只会抛一句语法错误，「路径写错了」这个真正的原因反而被埋掉。
  return json({ error: 'not-found' }, 404)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env)
    } catch (error) {
      // 任何没预料到的异常都兜成 JSON 500：漏成 HTML 或平台错误页的话，
      // 前端 res.json() 只会抛语法错误，「服务端炸了」这个真正的原因就被埋掉。
      // 具体原因写进 console，用 wrangler tail 能看到；不往响应里放，免得泄露内部细节。
      console.error('[bettertools] 处理请求时抛出异常：', error)
      return json({ error: 'server-error', message: '服务端内部错误' }, 500)
    }
  },
}
