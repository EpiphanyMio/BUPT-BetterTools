import { useMemo, useRef, useState } from 'react'
import { useAuth } from '../hooks/useAuth'
import { useDeadlines } from '../hooks/useDeadlines'
import type { DeadlineAssignment } from '../types'

interface Props {
  onBack: () => void
  onSearch: () => void
}

const PRIORITY_LABEL: Record<DeadlineAssignment['priority'], string> = {
  1: '高', 2: '中', 3: '低',
}

function sortAssignments(a: DeadlineAssignment, b: DeadlineAssignment): number {
  if (a.done !== b.done) return Number(a.done) - Number(b.done)
  if (a.priority !== b.priority) return a.priority - b.priority
  if (!a.dueAt) return 1
  if (!b.dueAt) return -1
  return a.dueAt.localeCompare(b.dueAt) || a.title.localeCompare(b.title, 'zh-CN')
}

export default function DeadlineModule({ onBack, onSearch }: Props) {
  const { user } = useAuth()
  const readOnly = user === null
  const { assignments, importFiles, add, update, remove } = useDeadlines(user?.id ?? null)
  const [draft, setDraft] = useState('')
  const [notice, setNotice] = useState('')
  const directoryRef = useRef<HTMLInputElement>(null)
  const sorted = useMemo(() => [...assignments].sort(sortAssignments), [assignments])
  const pending = assignments.filter((item) => !item.done).length
  const missingDates = assignments.filter((item) => !item.done && !item.dueAt).length

  return (
    <div className="min-h-screen bg-surface-2 text-fg">
      <div className="mx-auto max-w-5xl px-4 py-8">
        <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-fg">📅 Deadline 管理器</h1>
            <p className="mt-1 text-sm text-fg-subtle">整理作业、记录截止时间，按优先级和日期查看待办。</p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onBack} className="btn btn-neutral">← 返回首页</button>
            <button type="button" onClick={onSearch} aria-label="搜索工具和文件" className="btn btn-neutral w-10 px-0">🔍</button>
          </div>
        </header>

        <section className="card mb-4 p-5">
          <h2 className="text-lg font-medium">导入作业文件夹</h2>
          <p className="mt-1 text-sm leading-relaxed text-fg-muted">
            选择“期末作业”文件夹后，会按文件名创建条目；同一目录下同名的 Word、PDF 会合为一项。
            目前只读取文件名和相对路径，不读取正文，也不会上传文件。
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button type="button" className="btn btn-primary" disabled={readOnly} onClick={() => directoryRef.current?.click()}>
              选择文件夹
            </button>
            <span className="text-xs text-fg-subtle">重选文件夹会补充新条目，并保留已填写的截止时间。</span>
          </div>
          <input
            ref={(node) => {
              directoryRef.current = node
              // 目录选择需要浏览器的 webkitdirectory 属性；用户必须自己点选一次。
              if (node) node.setAttribute('webkitdirectory', '')
            }}
            type="file"
            multiple
            className="hidden"
            aria-label="选择作业文件夹"
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? [])
              if (files.length === 0) return
              const result = importFiles(files)
              setNotice(`扫描 ${result.scanned} 项作业，新增 ${result.added} 项。请核对截止时间和优先级。`)
              event.currentTarget.value = ''
            }}
          />
          {notice && <p role="status" className="mt-3 text-sm text-primary">{notice}</p>}
        </section>

        <section className="card mb-4 p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-medium">作业清单</h2>
            <span className="text-sm text-fg-muted">待完成 {pending} 项 · 待填截止时间 {missingDates} 项</span>
          </div>
          <p className="mt-1 text-xs text-fg-subtle">未完成的条目按高、中、低优先级排列；同级按截止时间排列，未填日期的排在最后。</p>
          <form
            className="mt-4 flex flex-col gap-2 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault()
              add(draft)
              setDraft('')
            }}
          >
            <input className="field min-w-0 flex-1" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="手动添加一项作业" disabled={readOnly} />
            <button className="btn btn-outline" type="submit" disabled={readOnly || !draft.trim()}>添加条目</button>
          </form>
        </section>

        {sorted.length === 0 ? (
          <p className="rounded-card border border-dashed border-line bg-surface px-4 py-12 text-center text-sm text-fg-subtle">
            {readOnly ? '访客可查看界面；登录后可以导入自己的作业。' : '还没有作业。先选择文件夹，或手动添加一项。'}
          </p>
        ) : (
          <ul className="space-y-3">
            {sorted.map((item) => (
              <li key={item.id} className="card p-4 sm:p-5">
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={item.done}
                    disabled={readOnly}
                    onChange={(event) => update(item.id, { done: event.target.checked })}
                    aria-label={`完成 ${item.title}`}
                    className="mt-3 h-4 w-4 accent-primary"
                  />
                  <div className="min-w-0 flex-1">
                    <input
                      className="field w-full font-medium"
                      value={item.title}
                      disabled={readOnly}
                      aria-label="作业名称"
                      onChange={(event) => update(item.id, { title: event.target.value })}
                    />
                    {item.sourceFiles.length > 0 && (
                      <p className="mt-2 break-all text-xs text-fg-subtle" title={item.sourceFiles.join('\n')}>
                        来源：{item.sourceFiles.join('、')}
                      </p>
                    )}
                    <div className="mt-3 flex flex-wrap items-end gap-3">
                      <label className="min-w-[200px] flex-1 text-xs text-fg-muted">
                        截止时间
                        <input
                          className="field mt-1 w-full"
                          type="datetime-local"
                          value={item.dueAt}
                          disabled={readOnly}
                          onChange={(event) => update(item.id, { dueAt: event.target.value })}
                        />
                      </label>
                      <label className="text-xs text-fg-muted">
                        优先级
                        <select
                          className="field mt-1 w-24"
                          value={item.priority}
                          disabled={readOnly}
                          onChange={(event) => update(item.id, { priority: Number(event.target.value) as DeadlineAssignment['priority'] })}
                        >
                          {([1, 2, 3] as const).map((value) => <option key={value} value={value}>{PRIORITY_LABEL[value]}</option>)}
                        </select>
                      </label>
                      <button
                        type="button"
                        className="btn btn-danger"
                        disabled={readOnly}
                        onClick={() => { if (window.confirm(`删除“${item.title}”条目？`)) remove(item.id) }}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-5 text-xs leading-relaxed text-fg-subtle">
          条目目前只保存在此浏览器的当前账号下，尚未同步到其他设备。后续接入 DeepSeek 时，再从文档正文提取并建议截止时间；建议仍需人工核对。
        </p>
      </div>
    </div>
  )
}
