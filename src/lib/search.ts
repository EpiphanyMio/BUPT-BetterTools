// 全局搜索用到的两个纯逻辑：匹配打分 + 关键词高亮。
//
// 为什么单独放一个文件：这两件事都跟界面无关 ——
// 输入「一段文字 + 关键词」，输出「匹不匹配 / 该排多前 / 哪几个字要高亮」。
// 抽出来之后，组件只管把结果画出来，逻辑本身也能单独验证。

import type { Tool } from '../types'

/** 把用户输入规整成用于比较的关键词：去掉首尾空白 + 转小写。 */
export function normalizeKeyword(raw: string): string {
  return raw.trim().toLowerCase()
}

// 得分越小越靠前，返回 -1 表示"没匹配上"。
//
// 为什么要打分，而不是"匹配上就行"：
//   搜 "git" 时，名字叫「GitHub」的应该排在"备注里提到 github"的前面。
//   用一个数字表示"命中在哪个字段"，排序就变成了一行代码。
export const SCORE_NAME_PREFIX = 0 // 名称以关键词开头
export const SCORE_NAME_PART = 1 // 名称里包含
export const SCORE_CATEGORY = 2 // 分组名命中
export const SCORE_URL = 3 // 网址命中
export const SCORE_DESCRIPTION = 4 // 备注命中

/** 给一个工具打分：名称开头 > 名称包含 > 分组 > 网址 > 备注 */
export function scoreTool(tool: Tool, keyword: string): number {
  const name = tool.name.toLowerCase()
  if (name.startsWith(keyword)) return SCORE_NAME_PREFIX
  if (name.includes(keyword)) return SCORE_NAME_PART
  if (tool.category.toLowerCase().includes(keyword)) return SCORE_CATEGORY
  if (tool.url.toLowerCase().includes(keyword)) return SCORE_URL
  if (tool.description.toLowerCase().includes(keyword)) return SCORE_DESCRIPTION
  return -1
}

/** 给一个文件/文件夹名打分。只有名字可搜，开头命中优先。 */
export function scoreFileName(name: string, keyword: string): number {
  const lower = name.toLowerCase()
  if (lower.startsWith(keyword)) return SCORE_NAME_PREFIX
  if (lower.includes(keyword)) return SCORE_NAME_PART
  return -1
}

export interface TextSegment {
  text: string
  /** true 表示这一段就是命中的关键词，界面上要高亮 */
  hit: boolean
}

/**
 * 把一段文字按关键词切成若干段，标出哪几段命中。
 *
 * 为什么不直接拼一段 HTML 字符串（那样确实更短）：
 *   那要用 dangerouslySetInnerHTML 才能渲染，而这里的文字来自用户自己起的文件名，
 *   一旦名字里有 <script> 之类的内容就会被浏览器当成标签执行。
 *   切成数组交给 React 渲染，文字永远只是文字 —— 这是"默认安全"的写法。
 */
export function highlight(text: string, keyword: string): TextSegment[] {
  if (!keyword) return [{ text, hit: false }]

  const lower = text.toLowerCase()
  const segments: TextSegment[] = []
  let cursor = 0

  for (;;) {
    const at = lower.indexOf(keyword, cursor)
    if (at < 0) break
    // 命中处之前的普通文字
    if (at > cursor) segments.push({ text: text.slice(cursor, at), hit: false })
    // 命中处本身（按原文字取，保留大小写）
    segments.push({ text: text.slice(at, at + keyword.length), hit: true })
    cursor = at + keyword.length
  }

  if (cursor < text.length) segments.push({ text: text.slice(cursor), hit: false })
  return segments.length > 0 ? segments : [{ text, hit: false }]
}
