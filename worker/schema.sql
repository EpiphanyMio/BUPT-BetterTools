-- BetterTools 的 D1 建表语句（多用户版）。
--
-- ---------------------------------------------------------------- v1 → v2 变了什么
--
-- ① v1 只有一张 snapshot 表，永远只有 id = 1 这一行（单用户 + 一个共享令牌）。
--    现在账号体系进来了：users 存人、sessions 存登录态、invites 存注册闸门，
--    snapshot 改成**每个用户一行**（user_id 做主键）。
--
-- ② 线上库里已经躺着 v1 的那一行数据，不能丢。所以这个文件末尾是一段「重建表」的迁移，
--    跑完旧数据会挂在管理员名下；管理员本人由主程序插入，这里不插。
--
-- ③ 整个文件**可以重复执行**。这一点很重要 —— 迁移脚本最怕的就是
--    「跑到一半失败、再跑又报错、最后没人敢动线上库」。下面每一步都写成
--    「再来一次也只是空转」的形式。
--
-- 执行方式（本地开发库）：
--   npx wrangler d1 execute bupt-bettertools-sync --local --file=worker/schema.sql
-- 执行方式（线上库）：
--   npx wrangler d1 execute bupt-bettertools-sync --remote --file=worker/schema.sql
--
-- ---------------------------------------------------------------- 字段说明（为什么这么设计）
--
-- 时间一律用 INTEGER 存毫秒时间戳（Date.now()）：跨设备比较时不用管时区，
-- 也避免 SQLite 的 TEXT 日期格式和浏览器各有各的写法。

-- ---------------------------------------------------------------- 账号

-- username 上的 COLLATE NOCASE 是整个账号体系「不区分大小写」的落点：
-- 它让 UNIQUE 天然忽略大小写（EpiphanyMio 和 epiphanymio 不能同时存在），
-- 也让 WHERE username = ? 忽略大小写（登录时随便敲大小写都能进）。
-- 如果只在应用层做 toLowerCase，早晚会有一条写入路径忘了转，库里就会多出两个
-- 「看起来一样」的账号 —— 那是注册流程里最难查的一类 bug。
--
-- password_hash / salt / iterations 是 PBKDF2-SHA256 的三件套：
--   hash 64 位 hex、salt 32 位 hex、迭代次数（现在是 100000）。
-- 迭代次数进库而不是写死在代码里，是为了将来**能悄悄提高强度**：
-- 老账号按自己那一行记的次数校验，新账号用新次数，谁都不用重设密码。
--
-- is_admin 直接用 0 / 1：能发邀请码的人就是管理员，没有别的权限等级。
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    COLLATE NOCASE NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  salt          TEXT    NOT NULL,
  iterations    INTEGER NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

-- ---------------------------------------------------------------- 登录态

-- token_hash 存的是**令牌的 sha256**，不是令牌本身。明文令牌只在登录 / 注册那一刻
-- 交给客户端，之后再也拿不到 —— 整张表被拖走也拼不出能用的令牌。
-- expires_at 是 30 天后（毫秒时间戳），过期行会在登录时顺手清掉。
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------- 邀请码

-- 注册的唯一入口。used_by / used_at 为空表示还没被用。
-- 注册时用 UPDATE ... WHERE used_by IS NULL 抢码：只有改到 1 行的请求才能继续，
-- 所以同一个码不可能被两个请求同时用掉。靠的是数据库的写入串行，不是应用代码的自觉。
CREATE TABLE IF NOT EXISTS invites (
  code       TEXT    PRIMARY KEY,
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  used_by    INTEGER,
  used_at    INTEGER
);

-- ---------------------------------------------------------------- 快照：从「全库一行」到「每人一行」
--
-- 旧结构是 snapshot(id INTEGER PRIMARY KEY CHECK (id = 1), revision, updated_at, data)。
-- 难点在于 SQLite 没有「有条件的 DDL」—— 没有 ALTER TABLE IF EXISTS，
-- 也就没法写「如果这张表还是旧结构才改名」。于是这里的做法是：
-- 让每一步在「旧库」和「新库」两种情况下都成立，重复执行也不会报错。
--
--   ① 先按**旧结构**保证 snapshot 这个名字存在：全新库里建出来的是一张空表，
--      正好当过渡用；已经是新结构时这句是空转（IF NOT EXISTS）。
--   ② 按新结构另建一张 snapshot_v2。
--   ③ 把 snapshot 整表复制进 snapshot_v2。两张表都是 4 列、顺序也一致
--      （旧的 id 正好落到新的 user_id 上），所以 SELECT * 这一句对两种结构都成立；
--      重复执行时主键撞车由 OR IGNORE 吃掉。
--   ④ 删掉旧名字的表，再把 snapshot_v2 改名回 snapshot。
--
-- 为什么不用「ALTER TABLE snapshot ADD COLUMN user_id」：旧表的主键还是 id、
-- 还带着 CHECK (id = 1)，加一列也照样只能存一行，等于没迁移。

