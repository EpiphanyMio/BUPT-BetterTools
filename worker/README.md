# 多端数据同步 · Cloudflare Worker 后端

这个目录是网站的**同源 API**：手机和电脑通过它共用一份数据。

网页本身还是那个纯静态站点，这个 Worker 只接管 `/api/*` 这几条路径，
其余请求（页面、字体、图片）原样交回静态资源层，访问方式和以前一样。

前端那侧已经写好了（`src/lib/sync.ts` / `src/hooks/useSync.ts`），
两边按同一份契约 **v1** 对接，这里不需要改前端一行代码。

---

## 1. 文件清单

| 文件 | 作用 |
| --- | --- |
| `worker/index.ts` | Worker 主程序：路由、鉴权、校验、乐观锁写入 |
| `worker/schema.sql` | D1 建表语句（只有一张 `snapshot` 表，永远一行） |
| `worker/README.md` | 本文件 |
| `wrangler.jsonc` | 新增了 `main` 和 `d1_databases` 两个字段 |
| `.dev.vars` | **本地**开发用的令牌（已被 `.gitignore` 忽略，不会进仓库） |

---

## 2. 接口契约 v1

所有请求都要带 `Authorization: Bearer <TOKEN>`，TOKEN 是 Worker 的 secret `env.SYNC_TOKEN`。

### GET /api/snapshot

```
200 → { revision: number, updatedAt: number, data: SyncData | null }
401 → { error: "unauthorized" }
```

云端从未存过数据时返回 `{ revision: 0, updatedAt: 0, data: null }`（不是 404）。

### PUT /api/snapshot

请求体 `{ baseRevision: number, data: SyncData }`

```
200 → { revision: number, updatedAt: number }
409 → { error: "conflict", snapshot: { revision, updatedAt, data } }
400 → { error: "bad-request", message: string }
401 → { error: "unauthorized" }
```

`baseRevision` 是「我以为云端现在是第几版」。它和云端当前 revision 不一致就返回 409，
并把云端**当前**那份快照一起带回去，前端会直接采用它（约定「云端胜」）。

### 数据形状

```ts
interface SyncData {
  tools: { id: string; name: string; url: string; description: string; category: string; icon?: string }[]
  groups: string[]
  favorites: string[]
  order: string[]
  appSettings: { defaultCategory: string }
}
```

限制：请求体 ≤ **256KB**，`tools` ≤ **500** 条，超了返回 400。

### 其它行为

- 未知的 `/api/*` 路径 → `404 { error: "not-found" }`，**不会**落到静态资源返回 index.html；
- `OPTIONS` 预检 → `204`（同源其实用不到，留着方便用 curl / 别的端口调）；
- 已定义路径上的其它方法（如 POST）→ `405`；
- 所有响应都带 `Content-Type: application/json; charset=utf-8` 和 `Cache-Control: no-store`。

---

## 3. 本地开发

```powershell
# ① 建本地 D1 表（本地库文件在 .wrangler/state 下，随便造）
npx wrangler d1 execute bupt-bettertools-sync --local --file=worker/schema.sql

# ② 起服务（自带静态资源 + /api，一个端口 8787 全都有）
npx wrangler dev --local --port 8787
```

然后浏览器打开 <http://127.0.0.1:8787/> 就是整站（`dist/` 的产物），
`/api/*` 走 Worker。`.dev.vars` 里的 `SYNC_TOKEN` 会被自动注入。

冒烟测试（PowerShell）：

```powershell
$h = @{ Authorization = 'Bearer <把 .dev.vars 里那串抄过来>' }

# 空云端：应当 200 且 data 为 null
Invoke-RestMethod http://127.0.0.1:8787/api/snapshot -Headers $h

# 写一份（baseRevision 0）
$body = '{"baseRevision":0,"data":{"tools":[],"groups":[],"favorites":[],"order":[],"appSettings":{"defaultCategory":"全部"}}}'
Invoke-RestMethod http://127.0.0.1:8787/api/snapshot -Method Put -Headers $h -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
```

> **两种本地跑法，别搞混：**
>
> ① **只想看后端**：用上面的 `wrangler dev`，浏览器打开 <http://127.0.0.1:8787/>
>    就是整站（`dist/` 的产物，改前端源码不会热更新）。
>
> ② **要改前端又要调接口**：开两个终端 ——
>    一个 `npx wrangler dev --local --port 8787` 起后端，
>    一个 `pnpm dev` 起 Vite（5173）。`vite.config.ts` 里已经配好了
>    `/api` → `http://127.0.0.1:8787` 的代理，所以前端代码里永远只写 `fetch("/api/...")`，
>    开发和线上是同一行代码。
>    这个代理**只对 `pnpm dev` 有效**：`pnpm build` 出来的静态站点没有代理，
>    线上靠 Worker 同源提供 `/api`。

---

## 4. 部署（需要人做的那几步）

本机没有 Cloudflare 登录态，所以下面这些**必须你自己执行一次**。

