// 全局搜索：一个关键词同时搜「工具」和「文件」。
//
// 为什么做成浮层，而不是在首页放个普通输入框：
//   搜索是"突然想起来有个东西、想马上找到"的临时操作，找到就走。
//   做成浮层，可以在任何界面用 Ctrl+K（Mac 是 ⌘K）唤起、Esc 一按就退，
//   不用先退回首页，也不用离开手头正在做的事。
//
// 数据流：
//   敲字 → query 变 → 关键词变
//        ├─ 工具结果：同步算出来（数据在 localStorage，打开时读一次就够）
//        └─ 文件结果：防抖 140ms 后异步查（数据在 IndexedDB，每次查询要过一遍整张表）
//   两组结果按"工具在前、文件在后"拼成一个平铺列表，
//   ↑↓ 键走的就是这个列表的顺序 —— 所以只需要一个 activeIndex，
//   不必分别记"工具组里选到第几个、文件组里选到第几个"。

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { readTools } from '../hooks/useTools'
import { searchNodes, type FileNode, type SearchHit } from '../lib/fileStore'
import { downloadFileNode, openFileNode } from '../lib/fileActions'
import { canPreview, formatBytes, iconFor } from '../lib/fileUtils'
import { highlight, normalizeKeyword, scoreFileName, scoreTool } from '../lib/search'
import type { Tool } from '../types'

/** 每组最多先摆出这么多条，再多就提示"继续输入缩小范围" */
const MAX_PER_GROUP = 8

/** 文件搜索的防抖时间：打字时不该每敲一个字就把 IndexedDB 整表读一遍 */
const FILE_DEBOUNCE_MS = 140

interface GlobalSearchProps {
  open: boolean
  onClose: () => void
  /** 点结果里的文件夹时，跳到文件管理的对应目录（公共文件池要带上 scope） */
  onOpenFolder: (folderId: string, scope: 'private' | 'public') => void
}

/** 一条搜索结果。工具和文件合成同一个形状，键盘上下键才好统一处理。 */
type ResultItem =
  | { kind: 'tool'; key: string; tool: Tool }
  | { kind: 'file'; key: string; node: FileNode; pathNames: string[] }

