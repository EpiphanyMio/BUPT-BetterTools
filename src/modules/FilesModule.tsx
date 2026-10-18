// 文件管理模块：用 IndexedDB 在本机浏览器里存个人文件（PDF / Word / 图片等）。
//
// ⚠️ 重要前提：这个网站没有后端，文件存在**这台电脑 · 这个浏览器**里。
// 换设备、换浏览器、或用「清除浏览数据」都会看不到它们 —— 这是阶段 1 的固有限制，
// 真正跨设备要等路线图里的「Python 后端同步」阶段。

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
  type FileStats,
  type SearchHit,
} from '../lib/fileStore'
import { canPreview, formatBytes, formatTime, iconFor } from '../lib/fileUtils'
// 打开 / 下载文件的具体动作抽在了 fileActions 里 —— 全局搜索也要用同一套
import { downloadFileNode, openFileNode } from '../lib/fileActions'
import type { FileJumpRequest } from '../types'

// 拖拽 id 前缀。dnd-kit 靠 id 区分"谁是谁"，加前缀判断起来最简单。
const DRAG_PREFIX = 'node:' // 可拖动的行
const DROP_PREFIX = 'folder:' // 可投放的文件夹
const ROOT_DROP_ID = DROP_PREFIX + '__root__' // 面包屑上的"根目录"

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
}: NodeRowProps) {
  // 这一行同时有两个身份：可以被拖动、文件夹还能接收别人。
  // 两个 hook 各给一个 ref，所以用一个回调把同一个元素交给它们两边。
  const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({
    id: DRAG_PREFIX + node.id,
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
        <button
          type="button"
          onClick={() => onRename(node)}
          className="rounded-lg px-2 py-1 text-fg-subtle transition hover:bg-surface-3 hover:text-fg"
        >
          重命名
        </button>
        <button
          type="button"
          onClick={() => onDelete(node)}
          className="rounded-lg px-2 py-1 text-danger transition hover:bg-danger-bg"
        >
          删除
        </button>
      </div>
    </li>
  )
}

// ------------------------------------------------- 面包屑上的"根目录"（可投放）

function RootDropChip({ active, onClick }: { active: boolean; onClick: () => void }) {
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
      🏠 根目录
    </button>
  )
}

// ---------------------------------------------------------------- 主组件

export default function FilesModule({ onBack, onSearch, jump }: FilesModuleProps) {
  // 空字符串 = 根目录。带着跳转请求进来时，直接打开目标文件夹。
  const [currentId, setCurrentId] = useState(jump ? jump.folderId : '')
  const [items, setItems] = useState<FileNode[]>([])
  const [path, setPath] = useState<FileNode[]>([])
  const [stats, setStats] = useState<FileStats | null>(null)
  const [quota, setQuota] = useState<{ usage: number; quota: number } | null>(null)
  const [persisted, setPersisted] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [dragging, setDragging] = useState<FileNode | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async (folderId: string) => {
    const [children, chain, newStats, newQuota] = await Promise.all([
      listChildren(folderId),
      getPath(folderId),
      getStats(),
      getQuota(),
    ])
    setItems(children)
    setPath(chain)
    setStats(newStats)
    setQuota(newQuota)
  }, [])

  useEffect(() => {
    refresh(currentId).catch((error) => setNotice('读取数据失败：' + String(error)))
    setSelected(new Set()) // 换文件夹时清空选择，避免误删看不见的东西
  }, [currentId, refresh])

  useEffect(() => {
    requestPersistentStorage()
      .then(setPersisted)
      .catch(() => setPersisted(false))
  }, [])

  // 从「全局搜索」点了一个文件夹跳进来：打开它，并清掉本模块自己的搜索关键词
  useEffect(() => {
    if (!jump) return
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
    searchNodes(keyword)
      .then((result) => {
        if (!cancelled) setHits(result)
      })
      .catch(() => {
        if (!cancelled) setHits([])
      })
    return () => {
      cancelled = true
    }
  }, [query, items])

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
    const taken = new Set((await listChildren(currentId)).map((n) => n.name.toLowerCase()))

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
      await createFolder(finalName, currentId)
      await refresh(currentId)
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
      const taken = new Set((await listChildren(currentId)).map((n) => n.name.toLowerCase()))

      for (const file of Array.from(list)) {
        let name = file.name
        if (taken.has(name.toLowerCase())) {
          const fixed = uniqueName(name, taken)
          renamed.push(name + ' → ' + fixed)
          name = fixed
        }
        taken.add(name.toLowerCase())
        await addFile(file, currentId, name)
        added++
      }

      await refresh(currentId)
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
    const siblings = await listChildren(node.parentId)
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
    await refresh(currentId)
    setNotice('已重命名为「' + finalName + '」')
  }

  async function handleDelete(node: FileNode) {
    const what =
      node.kind === 'folder'
        ? '文件夹「' + node.name + '」以及里面的全部内容'
        : '文件「' + node.name + '」'
    if (!window.confirm('确定删除' + what + '吗？此操作无法撤销。')) return

    const count = await deleteNodes([node.id])
    await refresh(currentId)
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
      await refresh(currentId)
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

    await refresh(currentId)
    setNotice('已移动')
  }

  // ---------------------------------------------------------------- 渲染

  const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.node.id))

  return (
    <div className="min-h-screen bg-surface-2 text-fg">
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

        {/* 存储位置说明：这件事必须说清楚，否则用户会以为文件在云端 */}
        <div className="mb-4 rounded-btn border border-warn bg-warn-bg px-4 py-3 text-xs leading-relaxed text-warn">
          <b>这些文件只存在这台电脑的这个浏览器里，没有上传到任何服务器。</b>
          <br />
          换设备、换浏览器、或用「清除浏览数据」都会看不到它们。
          {persisted === false && ' 当前浏览器尚未允许持久化存储，磁盘紧张时可能被自动回收。'}
          {quota && quota.usage > 0 && (
            <>
              {' '}本站在浏览器里已用 {formatBytes(quota.usage)}
              {quota.quota > 0 && <> ，上限约 {formatBytes(quota.quota)}</>}。
            </>
          )}
        </div>

        {/* 操作栏 */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleCreateFolder}
            disabled={busy}
            className="rounded-btn bg-surface px-3.5 py-2 text-sm text-fg-muted ring-1 ring-line transition hover:bg-surface-3 disabled:opacity-50"
          >
            📁 新建文件夹
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
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
            <button
              type="button"
              onClick={handleDeleteSelected}
              disabled={busy}
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
              <RootDropChip active={currentId === ''} onClick={() => setCurrentId('')} />
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
    </div>
  )
}
