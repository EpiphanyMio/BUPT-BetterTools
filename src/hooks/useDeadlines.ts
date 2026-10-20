import { useState } from 'react'
import { isGuest } from '../lib/guestMode'
import type { DeadlineAssignment } from '../types'

const KEY_PREFIX = 'better-tools:deadlines:'

function storageKey(userId: number | null): string {
  return KEY_PREFIX + (userId === null ? 'guest' : userId)
}

function readAssignments(userId: number | null): DeadlineAssignment[] {
  if (userId === null) return []
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey(userId)) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is DeadlineAssignment =>
      typeof entry === 'object' && entry !== null &&
      typeof entry.id === 'string' && typeof entry.title === 'string' &&
      typeof entry.dueAt === 'string' && [1, 2, 3].includes(entry.priority) &&
      typeof entry.done === 'boolean' && typeof entry.sourceKey === 'string' &&
      Array.isArray(entry.sourceFiles) && entry.sourceFiles.every((path: unknown) => typeof path === 'string'),
    )
  } catch {
    return []
  }
}

function makeId(): string {
  return crypto.randomUUID()
}

// 文件名只负责创建草稿；文档正文和真实截止时间留给后续解析器。
export function importDeadlineFiles(files: File[], existing: DeadlineAssignment[]) {
  const grouped = new Map<string, { title: string; paths: string[] }>()
  for (const file of files) {
    const relative = file.webkitRelativePath || file.name
    if (!relative || file.name.startsWith('.') || file.name.startsWith('~$')) continue
    const parts = relative.split('/')
    const path = parts.length > 1 ? parts.slice(1).join('/') : relative
    const stem = file.name.replace(/\.[^.]+$/, '').trim()
    const folder = path.slice(0, -file.name.length)
    if (!stem) continue
    const key = (folder + stem).toLocaleLowerCase()
    const group = grouped.get(key) ?? { title: stem, paths: [] }
    group.paths.push(path)
    grouped.set(key, group)
  }

  const next = [...existing]
  let added = 0
  for (const [sourceKey, group] of grouped) {
    const index = next.findIndex((item) => item.sourceKey === sourceKey)
    if (index >= 0) {
      // 重选同一个文件夹时更新文件列表，保留已经手填的日期、优先级和完成状态。
      next[index] = { ...next[index], sourceFiles: [...new Set(group.paths)] }
    } else {
      next.push({
        id: makeId(), title: group.title, dueAt: '', priority: 2,
        done: false, sourceKey, sourceFiles: [...new Set(group.paths)],
      })
      added += 1
    }
  }
  return { assignments: next, added, scanned: grouped.size }
}

export function useDeadlines(userId: number | null) {
  const [assignments, setAssignments] = useState(() => readAssignments(userId))

  function save(next: DeadlineAssignment[]) {
    if (userId === null || isGuest()) return
    localStorage.setItem(storageKey(userId), JSON.stringify(next))
    setAssignments(next)
  }

  function importFiles(files: File[]) {
    const result = importDeadlineFiles(files, assignments)
    if (result.scanned > 0) save(result.assignments)
    return result
  }

  function add(title: string) {
    const clean = title.trim()
    if (!clean || userId === null || isGuest()) return
    save([...assignments, {
      id: makeId(), title: clean, dueAt: '', priority: 2,
      done: false, sourceKey: '', sourceFiles: [],
    }])
  }

  function update(id: string, patch: Partial<Pick<DeadlineAssignment, 'title' | 'dueAt' | 'priority' | 'done'>>) {
    save(assignments.map((item) => item.id === id ? { ...item, ...patch } : item))
  }

  function remove(id: string) {
    save(assignments.filter((item) => item.id !== id))
  }

  return { assignments, importFiles, add, update, remove }
}