CREATE TABLE IF NOT EXISTS snapshot (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  revision   INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  data       TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshot_v2 (
  user_id    INTEGER PRIMARY KEY,
  revision   INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  data       TEXT    NOT NULL
);

INSERT OR IGNORE INTO snapshot_v2 (user_id, revision, updated_at, data)
SELECT * FROM snapshot;

-- 旧那行的 id 恒为 1，复制过来就是 user_id = 1。管理员如果是库里第一个用户，
-- 他的 id 正好也是 1，上面那句复制完就已经挂对了，下面这段是空转。
--
-- 只有「管理员不是 1 号」时才需要挪。条件是 NOT EXISTS(users.id = 1)：
-- 只有当 1 号用户根本不存在时，这行快照才可能是「没人认领的旧数据」。
-- 反过来，如果 1 号是个真实存在的用户，把他的数据挪走就是**偷数据**，宁可不动。
--
-- 所以正确的部署顺序是：先执行本文件，再插入管理员（他自然拿到 id = 1）。
-- 万一管理员已经是别的 id，**再执行一次本文件**就会把这行改挂到管理员名下。
UPDATE OR IGNORE snapshot_v2
   SET user_id = (SELECT id FROM users WHERE username = 'EpiphanyMio' COLLATE NOCASE)
 WHERE user_id = 1
   AND NOT EXISTS (SELECT 1 FROM users WHERE id = 1)
   AND (SELECT id FROM users WHERE username = 'EpiphanyMio' COLLATE NOCASE) IS NOT NULL;

DROP TABLE IF EXISTS snapshot;

ALTER TABLE snapshot_v2 RENAME TO snapshot;

-- ---------------------------------------------------------------- 文件管理（云端）
--
-- 为什么单独建表、不塞进上面那行 snapshot：
--   ① 快照是整包覆盖，上限 256KB，几百个文件的目录树就塞不下了；
--   ② 改一个文件名要重传整包，两台设备同时改还会互相覆盖。
--   拆成「每人一批节点行」之后，每次只动自己那一行，冲突面小得多。
--
-- 文件内容**不在这里** —— 二进制存在 R2，key 是 u/{user_id}/{id}，
-- 由 Worker 鉴权后读写（桶本身不公开）。这里只存名册。

-- 目录树。parent_id 用空字符串表示根目录，和前端 FileNode.parentId 保持一致
-- （不用 NULL：SQLite 里 NULL 不参与唯一/比较，前端还要到处判空，空串更省事）。
--
-- deleted 是「墓碑」而不是真删：一台设备离线删了文件，另一台设备下次拉树时
-- 必须知道「这条没了」，否则会把它当成本地新增又传回来。墓碑长期保留（一行几十字节）。
CREATE TABLE IF NOT EXISTS file_nodes (
  user_id    INTEGER NOT NULL,
  id         TEXT    NOT NULL,
  parent_id  TEXT    NOT NULL DEFAULT '',
  name       TEXT    NOT NULL,
  kind       TEXT    NOT NULL,              -- 'folder' | 'file'
  size       INTEGER NOT NULL DEFAULT 0,    -- 字节；文件夹恒为 0
  mime       TEXT    NOT NULL DEFAULT '',
  deleted    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,              -- 服务端时间，客户端不参与赋值
  PRIMARY KEY (user_id, id)
);

-- 列某个文件夹里的东西、按更新时间排序，都靠这个索引。
CREATE INDEX IF NOT EXISTS file_nodes_parent ON file_nodes(user_id, parent_id);
CREATE INDEX IF NOT EXISTS file_nodes_updated ON file_nodes(user_id, updated_at);

-- 每人已用字节数。上传 / 删除时在这里加减，配额判断只看这一个数，
-- 不用每次 SUM 一遍整棵树（SUM 在文件多了以后会越来越慢）。
CREATE TABLE IF NOT EXISTS file_usage (
  user_id    INTEGER PRIMARY KEY,
  bytes      INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- 公开分享链接。token 是随机串本身，不存哈希 —— 它只是「读某一个文件」的钥匙，
-- 泄露了也只影响那一个文件，而且随时可以撤销（revoked = 1）。
-- expires_at 为 NULL 表示永久有效。
CREATE TABLE IF NOT EXISTS file_shares (
  token      TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  node_id    TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS file_shares_user ON file_shares(user_id, node_id);

-- ---------------------------------------------------------------- 最近登录（用户组管理用）
--
-- 为什么单独建一张表，而不是给 users 加 last_login_at / last_login_ip 两列：
--   SQLite 没有「ADD COLUMN IF NOT EXISTS」，给已有表加列只能写成裸 ALTER TABLE ... ADD COLUMN，
--   而本文件的前提是**可以重复执行** —— 第二次跑就会报 duplicate column name，
--   整个 schema 从此没法用来给新库 / 老库对齐结构。
--   单独建表用 CREATE TABLE IF NOT EXISTS，天然是幂等的。
--
-- 为什么 user_id 直接当主键：
--   管理员页面只关心「最近一次」登录，不需要登录历史；主键挂在 user_id 上，
--   每个用户最多一行，写入就能用 INSERT ... ON CONFLICT(user_id) DO UPDATE 一句完成，
--   不用先 SELECT 再判断该 INSERT 还是 UPDATE。
--
-- 为什么 last_login_ip 默认空串、而不是允许 NULL：
--   接口契约里它是 string；空串表示「不知道来源 IP」。真用 NULL 的话，
--   读取侧要处处判空，拼接 / 比较前还得处理，和 file_nodes.parent_id 是同一个理由。
--   （这里只做兜底 —— Worker 会优先用 cf-connecting-ip，截断到 64 字符再写进来。）
--
-- ⚠️ 这张表是「可缺的」：Worker 代码可能先于本文件上线，在那之前登录 / 注册
--   照样必须成功。worker/index.ts 里写它的地方全部 catch 掉、只打日志，
--   所以这里晚执行一步不会把线上登录卡死。
CREATE TABLE IF NOT EXISTS login_records (
  user_id       INTEGER PRIMARY KEY,
  last_login_at INTEGER NOT NULL,
  last_login_ip TEXT    NOT NULL DEFAULT ''
);
