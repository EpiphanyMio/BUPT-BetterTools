// 「多端同步」的 Cloudflare Worker 后端：给这个纯静态网站加一个**同源**的 JSON 接口。
//
// ---------------------------------------------------------------- 它负责哪些请求
//
// 网站本身还是纯静态的 —— 这个 Worker 只接管 /api/* 这几条路径，
// 其余请求原样交回静态资源层（env.ASSETS），所以加了后端之后
// 页面、字体、图片的访问方式和以前完全一样，一句前端代码都不用改。
// 同源也意味着**不需要 CORS**：浏览器认为 /api 和页面是一个源，不带预检、不拦响应。
//
// ---------------------------------------------------------------- 数据为什么是一整包
//
// 云端只存**一整份**快照（snapshot 表里永远只有 id = 1 这一行，见 worker/schema.sql）。
// 为什么不做成 tools / groups / favorites 多张表：
//   这个应用全局的数据才十几 KB，又是单用户；拆表就要处理"两台设备各改一条"的合并规则，
//   而合并规则写错是**静默**的 —— 数据被揉在一起，用户不知道从哪一步开始错的。
//   单行快照把冲突变成一个数字比较：revision 对不上就 409，谁新谁赢，行为可预测。
//
// ---------------------------------------------------------------- 乐观锁：一条 WHERE 挡掉并发覆盖
//
// revision 由服务器维护，每成功写一次 +1。客户端 PUT 时带 baseRevision
// （"我以为云端现在是第几版"），服务端把它塞进 UPDATE 的 WHERE 里：
//
//   UPDATE snapshot SET revision = revision + 1, ... WHERE id = 1 AND revision = ?baseRevision
//
// 如果别人先写过，这个 WHERE 一行都匹配不到 → meta.changes === 0 → 回 409，并把当前快照带回去。
// 为什么不能"先 SELECT 再 UPDATE"就完事：查完到改之间别的请求可能已经写进去了，
// 那个空档就是数据被覆盖的地方。把版本号放进 WHERE，判断和写入由数据库一句完成，中间没有缝。
//
// ---------------------------------------------------------------- 三条硬性要求
//
// ① **先鉴权再读 body**：没令牌的请求连 256KB 的数据都不该让我们解析，
//    否则谁都能靠狂发大包白烧 Worker 的 CPU 和内存（Worker 是按调用计费的）。
// ② 令牌用**定长时间**比较：直接 a === b 会在第一个不同的字符处提前返回，
//    攻击者能从响应耗时差里一位一位地试出令牌。定长时间比较把两串都比完再出结果。
// ③ 所有响应都是 JSON（Content-Type: application/json; charset=utf-8）。
//    哪怕是 404 —— 一旦漏成 HTML，前端 res.json() 只会抛一句看不懂的语法错误，
//    "路径写错了"这个真正的原因就被埋掉了。

// ---------------------------------------------------------------- 类型
//
// 手写 D1 的最小类型，而不是装 @cloudflare/workers-types：
//   这里只用到三四条方法，为一个类型包多装几十 MB 依赖不划算。
// 另外 worker/ 不在 tsconfig 的 include（只有 src/）里，pnpm build 的 tsc 不会检查本文件，
// 所以这里的类型主要是给我自己和编辑器看的，不影响构建。

interface D1Result {
  success: boolean
  meta: {
    /** 这条语句实际改到了几行 —— 判断乐观锁成没成功全靠它 */
    changes: number
  }
  results: Record<string, unknown>[]
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  first<T = Record<string, unknown>>(): Promise<T | null>
  run(): Promise<D1Result>
}

interface D1Database {
  prepare(query: string): D1PreparedStatement
}

/** 静态资源绑定：把我管不了的请求原样交回去 */
interface Fetcher {
  fetch(request: Request): Promise<Response>
}

interface Env {
  DB: D1Database
  /** 部署时用 wrangler secret put SYNC_TOKEN 设置；本地从 .dev.vars 读 */
  SYNC_TOKEN: string
  ASSETS: Fetcher
}

// ---------------------------------------------------------------- 契约里的数据形状

