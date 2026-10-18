// 账号体系里跟「密码、令牌、会话」有关的那一层。
//
// 为什么单独拆出来：这里的参数（迭代次数、盐 / 哈希字节数、令牌有效期）
// **跨语言**——前端虽然只负责把密码发过来，但同样的参数以后要是做「本地预校验」
// 或者换个客户端，两边算出来必须逐字节一致。参数散在一堆代码里，
// 将来有人把迭代次数提到 20 万却只改了其中一处，表现就是「密码永远错」，
// 而在浏览器里完全看不出线索。所以这些数字只写在 auth.ts 这一处。

import type { D1Database } from './d1.ts'

/** 接口里 user 的形状，和前端 src 那边的类型是同一份契约 */
export interface User {
  id: number
  username: string
  isAdmin: boolean
}

/** 库里 users 表里跟密码有关的那几列 */
export interface PasswordRecord {
  hash: string
  salt: string
  iterations: number
}

// ---------------------------------------------------------------- 安全参数
//
// PBKDF2-SHA256 / 10 万次 / 32 字节输出：这个强度是「库被拖走以后，暴力猜密码要花
// 可观的显卡时间」和「一次登录在 Worker 上只花几十毫秒」之间的折中。
// 次数再往上加，登录会明显变慢，Worker 还可能撞 CPU 时间限制；往下减就等于白存明文。

export const PBKDF2_ITERATIONS = 100000
const SALT_BYTES = 16
const HASH_BYTES = 32
const TOKEN_BYTES = 32

/** 会话 30 天。定一个有限期，是为了让「令牌泄露」这件事的损失有时间边界 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

const MIN_PASSWORD_LENGTH = 8
const MAX_PASSWORD_LENGTH = 128

// 用户名 3-32 位，只允许字母、数字、下划线、连字符。
// 不接受中文和空格：这两样在不同输入法 / 不同设备上「看起来一样、实际不是一个串」，
// 用户以后在手机上登录会莫名其妙地失败。
const USERNAME_RE = /^[A-Za-z0-9_-]{3,32}$/

// 服务端发出去的令牌是 32 字节 → 64 位小写 hex，形状是固定的
const TOKEN_RE = /^[0-9a-f]{64}$/

// ---------------------------------------------------------------- hex 与随机数

const encoder = new TextEncoder()

/** 字节 → 小写 hex。库里的 hash / salt / token_hash 全是这个格式 */
export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0')
  }
  return out
}

/**
 * hex → 字节。传进来的串都是我们自己写库前生成的，长度不对时按 0 处理，不抛错。
 *
 * 返回类型写成 Uint8Array<ArrayBuffer> 而不是 Uint8Array：后者的底层 buffer 可能是
 * SharedArrayBuffer，而 WebCrypto 的 salt 只接受 ArrayBuffer 支撑的那一种，
 * 类型对不上时 tsc 会报 TS2322（运行时其实没事，但类型干净一点查错时少噪音）。
 */
function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const length = Math.floor(hex.length / 2)
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

/** 密码学安全随机数的 hex 串。Math.random 可预测，绝不能用来生成盐和令牌 */
export function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return toHex(bytes)
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text))
  return toHex(new Uint8Array(digest))
}

// ---------------------------------------------------------------- 密码

/**
 * PBKDF2-SHA256 派生，返回 hex。
 *
 * 用 PBKDF2 而不是直接 sha256(密码)：密码的熵本来就不高，
 * 一次普通哈希在显卡上每秒能算几十亿次；PBKDF2 把「算一次」的成本乘上迭代次数，
 * 暴力猜的代价就跟着乘十倍百倍。salt 则保证两个人用同一个密码时哈希也不同，
 * 免得一次彩虹表撞穿一片账号。
 *
 * salt 以 hex 存在库里，这里要先转回字节再喂给 WebCrypto。
 */
async function deriveHex(password: string, saltHex: string, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), { name: 'PBKDF2' }, false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromHex(saltHex), iterations, hash: 'SHA-256' },
    key,
    HASH_BYTES * 8,
  )
  return toHex(new Uint8Array(bits))
}

export async function hashPassword(password: string): Promise<PasswordRecord> {
  const salt = randomHex(SALT_BYTES)
  const hash = await deriveHex(password, salt, PBKDF2_ITERATIONS)
  return { hash, salt, iterations: PBKDF2_ITERATIONS }
}

export async function verifyPassword(password: string, record: PasswordRecord): Promise<boolean> {
  const actual = await deriveHex(password, record.salt, record.iterations)
  return safeEqualHex(actual, record.hash)
}

/**
 * 定长时间比较两串 hex。
 *
 * 普通 === 在第一个不同的字符处就返回，「多花了几个字符的时间」是能被测出来的，
 * 攻击者据此可以一位一位地试出哈希 / 令牌。这里把每个位置都异或一遍、
 * 最后才看总差是不是 0，不管哪一位不同耗时都一样。长度也折进结果里，
 * 不让「长度对不对」提前泄露。
 */