```powershell
# ① 登录（浏览器里点一下授权）
npx wrangler login

# ② 创建 D1 数据库：输出里会有一行 database_id
npx wrangler d1 create bupt-bettertools-sync

# ③ 把输出的 database_id 填进 wrangler.jsonc 的 d1_databases[0].database_id
#    现在那里是占位符 00000000-0000-0000-0000-000000000000，不改会部署失败

# ④ 在线上库里建表（--remote 才是真的线上库）
npx wrangler d1 execute bupt-bettertools-sync --remote --file=worker/schema.sql

# ⑤ 设置令牌（会提示你粘贴，输入的内容不会出现在命令历史里，也不要写进任何文件）
npx wrangler secret put SYNC_TOKEN

# ⑥ 部署
npx wrangler deploy
```

`git push` 也会触发 Cloudflare 自动构建（构建命令 `pnpm build`，产物 `dist/`）。
但只要 `database_id` 还是占位符，自动构建就会在 `wrangler deploy` 那步失败，
所以 ③ 必须在 push 之前做完。

部署后自检：

```powershell
# 应当 401（没带令牌）
Invoke-WebRequest https://bupt-bettertools.yuesu76.workers.dev/api/snapshot
# 应当 200 且 data 为 null（第一次）
Invoke-RestMethod https://bupt-bettertools.yuesu76.workers.dev/api/snapshot -Headers @{ Authorization = 'Bearer <线上令牌>' }
```

最后在网页的「开发者设置 → 云端同步」里填**同一个令牌**，电脑和手机各填一次即可。

---

## 5. 设计取舍（写给以后维护的自己）

- **为什么整包推拉，不拆表**：全部数据十几 KB、单用户。拆表就要处理
  「两台设备各改一条」的字段级合并，而合并规则写错是**静默**的 —— 数据被揉在一起，
  用户不知道从哪一步开始错的。单行快照把冲突简化成一个数字比较，行为可预测。
- **乐观锁为什么放在 SQL 的 WHERE 里**：`UPDATE ... WHERE id = 1 AND revision = ?`
  让「判断」和「写入」由数据库一句完成，中间没有空档；先 SELECT 再 UPDATE 是挡不住并发的。
- **为什么先鉴权再读 body**：没令牌的请求不该消耗解析 256KB 的 CPU；
  而且错误令牌的请求会先被 401 挡掉，不会因为我们后面的校验逻辑多花时间。
- **令牌为什么用定长时间比较**：`a === b` 在第一个不同字符处就返回，
  响应耗时的差别能被用来一位一位试出令牌。`sameToken()` 把所有位置都比完才出结果。
- **失败即拒绝**：没配 `SYNC_TOKEN` 时一律 401。配置漏了顶多同步用不了，
  绝不能变成「谁都能读写我的数据」。

---

## 6. 已知的坑

1. **`database_id` 是占位符**：不换成真值，`wrangler deploy` 与自动构建都会失败。
   `--local` 的本地开发不受影响。
2. **令牌是唯一的一道门**：这套接口没有账号体系，谁拿到令牌就能读写全部数据。
   请用 32 位以上的随机串（`npx wrangler secret put` 输入，别写进 `wrangler.jsonc` 的 `vars`——
   那样会明文进仓库）。
3. **本地两套令牌**：`.dev.vars`（本地，已被 gitignore）和线上 secret 互不相干，
   线上测的时候别拿本地的串去试。
4. **`/api` 不能被缓存**：响应已经带了 `Cache-Control: no-store`。
   以后如果在 Cloudflare 面板加缓存规则，务必把 `/api/*` 排除掉 ——
   一个被缓存的 GET /api/snapshot 会让客户端读到旧 revision，然后每次推送都撞 409。
5. **上限写了两份**：前端 `src/lib/sync.ts` 里的 `MAX_TOOLS` / `MAX_PAYLOAD_BYTES`
   和这里 `worker/index.ts` 的两个常量要一起改。前端那份是为了少跑一趟，后端这份才是真正的门。
6. **单用户前提下才成立**：现在「云端胜」的策略对一个人多台设备是合理的，
   一旦要多用户，`snapshot` 表就得加 `user_id` 并换成按用户分行的设计。
7. **D1 是单主库**：写入天然串行，所以乐观锁在 D1 上是严格成立的。
   将来如果启用 read replication 并让写入走副本，这条前提要重新确认。
8. **`single-page-application` 回落和 `/api` 的先后顺序，部署后必须验一次**：
   现在的路由规则是「先找静态资源，找不到才进 Worker」，所以 `/api/*` 会进 Worker，
   Worker 再把非 `/api` 的请求交回 `env.ASSETS`（那时才轮到 SPA 回落成 index.html）。
   但这依赖平台行为，上线后请确认一次：

   ```powershell
   curl.exe -i https://<你的域名>/api/snapshot
   ```

   期望是 `401` + `{"error":"unauthorized"}` 的 **JSON**。
   如果返回的是 `index.html`（HTML），说明 SPA 回落抢在了 Worker 前面 ——
   这时要在 `wrangler.jsonc` 的 `assets` 里补一行 `"run_worker_first": ["/api/*"]`，
   让它强制把 `/api/*` 交给 Worker。
