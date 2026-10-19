// 文件云同步引擎：把本地改动排队推到云端，并把云端目录树合并回本地。
//
// ---------------------------------------------------------------- 为什么状态在模块顶层
//
// 和 src/lib/sync.ts 一个套路：同步状态全应用只有一份，界面用
// useSyncExternalStore 订阅（见 src/hooks/useFileSync.ts）。
// 各组件自己 useState 会出现"一处显示已同步、另一处显示同步中"的错位。
//
// ---------------------------------------------------------------- 一轮同步做什么
//
//   1. fetchTree()          —— 拉云端目录树（含墓碑）
//   2. applyRemoteTree()    —— 按"本地改动优先"的规则合并；本地有、云端没有的节点
//                              会在这一步重新入队（首次登录的老文件迁移就靠它）
//   3. 按 seq 顺序消费 outbox —— node 传元数据、content 传内容、delete 删节点；
//                              每成功一条删一条，所以断网 / 关页面都不会丢改动
//
// ---------------------------------------------------------------- 失败策略
//
//   op **留在队列里**，不删。断网 → offline，其它 → error（401 说"登录已失效"）。
//   10 秒后自动重试**一次**：一次是给短暂的网络抖动留机会，不无限重试是为了
//   别在服务器真挂了的时候每 10 秒打一次请求、还一直刷屏报错。
//   下一次用户改动 / 恢复联网 / 手动同步都会重新触发。
//
//   syncFilesNow 全程 catch，不把任何异常抛给界面 —— 同步失败只体现在状态上。
//
// ---------------------------------------------------------------- 触发时机
//
//   startFileSync() 由 App 在登录成功后调用；它立即同步一次，并监听：
//     · window 'online'                    —— 断网恢复，把压着的改动补传
//     · 'better-tools:files-dirty'         —— 本地写操作（fileStore 广播）
//   stopFileSync() 在退出登录 / 登录失效时调用，摘掉监听、清掉重试计时器。

import { getAuthState, getSessionToken } from './auth'
import {
  FileCloudError,
  fetchTree,
  pushDelete,
  pushNodes,
  uploadContent,
  type FileNodePayload,
} from './fileCloud'
import {
  applyRemoteTree,
  countFileOps,
  getBlobCached,
  listFileOps,
  removeFileOp,
  resetFileStore,
  type FileNode,
  type FileOp,
} from './fileStore'

export type FileSyncStatus = 'idle' | 'syncing' | 'synced' | 'offline' | 'error' | 'unauthenticated'

export interface FileSyncState {
  status: FileSyncStatus
  /** 还有多少条本地改动没传上去 */
  pending: number
  /** 上一次完整同步成功的时间戳（0 = 还没同步过） */
  lastSyncedAt: number
  /** 最近一次失败的中文说明，成功时清空 */
  lastError: string
}

// ---------------------------------------------------------------- 常量

// 本地写操作广播的事件名。fileStore 写成功后 dispatch，这里监听。
const DIRTY_EVENT = 'better-tools:files-dirty'

// 失败后等多久自动重试一次
const RETRY_MS = 10_000

// 连续写操作（比如一口气拖好几个文件）合并成一次同步：
// 每次都发请求会互相打架，也白费流量。
const DEBOUNCE_MS = 600

// ---------------------------------------------------------------- 模块级状态

const listeners = new Set<() => void>()

// 缓存的状态对象。⚠️ 只在真的变化时才换新对象，否则 useSyncExternalStore
// 会认为"一直在变"，不停重渲染（照 sync.ts 的 patchState 思路）。
let state: FileSyncState = {
  // 没有会话令牌就停在 unauthenticated，一个请求都不发
  status: getSessionToken() ? 'idle' : 'unauthenticated',
  pending: 0,
  lastSyncedAt: 0,
  lastError: '',
}

let started = false
let running = false
// 同步进行中又来了新改动 / 新触发：这一轮结束后必须再跑一轮
let rerun = false
// 当前这一轮是不是"10 秒自动重试"发起的。是的话失败了就不再排下一次，避免无限重试。
let retrying = false
// 正在把远端目录树写回本地。这期间 fileStore 也会广播 files-dirty，
// 但本轮紧接着就会消费 outbox，不需要再排一轮同步（否则每次改动多打一轮请求）。
let applyingRemote = false

let debounceTimer: ReturnType<typeof setTimeout> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null

// ---------------------------------------------------------------- 状态广播

/** 合并式更新状态。值都没变就保留旧对象（引用不变 → 订阅者不重渲染）。 */
function patchState(patch: Partial<FileSyncState>): void {
  const changed = (Object.keys(patch) as (keyof FileSyncState)[]).some(
    (key) => !Object.is(patch[key], state[key]),
  )
  if (!changed) return

  state = { ...state, ...patch }
  listeners.forEach((notify) => notify())
}

