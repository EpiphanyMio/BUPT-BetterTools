// 文件管理的存储层：用浏览器的 IndexedDB 存文件和文件夹。
//
// 为什么不用 localStorage：
//   ① 它只能存字符串。图片/PDF 要先转成 base64 文本，体积会膨胀约三分之一；
//   ② 它的总容量只有约 5 MB，存两个 PDF 就满了。
//   IndexedDB 是浏览器专门为"大块二进制数据"设计的数据库，
//   配额通常是磁盘剩余空间的很大一部分（几百 MB 到几 GB）。
//
// 这里建三张表（IndexedDB 里叫 object store）：
//   nodes  —— 文件和文件夹的"名册"（名称、大小、在哪个文件夹里……）
//   blobs  —— 文件的实际内容（二进制）
//   outbox —— 等待上传到云端的改动队列（DB 版本 2 新增）
//
// 为什么 nodes 和 blobs 分成两张表：打开一个文件夹时只需要读 nodes，
// 不用把所有文件的内容都读进内存 —— 否则文件夹里放几个大 PDF 就会卡。
//
// 为什么 outbox 要落盘：登录后文件会同步到云端，但上传是"稍后有空再做"的事。
// 关标签页 / 断网 / 崩溃都可能发生在"本地已改、云端还没收到"之间；
// 队列写进 IndexedDB，下次打开还能接着传（详见下面 outbox 那一节）。

import { isGuest } from './guestMode'
import { getSessionToken } from './auth'
import { MAX_FILE_BYTES, fetchContent, type CloudNode } from './fileCloud'

const DB_NAME = 'better-tools-files'
// ⚠️ 版本 2 只做一件事：新增 outbox 表。
// IndexedDB 升级时不会动已存在的表，所以老用户本机原有的 nodes / blobs 一条都不会丢。
const DB_VERSION = 2
const NODES = 'nodes'
const BLOBS = 'blobs'
const OUTBOX = 'outbox'

export interface FileNode {
  id: string
  name: string
  kind: 'folder' | 'file'
  // 所在文件夹的 id。空字符串表示在根目录。
  // （不用 null 是因为 IndexedDB 的索引**不能索引 null**，
  //   带 null 的记录不会出现在索引里，查"根目录下有什么"就会查不到。）
  parentId: string
  size: number
  mime: string
  createdAt: number
  updatedAt: number
}

export interface FileStats {
  fileCount: number
  folderCount: number
  bytes: number
}

// ---------- 底层：把 IndexedDB 的回调 API 包装成 Promise ----------
//
// IndexedDB 是十几年前的设计，全部用回调（onsuccess / onerror）。
// 直接写会一层套一层，很难读。这里统一包一层，之后就能用 await 了。

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  // 缓存住，避免每次操作都重新打开
  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    // 数据库第一次创建、或版本号变大时触发，在这里建表
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(NODES)) {
        const store = db.createObjectStore(NODES, { keyPath: 'id' })
        // 按 parentId 建索引，"列出某个文件夹里的东西"才查得快
        store.createIndex('parentId', 'parentId', { unique: false })
      }
      if (!db.objectStoreNames.contains(BLOBS)) {
        db.createObjectStore(BLOBS, { keyPath: 'id' })
      }
      // 同步队列：seq 自增，天然记录"谁先谁后"；上传按 seq 顺序消费。
      if (!db.objectStoreNames.contains(OUTBOX)) {
        db.createObjectStore(OUTBOX, { keyPath: 'seq', autoIncrement: true })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

  return dbPromise
}

function toPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

// 等一次"事务"真正提交完成。
// 注意：单个请求的 onsuccess 只代表这一次操作成功，
// 要确认整批写入都落盘了，得等事务的 oncomplete。
function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

function createId(prefix: string) {
  try {
    return prefix + '-' + crypto.randomUUID()
  } catch {
    return prefix + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  }
}

// 文件夹排在前面，然后按名称排（用中文排序规则，大致按拼音）
function compareNodes(a: FileNode, b: FileNode) {
  if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
  return a.name.localeCompare(b.name, 'zh-Hans-CN')
}

