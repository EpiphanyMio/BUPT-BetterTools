// 文件管理模块：在本机浏览器（IndexedDB）存个人文件，登录后自动同步到云端（R2）。
//
// 存储的两层含义：
//   - 本机 IndexedDB 始终是「工作副本 / 缓存」：离线也能浏览、打开已缓存的文件；
//   - 登录后，目录树和文件内容会同步到云端（R2 + D1），换设备登录同一账号就能看到。
// 访客 / 未登录时不会上传，文件只存在于这台电脑 · 这个浏览器里。

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  addFile,
  createFolder,
  deleteNodes,
  getPath,
  getQuota,
  getStats,
  listChildren,
  moveNode,
  renameNode,
  requestPersistentStorage,
  searchNodes,
  uniqueName,
  type FileNode,
  type FileScope,
  type FileStats,
  type SearchHit,
} from '../lib/fileStore'
import { canPreview, formatBytes, formatTime, iconFor } from '../lib/fileUtils'
// 打开 / 下载文件的具体动作抽在了 fileActions 里 —— 全局搜索也要用同一套
import { downloadFileNode, openFileNode } from '../lib/fileActions'
// 云端文件接口：具体实现由数据层提供，这里只按契约签名调用，不自己拼 fetch
import {
  USER_QUOTA_BYTES,
  createShare,
  fetchUsage,
  listShares,
  revokeShare,
  type CloudUsage,
} from '../lib/fileCloud'
import { useAuth } from '../hooks/useAuth'
import { useFileSync } from '../hooks/useFileSync'
import { useGuest } from '../hooks/useGuest'
import { syncFilesNow } from '../lib/fileSync'
import type { FileJumpRequest } from '../types'

// 拖拽 id 前缀。dnd-kit 靠 id 区分"谁是谁"，加前缀判断起来最简单。
const DRAG_PREFIX = 'node:' // 可拖动的行
const DROP_PREFIX = 'folder:' // 可投放的文件夹
const ROOT_DROP_ID = DROP_PREFIX + '__root__' // 面包屑上的"根目录"

// 访客模式下所有写操作按钮的统一悬停说明。
// 为什么抽成常量：禁用态在视觉上只是变淡，用户看不出"为什么点不动"，
// title 是唯一能说一句的地方；这句话要出现在好几个按钮上，零散地写迟早写岔。
const GUEST_LOCK_HINT = '访客预览模式不能修改'

interface FilesModuleProps {
  onBack: () => void
  /** 打开「全局搜索」浮层 */
  onSearch: () => void
  /**
   * 从全局搜索点文件夹跳进来的请求；null 表示没有。
   * seq 是序号，同一个文件夹连点两次时只有它会变，effect 才知道要再跳一次。
   */
  jump: FileJumpRequest | null
}

// ---------------------------------------------------------------- 单行

interface NodeRowProps {
  node: FileNode
  /** 搜索模式下显示"它在哪个文件夹里" */
  hint?: string
  selected: boolean
  onToggleSelect: (id: string) => void
  onOpen: (node: FileNode) => void
  onDownload: (node: FileNode) => void
  onRename: (node: FileNode) => void
  onDelete: (node: FileNode) => void
  /** 打开这个文件的分享弹窗 */
  onShare: (node: FileNode) => void
  /** 能不能生成分享链接（要登录，且不是访客） */
  canShare: boolean
  /** 不能分享时给 title 的原因说明 */
  shareHint: string
  /** 只读（访客）模式：重命名 / 删除这类写操作一律禁用 */
  readOnly: boolean
}

