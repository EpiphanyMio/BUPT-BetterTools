import { useState } from 'react'
import { isGuest } from '../lib/guestMode'
import type { DeadlineAiSettings } from '../types'

const KEY_PREFIX = 'better-tools:deadline-ai:'

export const DEFAULT_DEADLINE_AI_SETTINGS: DeadlineAiSettings = {
  apiBaseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  apiKey: '',
}

function readSettings(userId: number | null): DeadlineAiSettings {
  if (userId === null) return DEFAULT_DEADLINE_AI_SETTINGS
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY_PREFIX + userId) ?? 'null')
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_DEADLINE_AI_SETTINGS
    const value = parsed as Record<string, unknown>
    return {
      apiBaseUrl: typeof value.apiBaseUrl === 'string' ? value.apiBaseUrl : DEFAULT_DEADLINE_AI_SETTINGS.apiBaseUrl,
      model: typeof value.model === 'string' ? value.model : DEFAULT_DEADLINE_AI_SETTINGS.model,
      apiKey: typeof value.apiKey === 'string' ? value.apiKey : '',
    }
  } catch {
    return DEFAULT_DEADLINE_AI_SETTINGS
  }
}

export function useDeadlineAiSettings(userId: number | null) {
  const [settings, setSettings] = useState(() => readSettings(userId))

  function save(next: DeadlineAiSettings) {
    if (userId === null || isGuest()) return
    localStorage.setItem(KEY_PREFIX + userId, JSON.stringify(next))
    setSettings(next)
  }

  function update(patch: Partial<DeadlineAiSettings>) {
    save({ ...settings, ...patch })
  }

  function useDeepSeekDefaults() {
    save({ ...settings, apiBaseUrl: DEFAULT_DEADLINE_AI_SETTINGS.apiBaseUrl, model: DEFAULT_DEADLINE_AI_SETTINGS.model })
  }

  return { settings, update, useDeepSeekDefaults }
}
