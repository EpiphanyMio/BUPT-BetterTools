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
