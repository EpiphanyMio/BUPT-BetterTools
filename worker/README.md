# 账号体系 + 多端同步 · Cloudflare Worker 后端

这个目录是网站的**同源 API**：账号、登录态、邀请码，以及每人一份的云端快照。

网页本身还是那个纯静态站点，这个 Worker 只接管 `/api/*` 这几条路径，
其余请求（页面、字体、图片）原样交回静态资源层，访问方式和以前一样。

> **v1 → v2**：原来是一个共享令牌（`SYNC_TOKEN`）读写全库唯一一份快照；
> 现在是用户名 + 密码换会话令牌，数据按用户分行存。
> **`SYNC_TOKEN` 从这一版起不再参与任何鉴权**（代码里还读得到这个字段，但没有任何逻辑用它），
> 线上那个 secret 可以删掉了。

---

## 1. 文件清单

| 文件 | 作用 |
| --- | --- |
| `worker/index.ts` | 路由表、快照读写（含乐观锁）、邀请码接口、认证接口 |
| `worker/auth.ts` | 密码哈希 / 校验、定长时间比较、会话令牌与会话查询、格式校验 |
| `worker/d1.ts` | 手写的 D1 最小类型（不装 `@cloudflare/workers-types`） |
| `worker/schema.sql` | 建表 + 从 v1 单用户结构迁移，**可重复执行** |
| `worker/README.md` | 本文件 |
| `scripts/_auth-e2e.mjs` | 等价环境下的端到端验证脚本（本地临时工具，已被 gitignore） |

前端那侧的实现（`src/lib/auth.ts` / `src/hooks/useAuth.ts` / `src/lib/sync.ts` /
`src/components/AuthScreen.tsx` / `src/components/InviteAdmin.tsx`）按同一份契约 **v2** 对接。

---

## 2. 接口契约 v2

带的身份都是 `Authorization: Bearer <token>`，token 是登录 / 注册返回的那 64 位 hex 串。

`user` 的形状：

```ts
{ id: number, username: string, isAdmin: boolean }
```

### 2.1 认证

| 方法 / 路径 | 请求体 | 成功 | 失败 |
| --- | --- | --- | --- |
| `POST /api/auth/register` | `{ username, password, inviteCode }` | `201 { token, user }` | `400 bad-request`（格式不合规）、`403 invalid-invite`、`409 username-taken` |
| `POST /api/auth/login` | `{ username, password }` | `200 { token, user }` | `401 invalid-credentials`（查无此人和密码错**都**是这一个）、`400 bad-request` |
| `POST /api/auth/logout` | 无（需登录） | `204` | `401 unauthorized` |
| `GET /api/auth/me` | 无（需登录） | `200 { user }` | `401 unauthorized` |

### 2.2 邀请码（仅管理员）

| 方法 / 路径 | 请求体 | 成功 | 失败 |
| --- | --- | --- | --- |
| `GET /api/invites` | — | `200 { invites: [{ code, createdAt, usedBy, usedAt }] }` | `401` / `403 forbidden` |
| `POST /api/invites` | `{}` 或 `{ code }` | `201 { code }` | `400`（自定义码格式不对）、`409 code-taken`（契约外的补充） |
| `DELETE /api/invites/{code}` | — | `204` | `404 not-found` |

- `invites` 按 `createdAt` 倒序；`usedBy` 是**用户名**（没用过是 `null`），`usedAt` 没用过也是 `null`。
- 不带 `code` 时服务端生成 12 位 `[A-Z0-9]`；带 `code` 时要求 6-32 位 `[A-Za-z0-9-]`。
- 已登录但不是管理员 → `403`；**没有身份** → `401`（先认人，再谈权限，前端据此决定是跳登录页还是提示没权限）。

### 2.3 快照（需登录，按用户隔离）

| 方法 / 路径 | 请求体 | 成功 | 失败 |
| --- | --- | --- | --- |
| `GET /api/snapshot` | — | `200 { revision, updatedAt, data }` | `401 unauthorized` |
| `PUT /api/snapshot` | `{ baseRevision, data }` | `200 { revision, updatedAt }` | `409 { error: "conflict", snapshot: { revision, updatedAt, data } }`、`400 bad-request`、`401` |