// ---------- 同步队列（outbox）：本地改动 → 待上传 ----------
//
// 记录只追加、不修改；同步成功一条删一条。seq 是自增主键，
// 天然就是"写入顺序"，上传也按这个顺序（先传节点，再传内容，最后删）。
//
// 为什么有会话才入队：访客 / 未登录时本地文件不属于任何账号，
// 记了队列反而危险 —— 下一个人登录时会把上一个人的改动推到他账号里。
// 登录后的第一次同步由 applyRemoteTree 把"本地有、云端没有"的节点重新入队（首次迁移）。

export interface FileOp {
  /** 自增序号：既是主键，也是"先来先传"的顺序依据 */
  seq: number
  type: 'node' | 'content' | 'delete'
  /** content 操作对应的节点 id */
  nodeId?: string
  /** node 操作要上传的节点元数据 */
  node?: FileNode
  /** delete 操作要删除的整棵子树的 id */
  ids?: string[]
  createdAt: number
}

/** 入队时还没有 seq / createdAt：前者由数据库自增，后者入队那一刻再补。 */
type FileOpInput = Omit<FileOp, 'seq' | 'createdAt'>

function hasSession(): boolean {
  return getSessionToken().length > 0
}

/** 通知界面 / 同步引擎："文件有变化，该刷新 / 该传了"。 */
function notifyFilesDirty(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event('better-tools:files-dirty'))
}

/**
 * 把几条操作排进队列，然后广播"文件有变化"。
 *
 * 入队失败不让写操作整体失败：本地数据已经落好了，下一次同步时
 * applyRemoteTree 会发现"本地有、云端没有"并重新入队，改动不会丢。
 */
async function enqueueOps(ops: FileOpInput[]): Promise<void> {
  if (ops.length === 0 || !hasSession()) return
  const now = Date.now()
  try {
    const db = await openDb()
    const tx = db.transaction(OUTBOX, 'readwrite')
    const store = tx.objectStore(OUTBOX)
    for (const op of ops) store.add({ ...op, createdAt: now })
    await txDone(tx)
  } catch {
    // 见函数注释：靠下次同步的"本地孤儿重新入队"兜底
  }
  notifyFilesDirty()
}

/** 按写入顺序列出待上传的改动。 */
export async function listFileOps(): Promise<FileOp[]> {
  const db = await openDb()
  const tx = db.transaction(OUTBOX, 'readonly')
  const rows = (await toPromise(tx.objectStore(OUTBOX).getAll() as IDBRequest<FileOp[]>)) ?? []
  return rows.sort((a, b) => a.seq - b.seq)
}

/** 一条改动成功传到云端后，从队列里删掉它。 */
export async function removeFileOp(seq: number): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(OUTBOX, 'readwrite')
  tx.objectStore(OUTBOX).delete(seq)
  await txDone(tx)
}

/** 还有多少条改动没传上去（界面显示"待同步 N 条"用）。 */
export async function countFileOps(): Promise<number> {
  const db = await openDb()
  const tx = db.transaction(OUTBOX, 'readonly')
  return (await toPromise(tx.objectStore(OUTBOX).count())) ?? 0
}

/**
 * 清空整个文件库（名册 + 内容 + 待上传队列）。
 *
 * 只有一个调用方：登录的账号换了人（见 fileSync 里的「存档主人」判断）。
 * 为什么要清：这份缓存属于上一个账号，留着会在新账号第一次同步时被当成
 * 「本地有、云端没有」的孤儿文件**上传到新账号**，等于把别人的文件泄漏给他。
 * 云端那份还在，旧账号重新登录会重新拉下来。
 */
export async function resetFileStore(): Promise<void> {
  const db = await openDb()
  const tx = db.transaction([NODES, BLOBS, OUTBOX], 'readwrite')
  tx.objectStore(NODES).clear()
  tx.objectStore(BLOBS).clear()
  tx.objectStore(OUTBOX).clear()
  await txDone(tx)
}

// ---------- 对外接口 ----------

/** 列出某个文件夹里的内容。parentId 传空字符串就是根目录。 */
export async function listChildren(parentId: string): Promise<FileNode[]> {
  const db = await openDb()
  const tx = db.transaction(NODES, 'readonly')
  const index = tx.objectStore(NODES).index('parentId')
  const rows = (await toPromise(index.getAll(parentId) as IDBRequest<FileNode[]>)) ?? []
  return rows.sort(compareNodes)
}

