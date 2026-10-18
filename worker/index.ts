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
//   其它 /api/*                        → 404 { error: "not-found" }
//
// 为什么把 /api/auth/* 放在最前面：注册和登录是**唯一**不需要令牌的接口，
// 先按前缀分流，后面的处理函数就不用再考虑「这个请求可能还没身份」这件事。

import type { D1Database } from './d1.ts'
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