- **每个人只看得到自己那一行**：所有查询都带 `WHERE user_id = ?`。
- 从没存过数据 → `{ revision: 0, updatedAt: 0, data: null }`（不是 404）。
- `baseRevision` 和云端 `revision` 不一致 → `409`，并把云端**当前**那份带回去（约定「云端胜」）。

### 2.4 数据形状

```ts
interface SyncData {
  tools: { id: string; name: string; url: string; description: string; category: string; icon?: string }[]
  groups: string[]
  favorites: string[]
  order: string[]
  appSettings: { defaultCategory: string }
}
```

限制（和 `src/lib/sync.ts` 里那两个常量一起改）：请求体 ≤ **256KB**，`tools` ≤ **500** 条。

### 2.5 其它行为

- 未知的 `/api/*` 路径 → `404 { error: "not-found" }`，**不会**落到静态资源返回 index.html；
- `OPTIONS` → `204`（同源其实用不到，留着方便 curl / vite 代理）；
- 已定义路径上的其它方法 → `405`（带 `allow` 头）；
- 结尾多一个斜杠（`/api/snapshot/`）也能路由；
- 所有响应都带 `content-type: application/json; charset=utf-8` 和 `cache-control: no-store`；
- 没被捕获的异常兜成 `500 { error: "server-error" }`（具体原因只进 `console`，用 `wrangler tail` 看）。

### 2.6 错误码一览

`bad-request`、`unauthorized`、`forbidden`、`invalid-credentials`、`invalid-invite`、
`username-taken`、`code-taken`、`conflict`、`not-found`、`method-not-allowed`、`server-error`。

---

## 3. 安全参数（两种语言必须完全一致）

| 参数 | 值 |
| --- | --- |
| 密码哈希 | PBKDF2-SHA256，`iterations = 100000`，输出 32 字节，盐 16 字节随机 |
| 落库格式 | `password_hash` 64 位 hex、`salt` 32 位 hex、`iterations` 整数 |
| 比较方式 | 定长时间比较（`auth.ts` 的 `safeEqualHex`），不用 `===` |
| 会话令牌 | 32 字节随机 → 64 位 hex 交给客户端 |
| 库里的令牌 | **只存它的 sha256（hex）**，不存明文 |
| 有效期 | 30 天 |
| 用户名 | 3-32 位 `[A-Za-z0-9_-]`，比较**不区分大小写**（`COLLATE NOCASE` + `UNIQUE`） |
| 密码 | 至少 8 位（服务端上限 128 位，防止拿超长密码当 CPU 炸弹） |

服务端实现用 WebCrypto：`importKey('raw', ...)` +
`deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256)`。
`scripts/_auth-e2e.mjs` 里用 `node:crypto` 的 `pbkdf2Sync` 交叉验证过：两边算出来的哈希逐字节一致。

---

## 4. 数据库

### 4.1 四张表

```
users(id, username UNIQUE COLLATE NOCASE, password_hash, salt, iterations, is_admin, created_at)
sessions(token_hash PRIMARY KEY, user_id, created_at, expires_at)
invites(code PRIMARY KEY, created_by, created_at, used_by, used_at)
snapshot(user_id PRIMARY KEY, revision, updated_at, data)
```

时间一律是毫秒时间戳（`Date.now()`）。

### 4.2 迁移（v1 的单行快照 → v2 的每人一行）

`worker/schema.sql` 末尾那段就是迁移，**不需要单独准备迁移文件**，直接跑它就行。
它是按 SQLite 官方的「重建表」套路写的，而且每一步都写成「重复执行只是空转」：

1. 先按**旧结构**保证 `snapshot` 这个名字存在（全新库里建出来的是一张空表，正好当过渡）；
2. 按新结构建 `snapshot_v2`；
3. `INSERT OR IGNORE INTO snapshot_v2 SELECT * FROM snapshot` —— 两张表都是 4 列、顺序一致
   （旧的 `id` 正好落到新的 `user_id` 上），所以这一句对旧结构和新结构都成立；