/** 从某个文件夹一路往上找到根，用来画"首页 › 课件 ›"这样的面包屑 */
export async function getPath(folderId: string): Promise<FileNode[]> {
  if (!folderId) return []

  const db = await openDb()
  const tx = db.transaction(NODES, 'readonly')
  const all = (await toPromise(tx.objectStore(NODES).getAll() as IDBRequest<FileNode[]>)) ?? []

  const byId = new Map(all.map((node) => [node.id, node]))
  const chain: FileNode[] = []
  let cursor: string | undefined = folderId

  // 加一个次数上限，万一数据里出现环也不会死循环
  for (let guard = 0; cursor && guard < 100; guard++) {
    const node = byId.get(cursor)
    if (!node) break
    chain.unshift(node)
    cursor = node.parentId || undefined
  }
  return chain
}

export async function createFolder(name: string, parentId: string): Promise<FileNode> {
  // 访客预览是「只读」的：界面上的禁用只是提示，真正的保证在这一层。
  // 下面每个写操作入口都先问一次 isGuest()。
  // 这里选择**抛错**而不是静默 return —— 调用方已经 catch 并把 message 显示给用户，
  // 抛错能让人明确知道"这次操作被拒绝了"，静默返回则会显得像是成功但看不到东西。
  if (isGuest()) throw new Error('访客预览模式下不能修改文件')
  const now = Date.now()
  const node: FileNode = {
    id: createId('folder'),
    name: name.trim(),
    kind: 'folder',
    parentId,
    size: 0,
    mime: '',
    createdAt: now,
    updatedAt: now,
  }

  const db = await openDb()
  const tx = db.transaction(NODES, 'readwrite')
  tx.objectStore(NODES).put(node)
  await txDone(tx)

  // 本地已经写成功 → 有会话就排进上传队列（没有会话时 enqueueOps 自己会跳过）
  await enqueueOps([{ type: 'node', node }])
  return node
}

/** 上传一个文件：名册和内容写在同一个事务里，要么都成功、要么都不写 */
export async function addFile(
  file: File,
  parentId: string,
  overrideName?: string,
): Promise<FileNode> {
  // 访客只读：不许上传
  if (isGuest()) throw new Error('访客预览模式下不能修改文件')
  // 超过云端单文件上限的大文件，传到一半必然 413，不如在入口就拦下来并说清楚原因
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`单个文件不能超过 ${MAX_FILE_BYTES / 1024 / 1024} MB`)
  }
  const now = Date.now()
  const node: FileNode = {
    id: createId('file'),
    name: overrideName ?? file.name,
    kind: 'file',
    parentId,
    size: file.size,
    mime: file.type,
    createdAt: now,
    updatedAt: now,
  }

  const db = await openDb()
  // 传数组 = 跨两张表的事务，保证不会出现"有名字没内容"的半截数据
  const tx = db.transaction([NODES, BLOBS], 'readwrite')
  tx.objectStore(NODES).put(node)
  tx.objectStore(BLOBS).put({ id: node.id, blob: file })
  await txDone(tx)

  // node 在前、content 在后：服务端必须先收到节点，内容才有地方挂
  await enqueueOps([
    { type: 'node', node },
    { type: 'content', nodeId: node.id },
  ])
  return node
}

export async function renameNode(id: string, name: string): Promise<void> {
  // 访客只读：不许改名
  if (isGuest()) throw new Error('访客预览模式下不能修改文件')
  const db = await openDb()

  const readTx = db.transaction(NODES, 'readonly')
  const node = await toPromise(
    readTx.objectStore(NODES).get(id) as IDBRequest<FileNode | undefined>,
  )
  if (!node) return

  const writeTx = db.transaction(NODES, 'readwrite')
  const updated: FileNode = { ...node, name: name.trim(), updatedAt: Date.now() }
  writeTx.objectStore(NODES).put(updated)
  await txDone(writeTx)

  await enqueueOps([{ type: 'node', node: updated }])
}