/** 把命中的那几个字高亮出来 */
function Highlighted({ text, keyword }: { text: string; keyword: string }) {
  return (
    <>
      {highlight(text, keyword).map((segment, index) =>
        segment.hit ? (
          <mark key={index} className="rounded bg-primary-soft px-0.5 text-primary">
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  )
}

/** 一行结果的通用外观。选中时用主色淡底，而不是涂满主色。 */
function rowClass(active: boolean): string {
  return (
    'flex w-full items-center gap-3 px-4 py-2 text-left transition ' +
    (active ? 'bg-primary-soft' : 'hover:bg-surface-2')
  )
}

export default function GlobalSearch({ open, onClose, onOpenFolder }: GlobalSearchProps) {
  const [query, setQuery] = useState('')
  const [tools, setTools] = useState<Tool[]>([])
  const [fileHits, setFileHits] = useState<SearchHit[]>([])
  const [fileBusy, setFileBusy] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const keyword = normalizeKeyword(query)

  // 每次打开：清掉上次的输入和结果，重新读一遍工具列表，把光标放进输入框
  useEffect(() => {
    if (!open) return
    setQuery('')
    setActiveIndex(0)
    setFileHits([])
    setFileBusy(false)
    setTools(readTools())
    // 浮层是这一帧才渲染出来的，要等一拍再聚焦，否则 ref 还是空的
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [open])

  // 文件搜索：防抖 + 丢弃过期结果
  useEffect(() => {
    if (!open || keyword === '') {
      setFileHits([])
      setFileBusy(false)
      return
    }

    setFileBusy(true)
    let cancelled = false
    const timer = window.setTimeout(() => {
      searchNodes(keyword)
        .then((hits) => {
          // 打字快的时候，前一次查询可能后返回。cancelled 保证只有最后一次算数。
          if (cancelled) return
          setFileHits(hits)
          setFileBusy(false)
        })
        .catch(() => {
          if (cancelled) return
          setFileHits([])
          setFileBusy(false)
        })
    }, FILE_DEBOUNCE_MS)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [open, keyword])

  const toolResults = useMemo(() => {
    if (keyword === '') return []
    return tools
      .map((tool) => ({ tool, score: scoreTool(tool, keyword) }))
      .filter((row) => row.score >= 0)
      .sort((a, b) => a.score - b.score || a.tool.name.localeCompare(b.tool.name, 'zh'))
      .map((row) => row.tool)
  }, [tools, keyword])

  const fileResults = useMemo(() => {
    if (keyword === '') return []
    return [...fileHits].sort(
      (a, b) =>
        scoreFileName(a.node.name, keyword) - scoreFileName(b.node.name, keyword) ||
        a.node.name.localeCompare(b.node.name, 'zh'),
    )
  }, [fileHits, keyword])

  const toolShown = useMemo(() => toolResults.slice(0, MAX_PER_GROUP), [toolResults])
  const fileShown = useMemo(() => fileResults.slice(0, MAX_PER_GROUP), [fileResults])

  // 工具在前、文件在后，拼成平铺列表
  const flatResults = useMemo<ResultItem[]>(
    () => [
      ...toolShown.map(
        (tool): ResultItem => ({ kind: 'tool', key: 'tool:' + tool.id, tool }),
      ),
      ...fileShown.map(
        (hit): ResultItem => ({
          kind: 'file',
          key: 'file:' + hit.node.id,
          node: hit.node,
          pathNames: hit.pathNames,
        }),
      ),
    ],
    [toolShown, fileShown],
  )

  // 结果条数变了，把选中位置夹回合法范围，否则会指向一个不存在的位置
  useEffect(() => {
    setActiveIndex((index) => Math.min(index, Math.max(0, flatResults.length - 1)))
  }, [flatResults.length])

  // 浮层打开时锁住背后的页面滚动
  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [open])

  // Esc 关闭搜索。
  //
  // 为什么挂在 window 的**捕获阶段**、而且还要 stopPropagation：
  //   这个浮层是随时能唤起的 —— 用户可能正开着别的弹窗（比如工具详情）时按下 Ctrl+K，
  //   于是屏幕上同时叠了两层。而别的弹窗多半也在 window 上监听 Esc 来关自己。
  //   一个按键会被**所有**监听者收到，结果是按一下 Esc 两层一起关掉，
  //   可用户想关的只是最上面那层。
  //   捕获阶段是在事件往下走的路上最先经过 window 的时机，
  //   在这里掐断传播，下面的监听者就再也收不到了。
  //   搜索浮层永远渲染在最后一个（见 App.tsx），它就是最上面那层，理应由它先处理。
  useEffect(() => {
    if (!open) return

    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open, onClose])

  // 打开一条结果
  const activate = useCallback(
    async (item: ResultItem) => {
      if (item.kind === 'tool') {
        window.open(item.tool.url, '_blank', 'noopener')
        onClose()
        return
      }

      if (item.node.kind === 'folder') {
        // 池内文件夹要一起带上 scope，否则会跳进「我的文件」里一个同 id 不存在的目录
        onOpenFolder(item.node.id, item.node.scope === 'public' ? 'public' : 'private')
        onClose()
        return
      }

      // 能预览的（图片、PDF、文本…）直接开新标签；
      // 不能预览的（Word、压缩包…）就下载下来交给本地软件 ——
      // 否则会打开一个空白标签页，用户还得自己再找文件。
      const ok = canPreview(item.node.name)
        ? await openFileNode(item.node)
        : await downloadFileNode(item.node)
      if (ok) onClose()
    },
    [onClose, onOpenFolder],
  )

  // 这里只管"在结果里上下移动"和"打开"。
  // Esc 不在这里处理，见下面那个挂在 window 捕获阶段的 effect。
  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (flatResults.length === 0) return
      const step = event.key === 'ArrowDown' ? 1 : -1
      // 取余实现"到底了绕回开头"，不用判断边界
      setActiveIndex((index) => (index + step + flatResults.length) % flatResults.length)
      return
    }

    if (event.key === 'Enter') {
      const item = flatResults[activeIndex]
      if (item) {
        event.preventDefault()
        void activate(item)
      }
    }
  }

  // ⚠️ Hook 必须写在 return 之前（React 要求每次渲染调用的 Hook 数量一致）
  if (!open) return null

  const noResults = keyword !== '' && !fileBusy && flatResults.length === 0
  const toolRest = toolResults.length - toolShown.length
  const fileRest = fileResults.length - fileShown.length

  return (
    <div
      className="scrim flex items-start justify-center p-4 sm:pt-[12vh]"
      onClick={onClose}
    >
      <div
        className="modal-panel w-full max-w-xl overflow-hidden"
        onClick={(event) => event.stopPropagation()}
      >
        {/* 输入行 */}
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <span aria-hidden="true" className="shrink-0 text-fg-subtle">
            🔍
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="搜索工具和文件…"
            aria-label="搜索工具和文件"
            className="w-full bg-transparent text-base text-fg outline-none placeholder:text-fg-subtle"
          />
          <button type="button" onClick={onClose} aria-label="关闭搜索" className="btn btn-icon shrink-0">
            ✕
          </button>
        </div>

        {/* 结果区 */}
        <div className="max-h-[60vh] overflow-y-auto">
          {keyword === '' ? (
            <div className="px-4 py-10 text-center text-sm leading-relaxed text-fg-subtle">
              输入关键词，一次搜到工具和文件。
              <br />
              工具按名称、备注、分组、网址匹配；文件按文件名匹配。
            </div>
          ) : noResults ? (
            <div className="px-4 py-10 text-center text-sm text-fg-subtle">
              没有找到和「{query.trim()}」有关的工具或文件
            </div>
          ) : (
            <>
              {toolShown.length > 0 && (
                <section className="py-2">
                  <h3 className="px-4 py-1 text-xs font-medium tracking-wide text-fg-subtle">
                    工具 · {toolResults.length}
                  </h3>
                  {toolShown.map((tool, index) => (
                    <button
                      key={tool.id}
                      type="button"
                      onClick={() => void activate({ kind: 'tool', key: 'tool:' + tool.id, tool })}
                      // 鼠标划过也跟着高亮，这样点之前就知道 Enter 会打开哪一个
                      onMouseEnter={() => setActiveIndex(index)}
                      className={rowClass(index === activeIndex)}
                    >
                      <span
                        aria-hidden="true"
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-btn bg-surface-2 text-lg"
                      >
                        {tool.icon || '🔗'}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-fg">
                          <Highlighted text={tool.name} keyword={keyword} />
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-fg-subtle">
                          <Highlighted text={tool.description || tool.url} keyword={keyword} />
                        </span>
                      </span>
                      <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-fg-subtle">
                        {tool.category}
                      </span>
                    </button>
                  ))}
                  {toolRest > 0 && (
                    <p className="px-4 py-1 text-xs text-fg-subtle">
                      还有 {toolRest} 个，继续输入可以缩小范围
                    </p>
                  )}
                </section>
              )}

              {(fileShown.length > 0 || fileBusy) && (
                <section className="border-t border-line-soft py-2">
                  <h3 className="px-4 py-1 text-xs font-medium tracking-wide text-fg-subtle">
                    文件 · {fileBusy ? '搜索中…' : fileResults.length}
                  </h3>
                  {fileShown.map((hit, index) => {
                    const node = hit.node
                    const position = toolShown.length + index
                    return (
                      // 一行里有两个按钮：整行用来"打开"，右边单独一个"下载"。
                      // 写成兄弟按钮而不是嵌套，是因为 <button> 里不能再放 <button>（HTML 不允许）。
                      <div
                        key={node.id}
                        className={
                          'flex items-center gap-1 pr-2 transition ' +
                          (position === activeIndex ? 'bg-primary-soft' : 'hover:bg-surface-2')
                        }
                      >
                        <button
                          type="button"
                          onClick={() =>
                            void activate({
                              kind: 'file',
                              key: 'file:' + node.id,
                              node,
                              pathNames: hit.pathNames,
                            })
                          }
                          onMouseEnter={() => setActiveIndex(position)}
                          className="flex min-w-0 flex-1 items-center gap-3 px-4 py-2 text-left"
                        >
                          <span
                            aria-hidden="true"
                            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-btn bg-surface-2 text-lg"
                          >
                            {iconFor(node.name, node.kind)}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-fg">
                              <Highlighted text={node.name} keyword={keyword} />
                            </span>
                            <span className="mt-0.5 block truncate text-xs text-fg-subtle">
                              {node.kind === 'folder' ? '文件夹' : formatBytes(node.size)}
                              {' · '}
                              {hit.pathNames.length > 0 ? hit.pathNames.join(' / ') : '根目录'}
                            </span>
                          </span>
                        </button>
                        {node.kind === 'file' && (
                          <button
                            type="button"
                            onClick={() => void downloadFileNode(node)}
                            title={'下载 ' + node.name}
                            aria-label={'下载 ' + node.name}
                            className="btn btn-icon shrink-0"
                          >
                            ⬇
                          </button>
                        )}
                      </div>
                    )
                  })}
                  {fileRest > 0 && (
                    <p className="px-4 py-1 text-xs text-fg-subtle">
                      还有 {fileRest} 个，继续输入可以缩小范围
                    </p>
                  )}
                </section>
              )}
            </>
          )}
        </div>

        {/* 底部提示 */}
        <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-2 text-xs text-fg-subtle">
          <span>
            ↑↓ 选择 · Enter 打开 · Esc 关闭
          </span>
          <span>{fileBusy ? '正在搜索文件…' : '共 ' + tools.length + ' 个工具'}</span>
        </div>
      </div>
    </div>
  )
}