4. `DROP TABLE snapshot`，再把 `snapshot_v2` 改名回 `snapshot`；
5. 万一管理员不是 1 号，最后那条 `UPDATE` 会把旧快照改挂到他名下。

**部署顺序很重要：先跑 `schema.sql`，再插入管理员。**
管理员是库里第一个用户 → `id = 1` → 旧的那行快照（复制过来是 `user_id = 1`）天然就是他的。

### 4.3 执行（这些命令本机跑不起来，要在能跑 wrangler 的机器上做）

```powershell
# 本地库
npx wrangler d1 execute bupt-bettertools-sync --local --file=worker/schema.sql

# 线上库（可以重复执行，跑两次没事）
npx wrangler d1 execute bupt-bettertools-sync --remote --file=worker/schema.sql
```

D1 的 `execute` 是**逐条**执行、整份文件不算一个事务。
所以万一跑到一半断了（网络、超时），直接**再跑一遍**就能接着完成 —— 这正是要求「可重复执行」的原因。

### 4.4 插入管理员

管理员就是你自己的账号，需要先有 `password_hash` / `salt`（PBKDF2，参数见第 3 节）。
`scripts/_admin-seed.json` 里已经存了一份算好的（用户名 `EpiphanyMio`），插进去即可：

```sql
INSERT INTO users (username, password_hash, salt, iterations, is_admin, created_at)
VALUES ('EpiphanyMio', '<64 位 hex>', '<32 位 hex>', 100000, 1, 1760000000000);
```

要换密码的话，用 `node:crypto` 现场算一份：

```js
const { pbkdf2Sync, randomBytes } = require('node:crypto')
const salt = randomBytes(16).toString('hex')
console.log(salt, pbkdf2Sync('你的密码', Buffer.from(salt, 'hex'), 100000, 32, 'sha256').toString('hex'))
```

---

## 5. 本地开发与验证

### 5.1 等价验证脚本（本机唯一能跑的那条路）

这台开发机上 `wrangler` / `workerd` / `esbuild` 起不来（spawn EPERM，环境限制），
所以用一个「真 `node:sqlite` + 真 HTTP + 直接 import `worker/index.ts`」的等价环境来验：

```powershell
node scripts/_auth-e2e.mjs
```

它跑的是**真实的 Worker 代码**和**真实的 SQL**（包括 `schema.sql` 的迁移），覆盖：

- 14 条契约断言（未登录 401、登录、错误密码、me、403、发码、错误码注册、真码注册、
  重复用码、新用户空快照、两边写入互不串、409 乐观锁、大小写重名、登出后失效）；
- `schema.sql` 的迁移与幂等（旧库、管理员不是 1 号、重复执行）；
- 边界：405 / 404 / OPTIONS / 256KB / 500 条工具 / 自定义邀请码 / 会话只存哈希 / 响应头。

### 5.2 想跑真 Worker 的时候（换台能跑 wrangler 的机器）

```powershell
npx wrangler d1 execute bupt-bettertools-sync --local --file=worker/schema.sql
npx wrangler dev --local --port 8787
```

`vite.config.ts` 里已经配好 `/api` → `http://127.0.0.1:8787` 的代理，
所以 `pnpm dev`（5173）拿到的就是真后端 + 热更新。

---

## 6. 设计取舍（写给以后维护的自己）

- **为什么令牌只存 sha256**：整张 `sessions` 表被拖走时，攻击者拿到的只是一堆哈希，
  拼不出能用的令牌。代价是每次鉴权多算一次 sha256 —— 在 Workers 上是微秒级。
- **为什么「先查重名，再占邀请码」**：如果把占码放在前面，一个已经被占用的用户名会让
  用户白白烧掉一张码。反过来的顺序里，最坏情况只是多一次 `SELECT`。
