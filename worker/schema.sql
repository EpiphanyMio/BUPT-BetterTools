-- 「多端同步」的 D1 建表语句。
--
-- 整个数据库只有这一张表、永远只有一行（id = 1）。
--
-- 为什么是单行快照，而不是 tools / groups / favorites 各拆一张表：
--   这个应用全部的同步数据才十几 KB，又是单用户。拆表就要处理
--   "两台设备各改一条"的字段级合并，而合并规则写错是**静默**的 ——
--   数据被揉在一起，用户根本不知道从哪一步开始错的。
--   单行快照把冲突简化成一个数字比较：revision 对不上就 409，谁新谁赢，行为可预测。
--   以后真需要按条冲突处理时，再拆表也不迟。
--
-- 字段说明：
--   id         —— 永远是 1。CHECK (id = 1) 从数据库层面保证"只有一行"：
--                 以后谁手抖写了 INSERT ... VALUES (2, ...)，数据库直接拒掉，
--                 不会悄悄多出第二份数据、让"最新那行是哪行"变成哲学问题。
--   revision   —— 版本号，每成功写入一次 +1。客户端 PUT 时带的 baseRevision
--                 必须和它相等才能写成功，这就是乐观锁的全部。
--   updated_at —— 最后一次写入的时间（毫秒时间戳）。只给界面显示
--                 "上次同步于某某时刻"，**不参与**冲突判断：
--                 各台设备的系统时钟差几分钟很常见，拿它比新旧迟早判错。
--   data       —— 整份 SyncData 的 JSON 文本。存 TEXT 而不是拆成一列列：
--                 结构变化（比如以后 appSettings 多一个字段）不用改表结构，
--                 加个字段就行，不会有"线上表结构没跟上代码"的迁移事故。
--
-- 执行方式（本地开发库）：
--   npx wrangler d1 execute bupt-bettertools-sync --local --file=worker/schema.sql
-- 执行方式（线上库，创建数据库之后跑一次）：
--   npx wrangler d1 execute bupt-bettertools-sync --remote --file=worker/schema.sql

CREATE TABLE IF NOT EXISTS snapshot (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  revision   INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  data       TEXT    NOT NULL
);