function NodeRow({
  node,
  hint,
  selected,
  onToggleSelect,
  onOpen,
  onDownload,
  onRename,
  onDelete,
  onShare,
  canShare,
  shareHint,
  readOnly,
}: NodeRowProps) {
  // 这一行同时有两个身份：可以被拖动、文件夹还能接收别人。
  // 两个 hook 各给一个 ref，所以用一个回调把同一个元素交给它们两边。
  // 访客下直接关掉拖动：拖动 = moveNode，是实打实的写操作。
  // 数据层虽然也会拦（fileStore 的写函数会抛错），但拖完松手才报错、
  // 界面还会先"跟手"动一下，不如一开始就不让拖。
  const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({
    id: DRAG_PREFIX + node.id,
    disabled: readOnly,
  })
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: DROP_PREFIX + node.id,
    // 只有文件夹能接收，文件不能
    disabled: node.kind !== 'folder',
  })

  const setRefs = (element: HTMLLIElement | null) => {
    setDragRef(element)
    setDropRef(element)
  }

  return (
    <li
      ref={setRefs}
      className={
        'flex items-center gap-2 border-b border-line-soft px-3 py-3 transition last:border-b-0 ' +
        (isOver ? 'bg-surface-2 ring-2 ring-inset ring-primary ' : 'hover:bg-surface-2 ') +
        (isDragging ? 'opacity-40' : '')
      }
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={() => onToggleSelect(node.id)}
        aria-label={'选择 ' + node.name}
        className="check"
      />

      {/* 拖动把手：只有按住这里才开始拖，不影响勾选和点击 */}
      <button
        {...attributes}
        {...listeners}
        type="button"
        title="按住拖动，可移到别的文件夹"
        aria-label="按住拖动，可移到别的文件夹"
        className="shrink-0 cursor-grab touch-none rounded p-1 text-fg-subtle transition hover:bg-surface-3 hover:text-fg-subtle active:cursor-grabbing"
      >
        <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">
          <circle cx="2.5" cy="3" r="1.4" />
          <circle cx="7.5" cy="3" r="1.4" />
          <circle cx="2.5" cy="8" r="1.4" />
          <circle cx="7.5" cy="8" r="1.4" />
          <circle cx="2.5" cy="13" r="1.4" />
          <circle cx="7.5" cy="13" r="1.4" />
        </svg>
      </button>

      <span className="text-xl" aria-hidden="true">
        {iconFor(node.name, node.kind)}
      </span>

      <button
        type="button"
        onClick={() => onOpen(node)}
        className="min-w-0 flex-1 text-left"
        title={node.kind === 'folder' ? '打开文件夹' : '打开文件'}
      >
        <span className="block truncate font-medium text-fg">{node.name}</span>
        <span className="block truncate text-xs text-fg-subtle">
          {node.kind === 'folder' ? '文件夹' : formatBytes(node.size)}
          {' · '}
          {formatTime(node.updatedAt)}
          {hint && <span className="text-primary">{' · 在 ' + hint}</span>}
        </span>
      </button>

      <div className="flex shrink-0 items-center gap-0.5 text-sm">
        {node.kind === 'file' && canPreview(node.name) && (
          <button
            type="button"
            onClick={() => onOpen(node)}
            className="rounded-lg px-2 py-1 text-fg-subtle transition hover:bg-surface-3 hover:text-fg"
          >
            打开
          </button>
        )}
        {node.kind === 'file' && (
          <button
            type="button"
            onClick={() => onDownload(node)}
            className="rounded-lg px-2 py-1 text-fg-subtle transition hover:bg-surface-3 hover:text-fg"
          >
            下载
          </button>
        )}
        {/* 只有文件能分享，文件夹没有对应的公开下载地址。
            生成分享链接要写云端数据，所以未登录 / 访客禁用，用 title 说明原因。 */}
        {node.kind === 'file' && (
          <button
            type="button"
            onClick={() => onShare(node)}
            disabled={!canShare}
            title={canShare ? '生成公开分享链接' : shareHint}
            className="rounded-lg px-2 py-1 text-fg-subtle transition hover:bg-surface-3 hover:text-fg disabled:opacity-50"
          >
            分享
          </button>
        )}
        {/* 重命名 / 删除是写操作：访客点不动。
            打开、下载是读操作，保持可用 —— 访客就是来看的。
            只补一个 disabled:opacity-50（项目里已有的写法），不动别的类名。 */}
        <button
          type="button"
          onClick={() => onRename(node)}
          disabled={readOnly}
          title={readOnly ? GUEST_LOCK_HINT : undefined}
          className="rounded-lg px-2 py-1 text-fg-subtle transition hover:bg-surface-3 hover:text-fg disabled:opacity-50"
        >
          重命名
        </button>
        <button
          type="button"
          onClick={() => onDelete(node)}
          disabled={readOnly}
          title={readOnly ? GUEST_LOCK_HINT : undefined}
          className="rounded-lg px-2 py-1 text-danger transition hover:bg-danger-bg disabled:opacity-50"
        >
          删除
        </button>
      </div>
    </li>
  )
}

// ------------------------------------------------- 面包屑上的"根目录"（可投放）

function RootDropChip({
  active,
  label,
  onClick,
}: {
  active: boolean
  label: string
  onClick: () => void
}) {
  const { setNodeRef, isOver } = useDroppable({ id: ROOT_DROP_ID })

  return (
    <button
      ref={setNodeRef}
      type="button"
      onClick={onClick}
      className={
        'rounded-lg px-2 py-1 transition ' +
        (isOver
          ? 'bg-primary-soft font-medium text-primary ring-2 ring-primary'
          : active
            ? 'font-medium text-fg'
            : 'text-fg-subtle hover:bg-surface-3')
      }
    >
      {label}
    </button>
  )
}

// ---------------------------------------------------------------- 分享弹窗

// 分享链接指向 Worker 上的公开下载接口。用 location.origin 而不是写死域名：
// 本地开发和线上部署复制的都是当前站点能打开的地址。
function shareLinkOf(token: string) {
  return location.origin + '/api/share/' + token
}

interface ShareModalProps {
  node: FileNode
  onClose: () => void
}