/**
 * 读当前状态。
 *
 * ⚠️ 返回的是缓存对象，调用方**只能读不能改**：在外面改字段会破坏
 * React 的 Object.is 比较，界面可能莫名其妙不更新。
 */
export function getFileSyncState(): FileSyncState {
  return state
}

/** 订阅同步状态，返回取消订阅的函数。 */
export function subscribeFileSync(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

// ---------------------------------------------------------------- 小工具

function hasSession(): boolean {
  return getSessionToken().length > 0
}

// 本机这份文件缓存属于哪个账号。放 localStorage：它只是"归属标记"，不是数据本身。
const OWNER_KEY = 'better-tools:files-owner'

/**
 * 确认本机缓存的主人还是当前登录的账号。
 *
 * 为什么必须有这一步：文件缓存在 IndexedDB 里是**按浏览器**存的，不按账号。
 * A 退出、B 登录后，A 的文件会被 applyRemoteTree 当成"本地有、云端没有"的孤儿，
 * 直接上传进 B 的账号 —— 这是静默的跨账号泄漏。所以换人时先清空本地缓存：
 * 云端那份还在，A 下次登录会重新拉回来。
 *
 * 第一次运行（标记为空）**不清**：那是升级前就存在本机的老文件，
 * 正好借这轮同步迁移到当前账号。
 */
async function ensureFileStoreOwner(): Promise<void> {
  const userId = getAuthState().user?.id
  if (!userId) return

  const current = String(userId)
  let saved = ''
  try {
    saved = localStorage.getItem(OWNER_KEY) ?? ''
  } catch {
    // localStorage 用不了（隐私模式）：没法判断归属，宁可不清，也不能误删用户文件
    return
  }

  if (saved === current) return
  if (saved !== '') await resetFileStore()

  try {
    localStorage.setItem(OWNER_KEY, current)
  } catch {
    // 存不进去只影响下次判断；这次已经清过了，不会重复泄漏
  }
}

function clearDebounceTimer(): void {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
}

function clearRetryTimer(): void {
  if (retryTimer !== null) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
}

/** 把各类异常翻译成"状态 + 一句人话"，界面直接显示。 */
function describeError(err: unknown): { status: FileSyncStatus; message: string } {
  if (err instanceof FileCloudError) {
    if (err.status === 401) return { status: 'error', message: '登录已失效，请重新登录' }
    if (err.status >= 500) {
      return { status: 'error', message: `服务器出错了（${err.status}），稍后会自动重试` }
    }
    return { status: 'error', message: err.message || '同步失败' }
  }

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { status: 'offline', message: '设备没有联网，改动先留在本地' }
  }

  // fetch 只在"根本没连上"时抛 TypeError（断网、域名解析失败、服务没起来）
  if (err instanceof TypeError) {
    return { status: 'offline', message: '连不上服务器，改动先留在本地' }
  }

  const message = err instanceof Error && err.message ? err.message : '同步失败，原因不明'
  return { status: 'error', message }
}

/** 把本地 FileNode 裁成云端接受的形状（deleted / updatedAt 由服务端算）。 */
function toPayload(node: FileNode): FileNodePayload {
  return {
    id: node.id,
    parentId: node.parentId,
    name: node.name,
    kind: node.kind,
    size: node.size,
    mime: node.mime,
    // 老数据没有 scope → 按 private 推上去，服务端不传也是 private，行为一致
    scope: node.scope === 'public' ? 'public' : 'private',
  }
}

// ---------------------------------------------------------------- 单条 outbox 操作

/**
 * 处理一条待上传改动。**会抛错**（由 runSync 统一兜住并保留 op）。
 *
 * 内容传不上去（本机没有缓存）时直接当成功：这条 op 留着也永远不会成功，
 * 而文件内容在别的设备上仍然在云端，不该堵住后面所有操作。
 */
async function pushOp(op: FileOp): Promise<void> {
  if (op.type === 'node') {
    if (!op.node) return
    await pushNodes([toPayload(op.node)])
    return
  }

  if (op.type === 'content') {
    if (!op.nodeId) return
    const blob = await getBlobCached(op.nodeId)
    if (!blob) return // 本机没有内容可传（例如只在别的设备上创建过），跳过
    try {
      await uploadContent(op.nodeId, blob)
    } catch (err) {
      // 404 = 云端这个节点已经不存在了（可能被别的设备删掉），这条内容没用了。
      // 当成成功，别让它永远卡在队列里。
      if (err instanceof FileCloudError && err.status === 404) return
      throw err
    }
    return
  }

  // delete：整棵子树的 id 一起交给服务端
  if (!op.ids || op.ids.length === 0) return
  await pushDelete(op.ids)
}

// ---------------------------------------------------------------- 一轮同步

