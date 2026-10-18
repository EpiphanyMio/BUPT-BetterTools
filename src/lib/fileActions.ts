// 打开 / 下载一个文件节点。
//
// 为什么单独抽出来：文件管理模块和「全局搜索」都要做这两件事，
// 而它们都得小心同一个坑 —— blob: 地址不能马上释放（见下面注释）。
// 复制两份代码，日后很容易改了一处忘了另一处。

import { getBlob, type FileNode } from './fileStore'
import { guessMime } from './fileUtils'

/** 在新标签页打开文件。返回 false 表示库里找不到这个文件的内容。 */
export async function openFileNode(node: FileNode): Promise<boolean> {
  const blob = await getBlob(node.id)
  if (!blob) return false

  // Blob（一块内存里的二进制数据）本身没有"地址"。
  // 先让浏览器给它造一个临时地址（blob: 开头），新标签页才能加载它。
  // 上传时浏览器没给类型的话，按扩展名补一个 —— 否则 PDF 会被当成纯文本下载。
  const typed = blob.type ? blob : new Blob([blob], { type: guessMime(node.name) })
  const url = URL.createObjectURL(typed)
  window.open(url, '_blank', 'noopener')

  // ★ 不能立刻释放：新标签页还在按这个地址加载内容，马上 revoke 会打不开。
  //   留一分钟足够它读完，之后浏览器会自动回收这块内存。
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return true
}

/** 触发浏览器下载这个文件。返回 false 表示库里找不到它的内容。 */
export async function downloadFileNode(node: FileNode): Promise<boolean> {
  const blob = await getBlob(node.id)
  if (!blob) return false

  const url = URL.createObjectURL(blob)
  // 造一个临时的 <a download> 并替用户点一下。
  // 为什么不用 window.open：那样只会打开预览，不会"另存为"。
  const link = document.createElement('a')
  link.href = url
  link.download = node.name
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return true
}