interface ToolRow {
  id: string
  name: string
  url: string
  description: string
  category: string
  /** 空字符串等于"没设图标"，见下面 readSyncData 里的说明 */
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

// ---------------------------------------------------------------- 常量

// 请求体上限 256KB、工具最多 500 条：与前端 src/lib/sync.ts 里的 MAX_PAYLOAD_BYTES /
// MAX_TOOLS 保持一致。两边都拦一次是有意的 —— 前端拦是为了省一次白跑的请求，
// 后端拦是因为**不能信任客户端**：绕过网页直接 curl 一样能打这个接口。
const MAX_BODY_BYTES = 256 * 1024
const MAX_TOOLS = 500

// 所有 JSON 响应共用。cache-control: no-store 很重要：
// GET /api/snapshot 一旦被浏览器或 CDN 缓存住，客户端读到的 revision 会一直停在旧值，
// 于是"该不该推"永远判断错、每次推都撞 409 —— 那种 bug 极难查，不如一开始就声明不缓存。
const JSON_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

// ---------------------------------------------------------------- 小工具

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

function unauthorized(): Response {
  return json({ error: 'unauthorized' }, 401)
}

function badRequest(message: string): Response {
  return json({ error: 'bad-request', message }, 400)
}

function methodNotAllowed(): Response {
  return new Response(JSON.stringify({ error: 'method-not-allowed' }), {
    status: 405,
    headers: { ...JSON_HEADERS, allow: 'GET, PUT, OPTIONS' },
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  // 数组也是 object，这里要排除掉 —— 否则 { tools: [...] } 里的 tools 被当成对象会一路错下去
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ---------------------------------------------------------------- 鉴权

/**
 * 从 Authorization 头里抠出 Bearer 后面的令牌。没有就返回空串。
 *
 * 大小写不敏感、允许多个空格：不同客户端（fetch / curl / 手机浏览器）拼这个头的习惯不一样，
 * 卡得太死就会出现"电脑能同步、手机一直 401"这种查半天的怪事。
 */
function readBearer(request: Request): string {
  const raw = request.headers.get('authorization') ?? ''
  const matched = /^Bearer\s+(.+)$/i.exec(raw.trim())
  return matched ? matched[1].trim() : ''
}

/**
 * 定长时间比较两串是否相等。
 *
 * 原理：普通比较会在第一个不同的字符处 return false，"多花了几个字符的时间"
 * 会被测出来，攻击者据此一位一位试出正确令牌。这里把所有位置都异或一遍、
 * 最后才看总结果是不是 0 —— 不管哪一位不同，耗时都一样。
 *
 * 长度也折进结果（ea.length ^ eb.length）：这样"长度对不对"和"内容对不对"
 * 都是循环结束后才知道，不会在中途泄露。长度本身不算秘密，两种长度的令牌
 * 都会跑满 max 次的循环。
 */
function sameToken(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given)
  const b = new TextEncoder().encode(expected)
  const len = Math.max(a.length, b.length)

  let diff = a.length ^ b.length
  for (let i = 0; i < len; i += 1) {
    // 短的那串越界处补 0，循环次数不随内容变化
    diff |= (i < a.length ? a[i] : 0) ^ (i < b.length ? b[i] : 0)
  }
  return diff === 0
}

/**
 * 这次请求能不能放行。
 *
 * 没配 SYNC_TOKEN 时一律拒绝（fail closed）：配置漏了顶多是"同步用不了"，
 * 而绝不能变成"谁都能读写我的数据"。这类安全开关的默认值必须是关着的。
 */
function isAuthorized(request: Request, env: Env): boolean {
  const expected = (env.SYNC_TOKEN ?? '').trim()
  if (!expected) return false
  return sameToken(readBearer(request), expected)
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
    return { ok: false, message: `请求体 ${Math.round(declared / 1024)} KB，超过上限 256 KB` }
  }

  const text = await request.text()
  const bytes = new TextEncoder().encode(text).length
  if (bytes > MAX_BODY_BYTES) {
    return { ok: false, message: `请求体 ${Math.round(bytes / 1024)} KB，超过上限 256 KB` }
  }
  return { ok: true, text }
}

// ---------------------------------------------------------------- 校验
//
// 为什么要逐字段校验，而不是 JSON.parse 完直接存：
//   存进去的东西下次会被**原样返回给所有设备**。一份形状不对的数据一旦落库，
//   就会变成"每台设备同步回来都是坏的"，比拒收一次难受得多。
//   代价是这里多几十行，换来的是一个永远只有合法数据的数据源。
//
// 但校验只管"形状对不对"（是不是字符串、是不是数组），不管业务规则
// （比如"id 不能为空"）—— 业务规则变起来快，写死在服务端会变成客户端的枷锁。

type Validated<T> = { ok: true; value: T } | { ok: false; message: string }

/**
 * 取一个字符串字段：不存在（undefined / null）当作空串，类型不对返回 null 让调用方报 400。
 *
 * 两者区别对待的理由：字段缺席通常只是客户端版本旧一点，用空串填上就完了；
 * 而"字段是数字/对象"说明两边理解已经不一致，得当场暴露，不然会存进一份
 * 前端读不懂的数据。
 */
function readTextField(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key]
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value : null
}

/** 读一个字符串数组，顺便复制一份（不直接引用请求里的对象） */
function readStringList(raw: unknown, key: string): Validated<string[]> {
  if (!Array.isArray(raw)) return { ok: false, message: `data.${key} 必须是字符串数组` }

  const out: string[] = []
  for (let i = 0; i < raw.length; i += 1) {
    if (typeof raw[i] !== 'string') return { ok: false, message: `data.${key}[${i}] 必须是字符串` }
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
    return { ok: false, message: `工具数量 ${tools.length} 条，超过上限 ${MAX_TOOLS} 条` }
  }

  const cleanTools: ToolRow[] = []
  for (let i = 0; i < tools.length; i += 1) {
    const item = tools[i]
    if (!isRecord(item)) return { ok: false, message: `data.tools[${i}] 不是一个对象` }

    const id = readTextField(item, 'id')
    const name = readTextField(item, 'name')
    const url = readTextField(item, 'url')
    const description = readTextField(item, 'description')
    const category = readTextField(item, 'category')
    const icon = readTextField(item, 'icon')
    if (id === null || name === null || url === null || description === null || category === null || icon === null) {
      return { ok: false, message: `data.tools[${i}] 的 id/name/url/description/category/icon 必须都是字符串` }
    }

    // 空字符串的 icon 等于"没设图标"：前端类型是 icon?: string，
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

  // appSettings 整个缺席时用空串兜底（前端会把空串转成"全部"分组）：
  // 这个字段只是"默认打开哪个分组"，缺了不影响数据正确性，没必要为它 400。
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

// ---------------------------------------------------------------- 数据库读写

/** 读那唯一一行。没有就返回 null —— 这是"云端从没存过数据"的正常状态，不是错误。 */
async function readRow(db: D1Database): Promise<SnapshotRow | null> {
  // 用 first() 而不是 all()：单行快照最多一行，first 拿到的就是它，省一层数组包装
  const row = await db.prepare('SELECT revision, updated_at, data FROM snapshot WHERE id = 1').first<SnapshotRow>()
  return row ?? null
}

/**
 * 把库里存的 JSON 文本还原成 SyncData。
 *
 * 读出来也再校验一遍（而不是 JSON.parse 完直接返回）：库里的数据只可能来自
 * PUT 的校验，但"只可能"不等于"一定"。万一有人用 wrangler d1 execute 手改过、
 * 或者将来的版本写法不同，这里应当返回 null 让接口报错，而不是把半坏的数据
 * 推给每一台设备 —— 那会把客户端的工具列表洗成残缺的。
 */
function parseStoredData(text: string): SyncData | null {
  try {
    const parsed = readSyncData(JSON.parse(text))
    return parsed.ok ? parsed.value : null
  } catch {
    return null
  }
}

/** 组装 409：把云端**当前**这份一起带回去，客户端可以直接采用（约定"云端胜"） */
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

// ---------------------------------------------------------------- 两个接口

/** GET /api/snapshot —— 拉当前快照。云端从没存过数据时返回 revision: 0 / data: null。 */
async function handleGet(request: Request, env: Env): Promise<Response> {
  if (!isAuthorized(request, env)) return unauthorized()

  const row = await readRow(env.DB)

  // 空云端不是 404：客户端靠 revision === 0 判断"我这份就是第一版，推上去"
  if (!row) return json({ revision: 0, updatedAt: 0, data: null })

  const data = parseStoredData(row.data)
  if (!data) return json({ error: 'server-error', message: '云端数据已损坏，无法解析' }, 500)

  return json({ revision: row.revision, updatedAt: row.updated_at, data })
}

/** PUT /api/snapshot —— 整包覆盖写入，baseRevision 当乐观锁。 */
async function handlePut(request: Request, env: Env): Promise<Response> {
  // ① 鉴权必须在解析 body 之前：解析等于是替陌生人干活
  if (!isAuthorized(request, env)) return unauthorized()

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

  const { baseRevision, data } = payload.value
  const now = Date.now()
  const serialized = JSON.stringify(data)
  const db = env.DB

  // ⑤ 先看这行在不在：第一次写入是 INSERT，之后才是带乐观锁的 UPDATE
  const current = await readRow(db)

  if (!current) {
    // 云端是空的。只有 baseRevision === 0 才允许写：
    // 客户端手里拿着大于 0 的版本号却面对一个空云端（数据库被重置过），
    // 直接让它写会让两台设备的版本号从此错位，所以照样判冲突。
    if (baseRevision !== 0) return conflict(null)

    // INSERT OR IGNORE + 看 changes：两个请求同时"第一次写"时，
    // 后到的那个主键撞车、changes 为 0，于是也走冲突分支，不会把先到的那份覆盖掉。
    const inserted = await db
      .prepare('INSERT OR IGNORE INTO snapshot (id, revision, updated_at, data) VALUES (1, 1, ?, ?)')
      .bind(now, serialized)
      .run()

    if (inserted.meta.changes === 0) return conflict(await readRow(db))
    return json({ revision: 1, updatedAt: now })
  }

  // ⑥ 真正的乐观锁：revision 不是我以为的那一版，这条 UPDATE 就一行都改不到
  const updated = await db
    .prepare('UPDATE snapshot SET revision = revision + 1, updated_at = ?, data = ? WHERE id = 1 AND revision = ?')
    .bind(now, serialized, baseRevision)
    .run()

  if (updated.meta.changes === 0) {
    // 冲突：重新读一次（而不是用上面那个 current）——从读到写之间别人可能又改了，
    // 要回的是此刻最新的那份，客户端拿它覆盖本地才不会倒退一个版本。
    return conflict(await readRow(db))
  }

  return json({ revision: baseRevision + 1, updatedAt: now })
}

// ---------------------------------------------------------------- 入口

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname

    // OPTIONS 预检：同源请求其实不会触发它，但用别的端口（比如 vite 代理）或
    // curl 手动试的时候会有。不做 CORS（这个接口只给同源的网页用），回个空 204 就行。
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { allow: 'GET, PUT, OPTIONS' } })
    }

    // 非 /api 的请求交回静态资源层。
    // 平时带文件名的路径在 Worker 之前就被静态资源处理掉了，走到这里的基本都是
    // 前端路由（/settings 这种没有对应文件的地址），由 assets 的
    // not_found_handling: single-page-application 回落成 index.html。
    if (!path.startsWith('/api/') && path !== '/api') {
      if (!env.ASSETS) return new Response('Not Found', { status: 404 })
      return env.ASSETS.fetch(request)
    }

    if (path === '/api/snapshot') {
      if (request.method === 'GET') return handleGet(request, env)
      if (request.method === 'PUT') return handlePut(request, env)
      return methodNotAllowed()
    }

    // 未知的 /api/* 一律 404 JSON。
    // 为什么不能让它落到静态资源：SPA 回落会拿 index.html（HTML）当 200 返回，
    // 前端 res.json() 只会抛一句语法错误，"路径写错了"这个真正的原因反而被埋掉。
    return json({ error: 'not-found' }, 404)
  },
}