async function runSync(): Promise<void> {
  if (!hasSession()) {
    patchState({ status: 'unauthenticated' })
    return
  }

  if (running) {
    // 上一轮还没结束：记一笔，结束后补跑，不要叠着发请求
    rerun = true
    return
  }

  running = true
  patchState({ status: 'syncing', lastError: '' })

  try {
    // 换账号时先清掉上一个账号的本机缓存，否则下面的"孤儿迁移"会把别人的文件传上去
    await ensureFileStoreOwner()

    const remote = await fetchTree()
    if (!hasSession()) {
      patchState({ status: 'unauthenticated' })
      return
    }

    // 合并云端目录树。注意它可能在这一步重新入队"首次迁移"的节点，
    // 所以下面必须重新 listFileOps()，不能用同步开始时的旧队列。
    applyingRemote = true
    try {
      await applyRemoteTree(remote)
    } finally {
      applyingRemote = false
    }

    const ops = await listFileOps()
    patchState({ pending: ops.length })

    for (const op of ops) {
      // 中途退出登录：立刻停手，别拿已经失效的令牌继续推下一个人的数据
      if (!hasSession()) break
      await pushOp(op)
      await removeFileOp(op.seq)
      if (state.pending > 0) patchState({ pending: state.pending - 1 })
    }

    if (!hasSession()) {
      patchState({ status: 'unauthenticated', pending: 0 })
      return
    }

    const left = await countFileOps().catch(() => 0)
    clearRetryTimer()
    patchState({
      status: 'synced',
      lastError: '',
      lastSyncedAt: Date.now(),
      pending: left,
    })
  } catch (err) {
    if (!hasSession()) {
      patchState({ status: 'unauthenticated', pending: 0 })
      return
    }

    const { status, message } = describeError(err)
    // 失败的 op 还在队列里，把真实待传数量重新数一遍给界面
    const pending = await countFileOps().catch(() => state.pending)
    patchState({ status, lastError: message, pending })
    // 只在"正常同步"失败时排一次自动重试；自动重试自己再失败就不再排了
    if (started && !retrying) scheduleRetry()
  } finally {
    running = false
    if (rerun) {
      rerun = false
      void syncFilesNow()
    }
  }
}

/**
 * 立刻同步一次：拉目录树 + 消费 outbox。
 *
 * 任何情况下都不抛错 —— 失败只体现在 getFileSyncState() 的 status / lastError 上。
 */
export async function syncFilesNow(): Promise<void> {
  try {
    await runSync()
  } catch {
    // runSync 内部已经兜过一遍；真漏到这里，说明连改状态都失败了，
    // 这时候什么也做不了，至少别让异常冒到界面（事件处理 / effect 里会直接崩）
  }
}

// ---------------------------------------------------------------- 触发 / 停止

/** 失败后 10 秒自动重试一次。 */
function scheduleRetry(): void {
  if (retryTimer !== null) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    if (!started) return
    retrying = true
    void syncFilesNow().finally(() => {
      retrying = false
    })
  }, RETRY_MS)
}

/** 过 delay 毫秒跑一次同步；连续触发只保留最后一次（防抖）。 */
function scheduleSoon(delay: number): void {
  clearDebounceTimer()
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    void syncFilesNow()
  }, delay)
}

function handleOnline(): void {
  if (!started) return
  if (!hasSession()) {
    patchState({ status: 'unauthenticated' })
    return
  }
  // 恢复联网了，把断网期间压着的改动补传，用户不用自己去点
  scheduleSoon(0)
}

function handleDirty(): void {
  if (!started) return
  // 这条事件是 applyRemoteTree 自己广播的：本轮已经在消费 outbox 了，
  // 再排一轮纯属重复请求（界面监听这个事件刷新不受影响，事件本身照样发出）
  if (applyingRemote) return
  // 本地刚改过：稍微等手停下来，把连续的几条改动合成一轮
  scheduleSoon(DEBOUNCE_MS)
}

/**
 * 开始文件同步：登录成功后调一次。
 *
 * 幂等：重复调用不会重复监听、也不会叠着发请求（StrictMode 会让 effect 跑两遍）。
 */
export function startFileSync(): void {
  if (started) return
  started = true

  if (typeof window !== 'undefined') {
    window.addEventListener('online', handleOnline)
    window.addEventListener(DIRTY_EVENT, handleDirty)
  }

  if (!hasSession()) {
    patchState({ status: 'unauthenticated' })
    return
  }

  // 登录后先同步一次：拉云端目录树、并把本机登录前就有的文件排进上传队列
  void syncFilesNow()
}

/** 停止文件同步：退出登录 / 登录失效时调。 */
export function stopFileSync(): void {
  if (!started) return
  started = false
  rerun = false

  clearDebounceTimer()
  clearRetryTimer()

  if (typeof window !== 'undefined') {
    window.removeEventListener('online', handleOnline)
    window.removeEventListener(DIRTY_EVENT, handleDirty)
  }

  patchState({
    status: hasSession() ? 'idle' : 'unauthenticated',
    lastError: '',
    pending: 0,
  })
}
