// 文件管理用到的小工具函数：容量格式化、时间格式化、按扩展名猜图标。

/** 把字节数变成人看得懂的大小，例如 1536 -> "1.5 KB" */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  // 字节数不带小数，其它保留一位
  const digits = unit === 0 ? 0 : value >= 100 ? 0 : 1
  return value.toFixed(digits) + ' ' + units[unit]
}

/** 时间戳 -> "10-12 13:20"，今年的不显示年份 */
export function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (n: number) => String(n).padStart(2, '0')
  const md = pad(date.getMonth() + 1) + '-' + pad(date.getDate())
  const hm = pad(date.getHours()) + ':' + pad(date.getMinutes())
  return date.getFullYear() === new Date().getFullYear()
    ? md + ' ' + hm
    : date.getFullYear() + '-' + md + ' ' + hm
}

/** 取扩展名（小写，不含点） */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

// 常见类型的图标。注意这是"按扩展名猜"，不是按真实内容判断。
const ICONS: Record<string, string> = {
  pdf: '📕',
  doc: '📘',
  docx: '📘',
  xls: '📗',
  xlsx: '📗',
  ppt: '📙',
  pptx: '📙',
  txt: '📄',
  md: '📝',
  png: '🖼️',
  jpg: '🖼️',
  jpeg: '🖼️',
  gif: '🖼️',
  webp: '🖼️',
  svg: '🖼️',
  bmp: '🖼️',
  zip: '🗜️',
  rar: '🗜️',
  '7z': '🗜️',
  mp3: '🎵',
  wav: '🎵',
  mp4: '🎬',
  mov: '🎬',
  json: '🧾',
  csv: '📊',
}

export function iconFor(name: string, kind: 'folder' | 'file'): string {
  if (kind === 'folder') return '📁'
  return ICONS[extensionOf(name)] ?? '📄'
}

/** 文件能不能直接在浏览器里打开预览 */
export function canPreview(name: string): boolean {
  const ext = extensionOf(name)
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'pdf', 'txt', 'md', 'json', 'csv'].includes(ext)
}

/** 上传时如果浏览器没给类型，就按扩展名补一个，方便日后再判断 */
export function guessMime(name: string): string {
  const ext = extensionOf(name)
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
    csv: 'text/csv',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    zip: 'application/zip',
  }
  return map[ext] ?? 'application/octet-stream'
}