/**
 * 广度优先：把若干节点**连同它们的全部子孙**收集成一个 id 列表。
 *
 * 为什么必须连子孙一起删：只删掉文件夹本身的话，里面的文件会变成
 * "占着磁盘空间、却在界面上谁也找不到"的孤儿数据 —— 永远删不掉也看不见。
 */
function collectSubtree(all: FileNode[], roots: string[]): string[] {
  const collected = new Set<string>(roots)
  let frontier = [...roots]

  while (frontier.length > 0) {
    const children = all
      .filter((node) => frontier.includes(node.parentId))
      .map((node) => node.id)
      .filter((id) => !collected.has(id))
    if (children.length === 0) break
    children.forEach((id) => collected.add(id))
    frontier = children
  }
  return [...collected]
}

/** 删除一个文件或文件夹（连同里面的全部内容），返回实际删掉的条目数 */
export async function deleteNode(id: string): Promise<number> {
  // 访客只读：不许删
  if (isGuest()) throw new Error('访客预览模式下不能修改文件')
  return deleteNodes([id])
}

/** 批量删除，返回实际删掉的条目数（含被连带删除的子孙） */
export async function deleteNodes(ids: string[]): Promise<number> {
  // 访客只读：删除是最危险的一个写操作（会连带删掉整个子树）
  if (isGuest()) throw new Error('访客预览模式下不能修改文件')
  if (ids.length === 0) return 0
  const db = await openDb()

  const readTx = db.transaction(NODES, 'readonly')
  const all = (await toPromise(readTx.objectStore(NODES).getAll() as IDBRequest<FileNode[]>)) ?? []

  const targets = collectSubtree(all, ids)

  const tx = db.transaction([NODES, BLOBS], 'readwrite')
  const nodeStore = tx.objectStore(NODES)
  const blobStore = tx.objectStore(BLOBS)
  for (const target of targets) {
    nodeStore.delete(target)
    blobStore.delete(target) // 文件夹没有内容，删了也无妨
  }
  await txDone(tx)

  // 整棵子树的 id 一起交给云端：服务端据此写墓碑、删 R2 对象、回收配额
  await enqueueOps([{ type: 'delete', ids: targets }])
  return targets.length
}

// ---------- 云端目录树 → 本地缓存 ----------

/**
 * 用云端目录树更新本地缓存。同步流程每轮都先做这一步。
 *
 * 四条规则（顺序就是正确性的关键）：
 *   ① 远端墓碑（deleted=true）→ 删本地节点 + 内容缓存（连同本地子树）；
 *   ② 远端活的节点 → 本地没有就建（只建元数据，内容以后按需拉）；
 *      本地有就以远端为准覆盖（服务端时间可信，**不看时间戳**）；
 *   ③ 本地有、远端没有 → 说明是登录前就存在 / 上次没传成功，
 *      重新入队 node 上传（文件再加一条 content 传内容）；首次迁移就靠这条；
 *   ④ 本地有 pending 操作的节点，远端既不能删也不能覆盖 —— 本地改动优先，稍后推上去。
 *
 * 为什么要"本地子树跟着墓碑一起删"：后端墓碑可能只标在被删文件夹的根上，
 * 不连带删本地子节点的话，它们会变成"父目录不存在"的孤儿，随后被规则③
 * 当成迁移数据重新传回云端 —— 用户会看到已经删掉的文件自己复活。
 */