- **邀请码为什么是两段式占用（先写 `used_at`、建完用户再补 `used_by`）**：
  占码必须是**一步原子操作**（`UPDATE ... WHERE used_by IS NULL` 看 `changes`），
  否则两个请求同时用同一个码能双开。而 `used_by` 需要先有用户 id，所以中间必须留一个状态。
  这个状态带 2 分钟租约：万一进程在中间挂了，码到期自动恢复可用，不会锁死。
  对外（`GET /api/invites`）这个中间态看起来和「没用过」一样。
- **为什么查无此人也要算一次哈希**：否则这条路径比「密码错」快几十毫秒，
  响应时间本身就把「这个用户名存在」泄露了，401 只回一个错误码的努力也就白费。
- **为什么 401 和 403 分开**：401 = 你还没登录（前端跳登录页），
  403 = 登录了但不是管理员（前端提示没权限）。合成一个会让前端只能猜。
- **为什么快照还是一整包**：一人十几 KB，拆表就要处理字段级合并，而合并规则写错是**静默**的。
  单行快照把冲突简化成一个数字比较：`revision` 对不上就 409。
- **乐观锁为什么放在 SQL 的 WHERE 里**：`UPDATE ... WHERE user_id = ? AND revision = ?`
  让「判断」和「写入」由数据库一句完成，中间没有空档；先 SELECT 再 UPDATE 是挡不住并发的。
- **为什么先鉴权再读 body**：没身份的请求不该消耗解析 256KB 的 CPU 和内存。
- **迁移为什么用 `SELECT *`**：两张表列数、顺序都对齐，同一句 SQL 才能对旧结构和新结构都成立 ——
  这是让脚本「可以重复执行」的关键，纯 SQL 里没有别的办法做条件 DDL。

---

## 7. 已知的坑

1. **`SYNC_TOKEN` 已经没用了**：线上那个 secret 可以删，但删不删都不影响鉴权。
   任何新逻辑都不该再挂到它上面。
2. **管理员必须是第一个用户（`id = 1`）**，这样 v1 的旧快照迁移完就自动挂在他名下。
   如果不是，重跑一次 `schema.sql` 会把它改挂过去（前提是 1 号用户不存在）。
3. **D1 单主库**：写入天然串行，所以「占码」和「乐观锁」两条并发假设在 D1 上是严格成立的。
   将来若启用 read replication 并让写入走副本，这两条前提要重新确认。
4. **`/api` 不能被缓存**：响应已经带 `cache-control: no-store`。
   以后如果在 Cloudflare 面板加缓存规则，务必把 `/api/*` 排除掉。
5. **上限写了两份**：`src/lib/sync.ts` 的 `MAX_TOOLS` / `MAX_PAYLOAD_BYTES` 和
   `worker/index.ts` 的两个常量要一起改。前端那份是为了少跑一趟，后端这份才是真正的门。
6. **`single-page-application` 回落和 `/api` 的先后**：`wrangler.jsonc` 里已经有
   `"run_worker_first": ["/api/*"]`，上线后还是要确认一次：
   `curl -i https://<域名>/api/snapshot` 应当返回 `401` + **JSON**，不是 `index.html`。
7. **密码无法找回**：这套系统没有邮箱、没有重置流程。忘了密码只能直接改库
   （用第 4.4 节的办法生成新的 `password_hash`/`salt` 再 `UPDATE`）。
8. **邀请码占用的最后一步可能失败**：用户已经建好、但最后那条补 `used_by` 的 `UPDATE` 失败时，
   这张码会在 2 分钟租约到期后重新可用（理论上能被第二个请求用掉）。
   这是「D1 没有交互式事务」换来的代价 —— 反过来（让码永久锁死）更糟，所以选了这个方向。
9. **没有登录失败限流**：PBKDF2 让每次尝试都慢，但真正的限流要靠 Cloudflare 的 WAF / Rate Limiting
   规则（或在 `users` 上加失败计数）。要做的话，注意别在 Worker 里引入额外的写操作 —— 那是计费的。