function ShareModal({ node, onClose }: ShareModalProps) {
  const [loading, setLoading] = useState(true)
  // loadError 专门表示「读取已有分享」失败 —— 这时不能显示成"还没有链接"，
  // 否则用户会以为没分享过，又去生成一个重复的。
  const [loadError, setLoadError] = useState('')
  const [token, setToken] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  // 重试计数：改它就能让下面的 effect 重新跑一遍
  const [reloadKey, setReloadKey] = useState(0)

  // 打开弹窗（以及点重试）时查一遍已有分享。
  // 每次都要重新查：分享可能在别的标签页或别的设备上被撤销过。
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError('')
    setToken(null)
    setError('')
    setCopied(false)
    listShares()
      .then((shares) => {
        if (cancelled) return
        // 一个文件只保留一条分享记录，按 nodeId 找即可
        const found = shares.find((share) => share.nodeId === node.id)
        setToken(found ? found.token : null)
      })
      .catch((err) => {
        if (cancelled) return
        setLoadError('读取分享状态失败：' + String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [node.id, reloadKey])

  // 按 Esc 关闭 + 锁住背景滚动，和项目里其它弹窗（ToolDetailModal）保持一致
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [onClose])

  async function copyLink(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      // 浏览器可能因为"非安全上下文 / 没给剪贴板权限"拒绝，退化成让用户手动选
      window.prompt('复制下面的链接：', text)
    }
  }

  async function handleCreate() {
    setBusy(true)
    setError('')
    try {
      const created = await createShare(node.id)
      setToken(created.token)
      // 生成后自动复制一次：用户点"生成"的下一步就是去发链接，少点一下
      await copyLink(shareLinkOf(created.token))
    } catch (err) {
      setError('生成分享链接失败：' + String(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleRevoke() {
    if (!token) return
    setBusy(true)
    setError('')
    try {
      await revokeShare(token)
      setToken(null)
      setCopied(false)
    } catch (err) {
      setError('取消分享失败：' + String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    // 点遮罩关闭；点面板本身用 stopPropagation 挡住，否则点链接/按钮会顺带关掉弹窗
    <div className="scrim flex items-start justify-center p-4 sm:py-16" onClick={onClose}>
      <div className="modal-panel w-full max-w-md" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start gap-3 px-5 pt-5">
          <span
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-btn bg-surface-2 text-2xl"
            aria-hidden="true"
          >
            {iconFor(node.name, node.kind)}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-lg font-medium text-fg">分享「{node.name}」</h2>
            <p className="mt-1 text-xs text-fg-subtle">
              拿到链接的人不用登录，就能直接下载这个文件
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="关闭"
            aria-label="关闭"
            className="btn-icon btn"
          >
            ✕
          </button>
        </div>

        <div className="px-5 pb-5 pt-4">
          {loading ? (
            <p className="text-sm text-fg-subtle">读取分享状态…</p>
          ) : loadError ? (
            <div className="space-y-3">
              <p className="rounded-btn bg-danger-bg px-3 py-2 text-xs leading-relaxed text-danger">
                {loadError}
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setReloadKey((key) => key + 1)}
                  className="btn btn-neutral"
                >
                  重试
                </button>
                <button type="button" onClick={onClose} className="btn btn-neutral">
                  关闭
                </button>
              </div>
            </div>
          ) : token ? (
            <div className="space-y-3">
              <div>
                <h3 className="mb-1 text-xs font-medium tracking-wide text-fg-subtle">
                  分享链接
                </h3>
                {/* select-all + break-all：只读但能整段选中，长链接也不会撑破弹窗 */}
                <code className="block select-all break-all rounded-btn bg-surface-2 px-3 py-2 text-xs leading-relaxed text-fg-muted">
                  {shareLinkOf(token)}
                </code>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void copyLink(shareLinkOf(token))}
                  className="btn btn-primary"
                >
                  {copied ? '✓ 已复制' : '复制链接'}
                </button>
                <button
                  type="button"
                  onClick={() => void handleRevoke()}
                  disabled={busy}
                  className="btn btn-neutral disabled:opacity-50"
                >
                  {busy ? '处理中…' : '取消分享'}
                </button>
                <button type="button" onClick={onClose} className="btn btn-neutral">
                  关闭
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm leading-relaxed text-fg-muted">
                这个文件还没有分享链接。生成后，任何拿到链接的人都能下载它。
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void handleCreate()}
                  disabled={busy}
                  className="btn btn-primary disabled:opacity-50"
                >
                  {busy ? '生成中…' : '生成分享链接'}
                </button>
                <button type="button" onClick={onClose} className="btn btn-neutral">
                  关闭
                </button>
              </div>
            </div>
          )}

          {error && (
            <p className="mt-3 rounded-btn bg-danger-bg px-3 py-2 text-xs leading-relaxed text-danger">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- 主组件

export default function FilesModule({ onBack, onSearch, jump }: FilesModuleProps) {
  // 访客（只读）模式。只取 isGuest：退出访客的入口在顶部横幅里，这个模块不用管。
  const { isGuest } = useGuest()
  // 登录态决定两件事：文件要不要上云、能不能生成分享链接（都得有账号）。
  const { user } = useAuth()
  const loggedIn = user !== null
  const cloudEnabled = loggedIn && !isGuest
  // 云端同步状态是全局唯一的，数据层维护，这里只订阅展示
  const sync = useFileSync()

  // 空字符串 = 根目录。带着跳转请求进来时，直接打开目标文件夹。
  //
  // scope 是这次改动新增的「区域」：
  //   private —— 我的文件（原来的全部行为）
  //   public  —— 公共文件池（所有登录用户共享一棵目录树）
  // 两个区域共用 currentId / 面包屑 / 搜索框；切换时回到各自的根目录。
  const [scope, setScope] = useState<FileScope>(jump?.scope ?? 'private')
  const [currentId, setCurrentId] = useState(jump ? jump.folderId : '')
  const [items, setItems] = useState<FileNode[]>([])
  const [path, setPath] = useState<FileNode[]>([])
  const [stats, setStats] = useState<FileStats | null>(null)
  const [quota, setQuota] = useState<{ usage: number; quota: number } | null>(null)
  const [persisted, setPersisted] = useState<boolean | null>(null)
  // 云端用量：未登录不请求；失败静默（fetchUsage 自己会返回 null）
  const [cloudUsage, setCloudUsage] = useState<CloudUsage | null>(null)
  // 当前打开分享弹窗的文件；null = 弹窗关闭
  const [shareNode, setShareNode] = useState<FileNode | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  // 下面两个是给界面区分「加载中 / 空 / 出错」用的显式状态。
  // 为什么不靠推断：items 初始就是 []，空文件夹也是 [] —— 光看长度分不出
  // "还没读到" 和 "读到了但确实没有"；而读取失败也只会让 items 停在 []，
  // 看上去和空文件夹一模一样。把这三件事拆成独立状态，界面就不用猜了。
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState('')

  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [dragging, setDragging] = useState<FileNode | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)

  // options.silent：同一文件夹内的增量刷新（上传 / 重命名 / 删除 / 移动之后）不显示骨架屏。
  //
  // 为什么要区分：这些操作做完也要重新读一遍列表，但列表里已有的内容其实还在。
  // 把它整个换成骨架屏，用户会觉得"页面又重载了" —— 上传一个文件就闪一下整页，很突兀。
  // 只有"首次进入 / 切换文件夹"这种内容真的换了的场景，才值得让骨架屏出现。
  const refresh = useCallback(
    async (folderId: string, options?: { silent?: boolean }) => {
      if (!options?.silent) setListLoading(true)
      try {
        const [children, chain, newStats, newQuota] = await Promise.all([
          listChildren(folderId, scope),
          getPath(folderId),
          getStats(scope),
          getQuota(),
        ])
        setItems(children)
        setPath(chain)
        setStats(newStats)
        setQuota(newQuota)
        setListError('') // 读成功就清掉上一次的错误
      } catch (error) {
        const message = '读取数据失败：' + String(error)
        setListError(message)
        // 过渡期也写进 notice：现在的提示条还靠它显示。
        // 等界面把「错误态」做好之后，这行可以删掉。
        setNotice(message)
      } finally {
        // finally 而不是 try 末尾：抛异常时也必须把"加载中"关掉，
        // 否则界面会永远停在骨架屏上。
        setListLoading(false)
      }
    },
    [scope],
  )

  useEffect(() => {
    void refresh(currentId)
    setSelected(new Set()) // 换文件夹时清空选择，避免误删看不见的东西
  }, [currentId, refresh])

  // 云端合并进本地后（包括别的设备刚改过），数据层会广播这个事件：
  // 静默重读当前目录，用户不用手动刷新就能看到变化。
  useEffect(() => {
    function onFilesChanged() {
      void refresh(currentId, { silent: true })
    }
    window.addEventListener('better-tools:files-dirty', onFilesChanged)
    return () => window.removeEventListener('better-tools:files-dirty', onFilesChanged)
  }, [currentId, refresh])

  // 打开文件管理时顺手拉一次云端。App 启动时已经同步过，但那可能是很久以前；
  // 这里补一次，免得列表停在别的设备改动之前的版本。失败静默（状态栏会显示）。
  useEffect(() => {
    if (!cloudEnabled) return
    void syncFilesNow()
  }, [cloudEnabled])

  useEffect(() => {
    requestPersistentStorage()
      .then(setPersisted)
      .catch(() => setPersisted(false))
  }, [])

  // 云端用量只在登录后请求；每次同步完成（lastSyncedAt 变了）再刷一次，
  // 这样刚上传的文件能立刻反映到「已用多少」里。
  useEffect(() => {
    if (!loggedIn) {
      setCloudUsage(null)
      return
    }
    let cancelled = false
    fetchUsage()
      .then((usage) => {
        if (!cancelled) setCloudUsage(usage)
      })
      .catch(() => {
        // 静默：用量只是附加信息，失败不该弹错误打扰用户
      })
    return () => {
      cancelled = true
    }
  }, [loggedIn, sync.lastSyncedAt])

  // 从「全局搜索」点了一个文件夹跳进来：切到它所在的区域、打开它，
  // 并清掉本模块自己的搜索关键词。
  useEffect(() => {
    if (!jump) return
    setScope(jump.scope ?? 'private')
    setCurrentId(jump.folderId)
    setQuery('')
  }, [jump])

  // 搜索：文件名一变就重新查一次（items 变化也要重查，因为移动/删除会改变结果）
  useEffect(() => {
    const keyword = query.trim()
    if (!keyword) {
      setHits([])
      return
    }
    let cancelled = false
    searchNodes(keyword, scope)
      .then((result) => {
        if (!cancelled) setHits(result)
      })
      .catch(() => {
        if (!cancelled) setHits([])
      })
    return () => {
      cancelled = true
    }
  }, [query, items, scope])

  // 拖动时只认"文件夹"这类投放目标，而且必须是指针真的压在它上面 ——
  // 否则拖到空白处也会顺手丢进最近的那个文件夹，很反直觉。
  const collisionDetection = useCallback<CollisionDetection>(
    (args) => pointerWithin(args).filter((c) => String(c.id).startsWith(DROP_PREFIX)),
    [],
  )

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  )

  const searching = query.trim().length > 0
  const rows = searching
    ? hits.map((hit) => ({
        node: hit.node,
        hint: hit.pathNames.length > 0 ? hit.pathNames.join(' / ') : '根目录',
      }))
    : items.map((node) => ({ node, hint: undefined as string | undefined }))

  // ---------- 选择 ----------

  /**
   * 切换「我的文件 / 公共文件池」。
   *
   * 必须把 currentId 一起清空：两个区域是两棵独立的树，
   * 上一个区域的文件夹 id 在另一个区域里不存在，留着会打开一个空目录。
   * 搜索词 / 勾选 / 分享弹窗也一并重置，避免操作到看不见的条目。
   */
  function switchScope(next: FileScope) {
    if (next === scope) return
    setScope(next)
    setCurrentId('')
    setQuery('')
    setSelected(new Set())
    setShareNode(null)
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function selectAllVisible() {
    setSelected(new Set(rows.map((row) => row.node.id)))
  }

  // ---------- 新建 / 上传 ----------

  async function handleCreateFolder() {
    const input = window.prompt('新建文件夹，请输入名称：')
    if (input === null || !input.trim()) return

    const desired = input.trim()
    const taken = new Set(
      (await listChildren(currentId, scope)).map((n) => n.name.toLowerCase()),
    )

    let finalName = desired
    if (taken.has(desired.toLowerCase())) {
      const fixed = uniqueName(desired, taken)
      const ok = window.confirm(
        '这个位置已经有叫「' + desired + '」的了。\n\n改名为「' + fixed + '」再新建？\n（点「取消」放弃）',
      )
      if (!ok) return
      finalName = fixed
    }

    setBusy(true)
    try {
      await createFolder(finalName, currentId, scope)
      await refresh(currentId, { silent: true })
      setNotice('已新建文件夹「' + finalName + '」')
    } catch (error) {
      setNotice('新建失败：' + String(error))
    } finally {
      setBusy(false)
    }
  }

  async function handleFilesPicked(list: FileList | null) {
    if (!list || list.length === 0) return

    setBusy(true)
    const renamed: string[] = []
    let added = 0

    try {
      // 先把该文件夹里已用的名字读出来，上传过程中不断累加 ——
      // 这样同一批里的两个同名文件也能各自拿到不同的名字
      const taken = new Set(
        (await listChildren(currentId, scope)).map((n) => n.name.toLowerCase()),
      )

      for (const file of Array.from(list)) {
        let name = file.name
        if (taken.has(name.toLowerCase())) {
          const fixed = uniqueName(name, taken)
          renamed.push(name + ' → ' + fixed)
          name = fixed
        }
        taken.add(name.toLowerCase())
        await addFile(file, currentId, name, scope)
        added++
      }

      await refresh(currentId, { silent: true })
      setNotice(
        renamed.length > 0
          ? '已上传 ' + added + ' 个文件；检测到 ' + renamed.length + ' 个重名，已自动改名保留两者：' + renamed.join('、')
          : '已上传 ' + added + ' 个文件',
      )
    } catch (error) {
      setNotice('已上传 ' + added + ' 个，之后失败：' + String(error))
    } finally {
      setBusy(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  // ---------- 打开 / 下载 ----------

  async function handleOpen(node: FileNode) {
    if (node.kind === 'folder') {
      setCurrentId(node.id)
      setQuery('')
      return
    }

    const ok = await openFileNode(node)
    if (!ok) setNotice('找不到这个文件的内容')
  }

  async function handleDownload(node: FileNode) {
    const ok = await downloadFileNode(node)
    if (!ok) setNotice('找不到这个文件的内容')
  }

  // ---------- 重命名 / 删除 ----------

  async function handleRename(node: FileNode) {
    const input = window.prompt('重命名：', node.name)
    if (input === null || !input.trim() || input.trim() === node.name) return

    const desired = input.trim()
    const siblings = await listChildren(node.parentId, node.scope ?? 'private')
    const taken = new Set(
      siblings.filter((s) => s.id !== node.id).map((s) => s.name.toLowerCase()),
    )

    let finalName = desired
    if (taken.has(desired.toLowerCase())) {
      const fixed = uniqueName(desired, taken)
      const ok = window.confirm(
        '这个位置已经有叫「' + desired + '」的了。\n\n改名为「' + fixed + '」保留两者？\n（点「取消」放弃本次重命名）',
      )
      if (!ok) return
      finalName = fixed
    }

    await renameNode(node.id, finalName)
    await refresh(currentId, { silent: true })
    setNotice('已重命名为「' + finalName + '」')
  }

  async function handleDelete(node: FileNode) {
    const what =
      node.kind === 'folder'
        ? '文件夹「' + node.name + '」以及里面的全部内容'
        : '文件「' + node.name + '」'
    if (!window.confirm('确定删除' + what + '吗？此操作无法撤销。')) return

    const count = await deleteNodes([node.id])
    await refresh(currentId, { silent: true })
    setNotice(count > 1 ? '已删除 ' + count + ' 项' : '已删除')
  }

  async function handleDeleteSelected() {
    const list = [...selected]
    if (list.length === 0) return

    if (
      !window.confirm(
        '确定删除选中的 ' + list.length + ' 项吗？\n\n文件夹会连同里面的内容一起删除，此操作无法撤销。',
      )
    ) {
      return
    }

    setBusy(true)
    try {
      const count = await deleteNodes(list)
      setSelected(new Set())
      await refresh(currentId, { silent: true })
      setNotice('已删除 ' + count + ' 项')
    } catch (error) {
      setNotice('删除失败：' + String(error))
    } finally {
      setBusy(false)
    }
  }

  // ---------- 拖拽移动 ----------

  function handleDragStart(event: DragStartEvent) {
    const id = String(event.active.id).slice(DRAG_PREFIX.length)
    const found =
      items.find((item) => item.id === id) ??
      hits.find((hit) => hit.node.id === id)?.node ??
      null
    setDragging(found)
  }

  async function handleDragEnd(event: DragEndEvent) {
    setDragging(null)

    const { active, over } = event
    if (!over) return // 丢在空白处 = 取消

    const draggedId = String(active.id).slice(DRAG_PREFIX.length)
    const rawTarget = String(over.id).slice(DROP_PREFIX.length)
    const targetId = rawTarget === '__root__' ? '' : rawTarget

    const result = await moveNode(draggedId, targetId)
    if (result === 'same') {
      setNotice('它已经在这个文件夹里了')
      return
    }
    if (result === 'cycle') {
      setNotice('不能把文件夹移进它自己或它的子文件夹里')
      return
    }
    if (result === 'cross') {
      setNotice('不能跨「我的文件」和「公共文件池」移动；要公开请重新上传到公共文件池')
      return
    }

    await refresh(currentId, { silent: true })
    setNotice('已移动')
  }

  // ---------------------------------------------------------------- 渲染

  const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.node.id))

  // 数据状态：让界面一眼看出该显示骨架屏 / 空态 / 错误 / 正常列表。
  // 为什么不直接看 items.length：初始就是 []，空文件夹也是 []，读取失败也停在 [] ——
  // 三种完全不同的情况值一样，光靠长度分不出来。
  // 挂在根节点的 data-list-state 上，样式侧可以直接用 [data-list-state="loading"] 之类选择。
  const listState = listLoading ? 'loading' : listError ? 'error' : items.length === 0 ? 'empty' : 'ready'

  // 云端状态 -> 中文说明。error 时直接显示 lastError：有具体原因就别只写"出错了"。
  const syncStatusText =
    sync.status === 'syncing'
      ? '同步中'
      : sync.status === 'synced'
        ? '已同步'
        : sync.status === 'offline'
          ? '离线（改动稍后上传）'
          : sync.status === 'error'
            ? sync.lastError || '同步失败'
            : sync.status === 'unauthenticated'
              ? '未登录'
              : '等待同步'

  // 颜色只用语义 class（设计令牌），不写死色值
  const syncStatusTone =
    sync.status === 'error'
      ? 'text-danger'
      : sync.status === 'offline'
        ? 'text-warn'
        : sync.status === 'synced'
          ? 'text-primary'
          : 'text-fg-subtle'

  // 生成分享链接要写云端数据：必须有账号，且访客模式下一切写操作都禁用
  const canShare = loggedIn && !isGuest
  const shareHint = isGuest ? GUEST_LOCK_HINT : '登录后才能生成分享链接'

  return (
    <div data-list-state={listState} className="min-h-screen bg-surface-2 text-fg">
      <div className="mx-auto max-w-5xl px-4 py-8">
        {/* 和工具箱同样的道理：窄屏必须纵向排列，
            否则右侧按钮（shrink-0）会把标题压成一条竖线。 */}
        <header className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="min-w-0">
            <h1 className="text-3xl font-bold tracking-tight text-fg">📁 文件管理</h1>
            <p className="mt-1 text-sm text-fg-subtle">
              {stats
                ? stats.fileCount + ' 个文件 · ' + stats.folderCount + ' 个文件夹 · ' + formatBytes(stats.bytes)
                : '读取中…'}
            </p>
            {/* 云端同步状态：让用户知道文件到底传上去了没有。
                云端用量只有登录后才请求，未登录时这一行只显示「未登录」。 */}
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <span className={syncStatusTone}>☁️ 云端：{syncStatusText}</span>
              {sync.pending > 0 && (
                <span className="text-fg-subtle">· {sync.pending} 项待上传</span>
              )}
              {cloudUsage && (
                <span className="text-fg-subtle">
                  · 云端已用 {formatBytes(cloudUsage.used)} /{' '}
                  {formatBytes(cloudUsage.quota > 0 ? cloudUsage.quota : USER_QUOTA_BYTES)}
                </span>
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
            <button
              type="button"
              onClick={onBack}
              className="rounded-btn border border-line bg-surface px-3.5 py-2 text-sm text-fg-muted shadow-e1 transition hover:border-line hover:bg-surface-3"
            >
              ← 返回首页
            </button>

            {/* 全局搜索：跨文件夹、跨模块地找东西。
                和下面那个搜索框分工不同 —— 那个只筛"文件名"，且和文件在同一页。 */}
            <button
              type="button"
              onClick={onSearch}
              title="搜索工具和文件（Ctrl+K）"
              aria-label="搜索工具和文件"
              className="btn btn-neutral w-10 px-0 leading-none"
            >
              🔍
            </button>
          </div>
        </header>

        {/* 区域切换：我的文件 / 公共文件池。
            放在存储说明之前 —— 下面的说明文字是按「当前区域」写的。 */}
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="inline-flex rounded-btn border border-line bg-surface p-1 text-sm shadow-e1">
            <button
              type="button"
              onClick={() => switchScope('private')}
              className={
                'rounded-btn px-3 py-1.5 transition ' +
                (scope === 'private'
                  ? 'bg-primary-soft font-medium text-primary'
                  : 'text-fg-subtle hover:bg-surface-3')
              }
            >
              📁 我的文件
            </button>
            <button
              type="button"
              onClick={() => switchScope('public')}
              className={
                'rounded-btn px-3 py-1.5 transition ' +
                (scope === 'public'
                  ? 'bg-primary-soft font-medium text-primary'
                  : 'text-fg-subtle hover:bg-surface-3')
              }
            >
              🌐 公共文件池
            </button>
          </div>
          <span className="text-xs text-fg-subtle">
            公共文件池：所有登录用户共享，上传占用你自己的配额
          </span>
        </div>

        {/* 存储位置说明：登录后是"云端 + 本机缓存"，未登录 / 访客是"只在本机"。
            两种情况必须说清楚，否则用户会误判文件到底在不在云端。 */}
        <div
          className={
            'mb-4 rounded-btn border px-4 py-3 text-xs leading-relaxed ' +
            (cloudEnabled
              ? 'border-primary bg-primary-soft text-fg-muted'
              : 'border-warn bg-warn-bg text-warn')
          }
        >
          {cloudEnabled ? (
            <>
              <b className="text-fg">文件会自动同步到云端（R2），本机保留一份缓存，离线也能用。</b>
              <br />
              换设备登录同一账号就能看到这些文件；离线期间的改动会在联网后自动上传。
            </>
          ) : (
            <>
              <b>这些文件只存在这台电脑的这个浏览器里，没有上传到任何服务器。</b>
              <br />
              换设备、换浏览器、或用「清除浏览数据」都会看不到它们。
            </>
          )}
          {persisted === false && ' 当前浏览器尚未允许持久化存储，磁盘紧张时可能被自动回收。'}
          {quota && quota.usage > 0 && (
            <>
              {' '}本站在浏览器里已用 {formatBytes(quota.usage)}
              {quota.quota > 0 && <> ，上限约 {formatBytes(quota.quota)}</>}。
            </>
          )}
        </div>

        {/* 公共文件池的规则说明：它不是「另一个网盘」，而是大家共用的一块区域。
            配额那一句必须写清楚，否则用户会以为池子有独立的免费空间。 */}
        {scope === 'public' && (
          <div className="mb-4 rounded-btn border border-primary bg-primary-soft px-4 py-3 text-xs leading-relaxed text-fg-muted">
            <b className="text-fg">公共文件池：所有登录用户共享这一块区域。</b>
            <br />
            你上传的文件会从<b>你自己的</b>云盘配额里扣；删除时按 R2 里的真实大小退给上传者。
            池内内容大家都能看到、也能修改，别放私密文件。
          </div>
        )}

        {/* 操作栏 */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {/* 新建 / 上传都是写操作：访客禁用（disabled 走原生属性，
              视觉上靠已有的 disabled:opacity-50 / .btn:disabled）。 */}
          <button
            type="button"
            onClick={handleCreateFolder}
            disabled={busy || isGuest}
            title={isGuest ? GUEST_LOCK_HINT : undefined}
            className="rounded-btn bg-surface px-3.5 py-2 text-sm text-fg-muted ring-1 ring-line transition hover:bg-surface-3 disabled:opacity-50"
          >
            📁 新建文件夹
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy || isGuest}
            title={isGuest ? GUEST_LOCK_HINT : undefined}
            className="btn btn-primary disabled:opacity-50"
          >
            ⬆ 上传文件
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => handleFilesPicked(event.target.files)}
          />

          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="🔍 搜索文件名…"
            className="min-w-[10rem] flex-1 rounded-btn border border-line bg-surface px-3.5 py-2 text-sm outline-none transition"
          />

          {busy && <span className="text-sm text-fg-subtle">处理中…</span>}
        </div>

        {notice && (
          <p className="mb-3 rounded-btn bg-surface-2 px-4 py-2 text-sm text-primary">{notice}</p>
        )}

        {/* 批量选择操作条 */}
        {selected.size > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-3 rounded-btn border border-line bg-surface px-4 py-2.5 text-sm shadow-e1">
            <span className="text-fg-muted">已选 <b>{selected.size}</b> 项</span>
            <button
              type="button"
              onClick={allSelected ? () => setSelected(new Set()) : selectAllVisible}
              className="text-primary transition hover:text-primary-hover"
            >
              {allSelected ? '取消全选' : '全选当前列表'}
            </button>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="text-fg-subtle transition hover:text-fg-muted"
            >
              取消选择
            </button>
            {/* 批量删除同样是写操作，访客禁用 */}
            <button
              type="button"
              onClick={handleDeleteSelected}
              disabled={busy || isGuest}
              title={isGuest ? GUEST_LOCK_HINT : undefined}
              className="ml-auto rounded-lg bg-danger px-3 py-1.5 text-white transition hover:bg-danger disabled:opacity-50"
            >
              🗑 删除选中
            </button>
          </div>
        )}

        <DndContext
          sensors={sensors}
          collisionDetection={collisionDetection}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setDragging(null)}
        >
          {/* 面包屑：首页 › 课件 › 大三上。搜索时隐藏。 */}
          {!searching && (
            <nav className="mb-3 flex flex-wrap items-center gap-1 text-sm">
              <RootDropChip
                active={currentId === ''}
                label={scope === 'public' ? '🌐 公共文件池' : '🏠 根目录'}
                onClick={() => setCurrentId('')}
              />
              {path.map((node) => (
                <span key={node.id} className="flex items-center gap-1">
                  <span className="text-fg-subtle">›</span>
                  <button
                    type="button"
                    onClick={() => setCurrentId(node.id)}
                    className={
                      'rounded-lg px-2 py-1 transition ' +
                      (node.id === currentId
                        ? 'font-medium text-fg'
                        : 'text-fg-subtle hover:bg-surface-3')
                    }
                  >
                    {node.name}
                  </button>
                </span>
              ))}
            </nav>
          )}

          {searching && (
            <p className="mb-3 text-sm text-fg-subtle">
              搜索「{query.trim()}」：找到 <b>{hits.length}</b> 项
              <button
                type="button"
                onClick={() => setQuery('')}
                className="ml-3 text-primary transition hover:text-primary-hover"
              >
                清除搜索
              </button>
            </p>
          )}

          {rows.length === 0 ? (
            <p className="rounded-card border border-dashed border-line bg-surface-2 py-14 text-center text-sm text-fg-subtle">
              {searching
                ? '没有找到名字包含这个关键词的文件或文件夹'
                : scope === 'public'
                  ? '公共文件池还是空的 —— 点上面的「新建文件夹」或「上传文件」，放进去的内容所有登录用户都能看到'
                  : '这里是空的 —— 点上面的「新建文件夹」或「上传文件」开始'}
            </p>
          ) : (
            <ul className="overflow-hidden rounded-card border border-line bg-surface shadow-e1">
              {rows.map((row) => (
                <NodeRow
                  key={row.node.id}
                  node={row.node}
                  hint={row.hint}
                  selected={selected.has(row.node.id)}
                  onToggleSelect={toggleSelect}
                  onOpen={handleOpen}
                  onDownload={handleDownload}
                  onRename={handleRename}
                  onDelete={handleDelete}
                  onShare={setShareNode}
                  canShare={canShare && row.node.scope !== 'public'}
                  shareHint={
                    row.node.scope === 'public'
                      ? '公共文件池里的文件对所有登录用户可见，不需要单独分享'
                      : shareHint
                  }
                  readOnly={isGuest}
                />
              ))}
            </ul>
          )}

          {/* 拖动时跟着鼠标的"漂浮副本" */}
          <DragOverlay dropAnimation={null}>
            {dragging && (
              <div className="flex items-center gap-2 rounded-btn border border-primary bg-surface px-3 py-2 text-sm shadow-e3">
                <span className="text-lg">{iconFor(dragging.name, dragging.kind)}</span>
                <span className="max-w-[14rem] truncate font-medium text-fg">
                  {dragging.name}
                </span>
              </div>
            )}
          </DragOverlay>
        </DndContext>

        <p className="mt-6 text-center text-xs text-fg-subtle">
          按住行左侧的 ⠿ 拖动，把它丢到别的文件夹上即可移动 · 图片和 PDF 可以直接在浏览器里打开，
          Word / Excel 这类需要下载后用本地软件打开。
        </p>
      </div>

      {/* 分享弹窗挂在最外层：.scrim 是 fixed 定位，放在这里不会被内容裁掉 */}
      {shareNode && <ShareModal node={shareNode} onClose={() => setShareNode(null)} />}
    </div>
  )
}