export async function applyRemoteTree(remote: CloudNode[]): Promise<void> {
  const db = await openDb()

  const nodesTx = db.transaction(NODES, 'readonly')
  const local =
    (await toPromise(nodesTx.objectStore(NODES).getAll() as IDBRequest<FileNode[]>)) ?? []
  const opsTx = db.transaction(OUTBOX, 'readonly')
  const ops = (await toPromise(opsTx.objectStore(OUTBOX).getAll() as IDBRequest<FileOp[]>)) ?? []

  const localById = new Map(local.map((node) => [node.id, node]))
  const remoteById = new Map(remote.map((node) => [node.id, node]))

  // ④ 先把"本地有未推改动"的节点 id 收集起来，下面每一步都拿它当免死金牌
  const pending = new Set<string>()
  for (const op of ops) {
    if (op.type === 'node' && op.node) pending.add(op.node.id)
    else if (op.type === 'content' && op.nodeId) pending.add(op.nodeId)
    else if (op.type === 'delete' && op.ids) for (const id of op.ids) pending.add(id)
  }

  // ① 远端墓碑。有 pending 的节点除外：本地刚才的删除 / 改名还没推上去，不能被回滚
  const tombstoned = new Set<string>()
  for (const cloud of remote) {
    if (cloud.deleted && !pending.has(cloud.id)) tombstoned.add(cloud.id)
  }

  // 顺着本地父子关系判断"这个节点是不是在被删掉的文件夹里"
  function isUnderTombstone(node: FileNode): boolean {
    let cursor = node.parentId
    // 加次数上限，万一数据里出现环也不会死循环
    for (let guard = 0; cursor && guard < 100; guard++) {
      if (tombstoned.has(cursor)) return true
      const parent = localById.get(cursor)
      if (!parent) return false
      cursor = parent.parentId
    }
    return false
  }

  const removed = new Set<string>()
  for (const node of local) {
    if (pending.has(node.id)) continue
    // 远端说它还活着就听远端的（规则②优先于级联删除）
    const cloud = remoteById.get(node.id)
    if (cloud && !cloud.deleted) continue
    if (!tombstoned.has(node.id) && !isUnderTombstone(node)) continue
    removed.add(node.id)
  }

  // ② 远端活节点：本地没有就建、本地有就覆盖
  const writes: FileNode[] = []
  const staleBlobIds = new Set<string>()
  for (const cloud of remote) {
    if (cloud.deleted) continue
    if (pending.has(cloud.id)) continue
    if (removed.has(cloud.id)) continue

    const existing = localById.get(cloud.id)
    if (!existing) {
      // 只在云端有的节点：先只建"名册"，内容等真正打开时再按需拉（省流量、省启动时间）
      writes.push({
        id: cloud.id,
        name: cloud.name,
        kind: cloud.kind,
        parentId: cloud.parentId,
        size: cloud.size,
        mime: cloud.mime,
        createdAt: cloud.updatedAt,
        updatedAt: cloud.updatedAt,
      })
      continue
    }

    const merged: FileNode = {
      id: cloud.id,
      name: cloud.name,
      kind: cloud.kind,
      parentId: cloud.parentId,
      size: cloud.size,
      mime: cloud.mime,
      createdAt: existing.createdAt,
      updatedAt: cloud.updatedAt,
    }
    // 字段都没变就不写：每次同步都无谓写一遍几千行会拖慢启动
    if (
      existing.name === merged.name &&
      existing.kind === merged.kind &&
      existing.parentId === merged.parentId &&
      existing.size === merged.size &&
      existing.mime === merged.mime &&
      existing.updatedAt === merged.updatedAt
    ) {
      continue
    }
    writes.push(merged)
    // 大小变了 = 内容被重新上传过，本机缓存那份过期了，删掉让 getBlob 重新拉
    if (existing.kind === 'file' && existing.size !== merged.size) staleBlobIds.add(cloud.id)
  }

  // ③ 本地有、远端没有 → 重新入队，补传上去（首次登录迁移老文件也走这条）
  const migration: FileNode[] = []
  for (const node of local) {
    if (pending.has(node.id)) continue
    if (remoteById.has(node.id)) continue
    if (removed.has(node.id)) continue
    migration.push(node)
  }
  // 父节点必须先传：服务端收到子节点时，父亲最好已经存在
  function depthOf(node: FileNode): number {
    let depth = 0
    let cursor = node.parentId
    for (let guard = 0; cursor && guard < 100; guard++) {
      depth++
      const parent = localById.get(cursor)
      if (!parent) break
      cursor = parent.parentId
    }
    return depth
  }
  migration.sort((a, b) => depthOf(a) - depthOf(b))

  const queueMigration = migration.length > 0 && hasSession()
  if (removed.size === 0 && writes.length === 0 && !queueMigration) return

  // 删除 + 覆盖 + 重新入队放在同一个事务里：要么全成、要么全不动
  const tx = db.transaction([NODES, BLOBS, OUTBOX], 'readwrite')
  const nodeStore = tx.objectStore(NODES)
  const blobStore = tx.objectStore(BLOBS)
  for (const id of removed) {
    nodeStore.delete(id)
    blobStore.delete(id)
  }
  for (const node of writes) nodeStore.put(node)
  for (const id of staleBlobIds) blobStore.delete(id)
  if (queueMigration) {
    const outbox = tx.objectStore(OUTBOX)
    const now = Date.now()
    for (const node of migration) {
      outbox.add({ type: 'node', node, createdAt: now })
      // 文件本体也要一起补传：迁移的不只是"名册"，内容还在本机 blobs 里。
      // （契约规则③只写了"重新入队 node"；但只传元数据的话，别的设备打开这些
      //   文件会永远拿到 404 —— 所以文件必须再排一条 content。pushOp 遇到本机
      //   没有内容时会自动跳过，不会卡住队列。）
      if (node.kind === 'file') outbox.add({ type: 'content', nodeId: node.id, createdAt: now })
    }
  }
  await txDone(tx)

  // 本地缓存真的变了 → 通知界面刷新。同步引擎也监听这个事件，
  // 于是会再跑一轮把刚入队的迁移节点传上去；那一轮没有变化就不会再广播，不会无限循环。
  notifyFilesDirty()
}

