import { getSessionToken } from './auth'
import type { DeadlineAiSettings, DeadlineAiSuggestion } from '../types'

const MAX_FILE_BYTES = 15 * 1024 * 1024
const SUPPORTED_EXTENSIONS = ['.docx', '.pdf', '.md', '.txt'] as const

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot).toLocaleLowerCase()
}

export function isDeadlineAiFile(file: File): boolean {
  return SUPPORTED_EXTENSIONS.includes(extensionOf(file.name) as (typeof SUPPORTED_EXTENSIONS)[number])
}

// 同一项有 DOCX 和 PDF 时优先 DOCX：通常结构更完整，也避免把重复正文发给模型多花一次费用。
export function chooseDeadlineAiFile(files: File[]): File | null {
  const rank = new Map([['.docx', 0], ['.pdf', 1], ['.md', 2], ['.txt', 3]])
  return files
    .filter(isDeadlineAiFile)
    .sort((a, b) => (rank.get(extensionOf(a.name)) ?? 99) - (rank.get(extensionOf(b.name)) ?? 99))[0] ?? null
}

function isSuggestion(value: unknown): value is DeadlineAiSuggestion {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return typeof item.sourceKey === 'string' && typeof item.title === 'string' &&
    (item.dueAt === null || typeof item.dueAt === 'string') && typeof item.dueText === 'string' &&
    [1, 2, 3].includes(item.priority as number) && typeof item.confidence === 'number' &&
    typeof item.evidence === 'string' && (item.estimatedHours === null || typeof item.estimatedHours === 'number')
}

export async function analyzeDeadlineFile(
  file: File,
  sourceKey: string,
  currentTitle: string,
  settings: DeadlineAiSettings,
): Promise<DeadlineAiSuggestion> {
  if (file.size > MAX_FILE_BYTES) throw new Error(`“${file.name}”超过 15 MB，暂时不能识别`)
  const token = getSessionToken()
  if (!token) throw new Error('登录已失效，请重新登录')

  const body = new FormData()
  body.set('file', file, file.name)
  body.set('sourceKey', sourceKey)
  body.set('currentTitle', currentTitle)
  body.set('apiBaseUrl', settings.apiBaseUrl.trim())
  body.set('model', settings.model.trim())

  let response: Response
  try {
    response = await fetch('/api/deadlines/analyze', {
      method: 'POST',
      cache: 'no-store',
      headers: {
        authorization: `Bearer ${token}`,
        'x-ai-api-key': settings.apiKey.trim(),
      },
      body,
    })
  } catch {
    throw new Error('连不上识别服务，请检查网络后重试')
  }

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    // 统一在下面翻译成可读错误。
  }
  if (!response.ok) {
    const message = typeof payload === 'object' && payload !== null &&
      typeof (payload as Record<string, unknown>).message === 'string'
      ? (payload as Record<string, string>).message
      : `识别服务返回 ${response.status}`
    throw new Error(message)
  }
  const suggestion = typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>).suggestion
    : null
  if (!isSuggestion(suggestion)) throw new Error('模型返回的数据格式不完整，请重试')
  return suggestion
}