export function safeEqualHex(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length)
  let diff = a.length ^ b.length
  for (let i = 0; i < length; i += 1) {
    // 越界处的 charCodeAt 是 NaN，`|| 0` 把它折成 0，循环次数不随内容变化
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  }
  return diff === 0
}

/**
 * 登录时「用户名不存在」那条路径也要算一次哈希，用的假记录。
 *
 * 为什么需要它：如果查无此人就立刻 401，那条路径会比「密码错」快几十毫秒，
 * 响应时间差本身就能把「这个用户名存不存在」泄露出去 —— 于是接口只回一个
 * invalid-credentials 的努力就白费了。这串常量永远匹配不上任何真实密码。
 */
export const DUMMY_PASSWORD_RECORD: PasswordRecord = {
  hash: '4b8e2a1f9c7d6035'.repeat(4),
  salt: '9f2c1d4b7a6e5038c1b2d3e4f5a60718',
  iterations: PBKDF2_ITERATIONS,
}

// ---------------------------------------------------------------- 格式校验
//
// 校验只做「形状对不对」，不做「好不好」：长度、字符集这些是硬规则，
// 服务端必须自己拦一遍（前端那份校验是给人省事的，绕过网页直接 curl 一样能打进来）。

export function parseUsername(value: unknown): string | null {
  if (typeof value !== 'string') return null
  // 前后空格是复制粘贴带进来的，替用户去掉；密码则一个字都不能动（空格可以是密码的一部分）
  const name = value.trim()
  return USERNAME_RE.test(name) ? name : null
}

export function parsePassword(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (value.length < MIN_PASSWORD_LENGTH || value.length > MAX_PASSWORD_LENGTH) return null
  return value
}

// ---------------------------------------------------------------- 令牌与会话

/**
 * 从 Authorization 头里抠出 Bearer 后面的令牌。没有就返回空串。
 *
 * 大小写不敏感、允许多个空格：不同客户端（fetch / curl / 手机浏览器）拼这个头的
 * 习惯不一样，卡得太死就会出现「电脑能登录、手机一直 401」这种查半天的怪事。
 */
export function readBearer(request: Request): string {
  const raw = request.headers.get('authorization') ?? ''
  const matched = /^Bearer\s+(.+)$/i.exec(raw.trim())
  return matched ? matched[1].trim() : ''
}

/**
 * 建一条会话并返回**明文**令牌。
 *
 * 库里只存 sha256(令牌)：这个值是不可逆的，就算整张 sessions 表被拖走，
 * 拿到的也只是哈希，反推不出能直接用的令牌。代价是每次鉴权多算一次 sha256
 * ——这一步在 Workers 上是微秒级的，比每次请求都查一次哈希表贵不了多少。
 */
export async function createSession(db: D1Database, userId: number, now: number): Promise<string> {
  const token = randomHex(TOKEN_BYTES)
  const tokenHash = await sha256Hex(token)
  await db
    .prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(tokenHash, userId, now, now + SESSION_TTL_MS)
    .run()
  return token
}

export async function destroySession(db: D1Database, tokenHash: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run()
}

/** 通过鉴权之后拿到的身份。tokenHash 留着，登出时直接按它删行，不用再把令牌哈希一遍 */
export interface Identity {
  user: User
  tokenHash: string
}

interface SessionUserRow {
  id: number
  username: string
  isAdmin: number
  expiresAt: number
}

/**
 * 解析 Authorization → sha256 → 查 sessions → 校验没过期 → 取 user。
 * 任何一步失败都返回 null（调用方统一回 401，不告诉对方是哪一步失败的）。
 *
 * 注意这里**只读库、不解析 body**：没令牌的请求连 256KB 的请求体都不该让我们解析，
 * 否则谁都能靠狂发大包白烧 Worker 的 CPU。这是这个 Worker 从 v1 就守着的顺序。
 */
export async function authenticate(request: Request, db: D1Database, now: number): Promise<Identity | null> {
  const token = readBearer(request)

  // 形状先卡一刀：不是 64 位小写 hex 的令牌不可能是我们发出去的，
  // 直接返回能省一次数据库查询，也顺带挡住把接口当数据库扫描器用的请求。
  if (!TOKEN_RE.test(token)) return null

  const tokenHash = await sha256Hex(token)
  const row = await db
    .prepare(
      'SELECT s.expires_at AS expiresAt, u.id AS id, u.username AS username, u.is_admin AS isAdmin ' +
        'FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?',
    )
    .bind(tokenHash)
    .first<SessionUserRow>()

  if (!row) return null

  if (Number(row.expiresAt) <= now) {
    // 过期的会话顺手删掉：留着只占空间，下次还得再查一次
    await destroySession(db, tokenHash)
    return null
  }

  return {
    user: { id: Number(row.id), username: row.username, isAdmin: Number(row.isAdmin) === 1 },
    tokenHash,
  }
}
