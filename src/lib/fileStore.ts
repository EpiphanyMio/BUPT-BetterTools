// 文件管理的存储层：用浏览器的 IndexedDB 存文件和文件夹。
//
// 为什么不用 localStorage：
//   ① 它只能存字符串。图片/PDF 要先转成 base64 文本，体积会膨胀约三分之一；
//   ② 它的总容量只有约 5 MB，存两个 PDF 就满了。
//   IndexedDB 是浏览器专门为"大块二进制数据"设计的数据库，
//   配额通常是磁盘剩余空间的很大一部分（几百 MB 到几 GB）。
//
// 这里建两张表（IndexedDB 里叫 object store）：
//   nodes —— 文件和文件夹的"名册"（名称、大小、在哪个文件夹里……）
//   blobs —— 文件的实际内容（二进制）
//
// 为什么分成两张表：打开一个文件夹时只需要读 nodes，
// 不用把所有文件的内容都读进内存 —— 否则文件夹里放几个大 PDF 就会卡。

import { isGuest } from './guestMode'

const DB_NAME = 'better-tools-files'
const DB_VERSION = 1
const NODES = 'nodes'
const BLOBS = 'blobs'

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
  writeTx.objectStore(NODES).put({ ...node, name: name.trim(), updatedAt: Date.now() })
  await txDone(writeTx)
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
  return targets.length
}

/** 取出文件内容。返回 Blob（一段可以直接给浏览器用的二进制数据）。 */
export async function getBlob(id: string): Promise<Blob | null> {
  const db = await openDb()
  const tx = db.transaction(BLOBS, 'readonly')
  const row = await toPromise(
    tx.objectStore(BLOBS).get(id) as IDBRequest<{ id: string; blob: Blob } | undefined>,
  )
  return row ? row.blob : null
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
  writeTx.objectStore(NODES).put({ ...node, parentId: targetParentId, updatedAt: Date.now() })
  await txDone(writeTx)
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
