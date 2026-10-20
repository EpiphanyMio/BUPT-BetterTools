import { useMemo, useRef, useState } from 'react'
import { useAuth } from '../hooks/useAuth'
import { useDeadlineAiSettings } from '../hooks/useDeadlineAiSettings'
import { useDeadlines, type DeadlineFileGroup } from '../hooks/useDeadlines'
import { analyzeDeadlineFile, chooseDeadlineAiFile } from '../lib/deadlineAi'
import type { DeadlineAiSuggestion, DeadlineAssignment } from '../types'

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
  const { settings: aiSettings, update: updateAiSettings, useDeepSeekDefaults } = useDeadlineAiSettings(user?.id ?? null)
  const [draft, setDraft] = useState('')
  const [notice, setNotice] = useState('')
  const [fileGroups, setFileGroups] = useState<DeadlineFileGroup[]>([])
  const [suggestions, setSuggestions] = useState<DeadlineAiSuggestion[]>([])
  const [analyzing, setAnalyzing] = useState(false)
  const [aiNotice, setAiNotice] = useState('')
  const [progress, setProgress] = useState('')
  const directoryRef = useRef<HTMLInputElement>(null)
  const sorted = useMemo(() => [...assignments].sort(sortAssignments), [assignments])
  const assignmentBySource = useMemo(() => new Map(assignments.map((item) => [item.sourceKey, item])), [assignments])
  const pending = assignments.filter((item) => !item.done).length
  const missingDates = assignments.filter((item) => !item.done && !item.dueAt).length
  const analyzableCount = fileGroups.filter((group) => chooseDeadlineAiFile(group.files)).length

  function patchSuggestion(sourceKey: string, patch: Partial<DeadlineAiSuggestion>) {
    setSuggestions((current) => current.map((item) => item.sourceKey === sourceKey ? { ...item, ...patch } : item))
  }

  async function analyzeSelectedFiles() {
    if (!aiSettings.apiKey.trim()) {
      setAiNotice('请先填写 API Key。')
      return
    }
    if (!aiSettings.apiBaseUrl.trim() || !aiSettings.model.trim()) {
      setAiNotice('请填写 API 地址和模型名称。')
      return
    }
    const jobs = fileGroups.flatMap((group) => {
      const file = chooseDeadlineAiFile(group.files)
      const assignment = assignmentBySource.get(group.sourceKey)
      return file && assignment ? [{ group, file, assignment }] : []
    })
    if (jobs.length === 0) {
      setAiNotice('请重新选择作业文件夹；当前没有可识别的 DOCX、PDF、MD 或 TXT 文件。')
      return
    }

    setAnalyzing(true)
    setAiNotice('')
    let succeeded = 0
    const failures: string[] = []
    for (let index = 0; index < jobs.length; index += 1) {
      const job = jobs[index]
      setProgress(`正在识别 ${index + 1}/${jobs.length}：${job.file.name}`)
      try {
        const suggestion = await analyzeDeadlineFile(
          job.file,
          job.group.sourceKey,
          job.assignment.title,
          aiSettings,
        )
        setSuggestions((current) => [
          ...current.filter((item) => item.sourceKey !== suggestion.sourceKey),
          suggestion,
        ])
        succeeded += 1
      } catch (error) {
        failures.push(`${job.file.name}：${error instanceof Error ? error.message : '识别失败'}`)
      }
    }
    setAnalyzing(false)
    setProgress('')
    setAiNotice(
      failures.length === 0
        ? `已生成 ${succeeded} 条建议，请逐条核对后应用。`
        : `成功 ${succeeded} 项，失败 ${failures.length} 项。${failures.slice(0, 2).join('；')}`,
    )
  }

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
            只有点击 AI 识别后，选中的单个文档才会上传处理。
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button type="button" className="btn btn-primary" disabled={readOnly || analyzing} onClick={() => directoryRef.current?.click()}>
              选择文件夹
            </button>
            <span className="text-xs text-fg-subtle">重选会补充新条目，并保留已填写的截止时间。</span>
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
              setFileGroups(result.groups)
              setSuggestions([])
              setNotice(`扫描 ${result.scanned} 项作业，新增 ${result.added} 项；其中 ${result.groups.filter((group) => chooseDeadlineAiFile(group.files)).length} 项可交给 AI 识别。`)
              event.currentTarget.value = ''
            }}
          />
          {notice && <p role="status" className="mt-3 text-sm text-primary">{notice}</p>}
        </section>

        <section className="card mb-4 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-medium">AI 识别设置</h2>
              <p className="mt-1 text-sm text-fg-muted">默认使用 DeepSeek，也可填写其他兼容 OpenAI Chat Completions 的服务。</p>
            </div>
            <button type="button" className="btn btn-neutral btn-sm" disabled={readOnly || analyzing} onClick={useDeepSeekDefaults}>
              恢复 DeepSeek 默认值
            </button>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <label className="text-xs text-fg-muted">
              API 地址
              <input
                className="field mt-1"
                value={aiSettings.apiBaseUrl}
                disabled={readOnly || analyzing}
                placeholder="https://api.deepseek.com"
                onChange={(event) => updateAiSettings({ apiBaseUrl: event.target.value })}
              />
            </label>
            <label className="text-xs text-fg-muted">
              模型名称
              <input
                className="field mt-1"
                value={aiSettings.model}
                disabled={readOnly || analyzing}
                placeholder="deepseek-flash"
                onChange={(event) => updateAiSettings({ model: event.target.value })}
              />
            </label>
            <label className="text-xs text-fg-muted md:col-span-2">
              API Key
              <input
                className="field mt-1"
                type="password"
                autoComplete="off"
                value={aiSettings.apiKey}
                disabled={readOnly || analyzing}
                placeholder="sk-..."
                onChange={(event) => updateAiSettings({ apiKey: event.target.value })}
              />
            </label>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-fg-subtle">
            配置只保存在当前浏览器的当前账号下，不写入 D1，也不同步到其他设备。识别时 API Key 会经 BetterTools Worker 临时转发给你填写的 AI 服务。
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="btn btn-primary"
              disabled={readOnly || analyzing || analyzableCount === 0}
              onClick={() => { void analyzeSelectedFiles() }}
            >
              {analyzing ? '识别中…' : `AI 识别 ${analyzableCount || ''} 项`}
            </button>
            <span className="text-xs text-fg-subtle">支持 DOCX、文字型 PDF、MD、TXT；旧版 DOC 和扫描 PDF 暂不支持。</span>
          </div>
          {progress && <p role="status" className="mt-3 text-sm text-primary">{progress}</p>}
          {aiNotice && <p role="status" className="mt-3 text-sm text-fg-muted">{aiNotice}</p>}
        </section>

        {suggestions.length > 0 && (
          <section className="card mb-4 p-5">
            <h2 className="text-lg font-medium">待确认的 AI 建议</h2>
            <p className="mt-1 text-xs text-fg-subtle">模型可能误读日期。请检查原文依据，确认后再应用到条目。</p>
            <ul className="mt-4 space-y-3">
              {suggestions.map((suggestion) => {
                const target = assignmentBySource.get(suggestion.sourceKey)
                if (!target) return null
                return (
                  <li key={suggestion.sourceKey} className="rounded-card border border-line-soft bg-surface-2 p-4">
                    <div className="grid gap-3 md:grid-cols-[1fr_220px_100px]">
                      <label className="text-xs text-fg-muted">
                        作业名称
                        <input className="field mt-1" value={suggestion.title} onChange={(event) => patchSuggestion(suggestion.sourceKey, { title: event.target.value })} />
                      </label>
                      <label className="text-xs text-fg-muted">
                        建议截止时间
                        <input className="field mt-1" type="datetime-local" value={suggestion.dueAt ?? ''} onChange={(event) => patchSuggestion(suggestion.sourceKey, { dueAt: event.target.value || null })} />
                      </label>
                      <label className="text-xs text-fg-muted">
                        优先级
                        <select className="field mt-1" value={suggestion.priority} onChange={(event) => patchSuggestion(suggestion.sourceKey, { priority: Number(event.target.value) as DeadlineAssignment['priority'] })}>
                          {([1, 2, 3] as const).map((value) => <option key={value} value={value}>{PRIORITY_LABEL[value]}</option>)}
                        </select>
                      </label>
                    </div>
                    <p className="mt-3 text-xs text-fg-muted">
                      原文日期：{suggestion.dueText || '未找到明确日期'} · 置信度 {Math.round(suggestion.confidence * 100)}%
                      {suggestion.estimatedHours !== null ? ` · 预计 ${suggestion.estimatedHours} 小时` : ''}
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-fg-subtle">依据：{suggestion.evidence || '模型未提供原文依据'}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() => {
                          update(target.id, {
                            title: suggestion.title.trim() || target.title,
                            priority: suggestion.priority,
                            ...(suggestion.dueAt ? { dueAt: suggestion.dueAt } : {}),
                          })
                          setSuggestions((current) => current.filter((item) => item.sourceKey !== suggestion.sourceKey))
                        }}
                      >
                        应用建议
                      </button>
                      <button type="button" className="btn btn-neutral btn-sm" onClick={() => setSuggestions((current) => current.filter((item) => item.sourceKey !== suggestion.sourceKey))}>
                        忽略
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          </section>
        )}

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
          条目和 AI 配置保存在此浏览器的当前账号下，尚未同步到其他设备；上传文档只用于本次转换与识别。
        </p>
      </div>
    </div>
  )
}