/** 只读本机缓存，**不联网**。同步流程上传内容前用它取 Blob。 */
export async function getBlobCached(id: string): Promise<Blob | null> {
  try {
    const db = await openDb()
    const tx = db.transaction(BLOBS, 'readonly')
    const row = await toPromise(
      tx.objectStore(BLOBS).get(id) as IDBRequest<{ id: string; blob: Blob } | undefined>,
    )
    return row ? row.blob : null
  } catch {
    // 读缓存失败按"没有缓存"处理，调用方自己决定要不要联网
    return null
  }
}

/** 把从云端拉下来的内容写进本机缓存（失败只影响下次还得再拉一遍，不影响本次使用）。 */
async function cacheBlob(id: string, blob: Blob): Promise<void> {
  try {
    const db = await openDb()
    const tx = db.transaction(BLOBS, 'readwrite')
    tx.objectStore(BLOBS).put({ id, blob })
    await txDone(tx)
  } catch {
    // 缓存写不进去就算了：内容已经在内存里，这次照样能打开
  }
}

/**
 * 取出文件内容。返回 Blob（一段可以直接给浏览器用的二进制数据）。
 *
 * 先读本机缓存；没有缓存且已登录，就去云端拉一份、顺手写回缓存
 * （下次断网也能打开）。断网 / 没权限 / 云端也没有 → 返回 null，**不抛错**：
 * 打开文件失败只该让界面提示一句，不该冒到 React 事件里把页面搞崩。
 */
export async function getBlob(id: string): Promise<Blob | null> {
  const cached = await getBlobCached(id)
  if (cached) return cached

  // 访客 / 未登录没有身份去云端取，本地没有就是没有
  if (!hasSession()) return null

  try {
    const remote = await fetchContent(id)
    if (!remote) return null
    await cacheBlob(id, remote)
    return remote
  } catch {
    return null
  }
}

export async function getStats(): Promise<FileStats> {
  const db = await openDb()
  const tx = db.transaction(NODES, 'readonly')
  const all = (await toPromise(tx.objectStore(NODES).getAll() as IDBRequest<FileNode[]>)) ?? []

  let fileCount = 0
  let folderCount = 0
  let bytes = 0
  for (const node of all) {
    if (node.kind === 'folder') folderCount++
    else {
      fileCount++
      bytes += node.size || 0
    }
  }
  return { fileCount, folderCount, bytes }
}

/** 问浏览器：这块站点大概还能用多少空间 */
export async function getQuota(): Promise<{ usage: number; quota: number } | null> {
  try {
    if (!navigator.storage || !navigator.storage.estimate) return null
    const estimate = await navigator.storage.estimate()
    return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 }
  } catch {
    return null
  }
}

/**
 * 申请"持久化存储"。
 * 默认情况下浏览器在磁盘紧张时**可以自行清掉**站点的数据；
 * 申请通过后，除非用户主动清理，数据不会被自动回收。
 * 这对"存个人文件"很关键，所以进文件管理时会自动申请一次。
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (!navigator.storage || !navigator.storage.persist) return false
    if (await navigator.storage.persisted()) return true
    return await navigator.storage.persist()
  } catch {
    return false
  }
}

/** 判断 candidateId 是不是 ancestorId 的子孙（用来拦住"把文件夹拖进它自己里面"） */
function isDescendant(all: FileNode[], candidateId: string, ancestorId: string): boolean {
  const byId = new Map(all.map((node) => [node.id, node]))
  let cursor = byId.get(candidateId)?.parentId

  // 加次数上限，万一数据里出现环也不会死循环
  for (let guard = 0; cursor && guard < 100; guard++) {
    if (cursor === ancestorId) return true
    cursor = byId.get(cursor)?.parentId
  }
  return false
}

/**
 * 把一个文件或文件夹移到另一个文件夹里（targetParentId 传空字符串 = 根目录）。
 *
 * 会拦住两种非法操作：
 *   same  —— 目标就是它现在所在的文件夹，等于没动
 *   cycle —— 把文件夹移进它自己的子孙里。这会让那段数据从根目录"断开"，
 *            从此谁也走不到，还会在遍历时绕圈。
 */
export async function moveNode(
  id: string,
  targetParentId: string,
): Promise<'ok' | 'same' | 'cycle'> {
  // 访客只读：不许移动
  if (isGuest()) throw new Error('访客预览模式下不能修改文件')
  const db = await openDb()

  const readTx = db.transaction(NODES, 'readonly')
  const all = (await toPromise(readTx.objectStore(NODES).getAll() as IDBRequest<FileNode[]>)) ?? []

  const node = all.find((item) => item.id === id)
  if (!node) return 'same'
  if (node.parentId === targetParentId) return 'same'
  if (id === targetParentId) return 'cycle'
  if (node.kind === 'folder' && isDescendant(all, targetParentId, id)) return 'cycle'

  const writeTx = db.transaction(NODES, 'readwrite')
  const updated: FileNode = { ...node, parentId: targetParentId, updatedAt: Date.now() }
  writeTx.objectStore(NODES).put(updated)
  await txDone(writeTx)

  await enqueueOps([{ type: 'node', node: updated }])
  return 'ok'
}

/**
 * 名字重复时自动加序号：报告.pdf → 报告 (2).pdf
 *
 * taken 里放"已经被占用的名字"。统一转小写比较 ——
 * 因为 Windows 的文件系统不区分大小写，A.pdf 和 a.pdf 其实会互相覆盖。
 */
export function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) return name

  const dot = name.lastIndexOf('.')
  // dot > 0 而不是 >= 0：像 .gitignore 这种"点开头"的不算扩展名
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''

  for (let i = 2; i < 1000; i++) {
    const candidate = base + ' (' + i + ')' + ext
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  return base + ' (' + Date.now() + ')' + ext
}

export interface SearchHit {
  node: FileNode
  /** 所在文件夹的各级名称，用来在搜索结果里显示"它在哪" */
  pathNames: string[]
}

/** 在整个库里按文件名搜索（不区分大小写）。一次查询把每条的所在路径也算好。 */
export async function searchNodes(keyword: string): Promise<SearchHit[]> {
  const lower = keyword.trim().toLowerCase()
  if (!lower) return []

  const db = await openDb()
  const tx = db.transaction(NODES, 'readonly')
  const all = (await toPromise(tx.objectStore(NODES).getAll() as IDBRequest<FileNode[]>)) ?? []
  const byId = new Map(all.map((node) => [node.id, node]))

  function pathNamesOf(node: FileNode): string[] {
    const names: string[] = []
    let cursor = node.parentId
    for (let guard = 0; cursor && guard < 100; guard++) {
      const parent = byId.get(cursor)
      if (!parent) break
      names.unshift(parent.name)
      cursor = parent.parentId
    }
    return names
  }

  return all
    .filter((node) => node.name.toLowerCase().includes(lower))
    .sort(compareNodes)
    .map((node) => ({ node, pathNames: pathNamesOf(node) }))
}
