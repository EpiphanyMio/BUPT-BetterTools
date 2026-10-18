// 这个文件定义"数据长什么样"。
// TypeScript 的好处：如果字段拼错或漏写，编辑器立刻会报错。

// 一个"工具"（工具卡片）的数据形状
export interface Tool {
  id: string          // 唯一标识，用来做收藏、排序、列表 key
  name: string        // 名称
  url: string         // 网址
  description: string // 备注（显示在名称下方的一句话）
  category: string    // 所属分组名称，比如 "开发"、"教务"
  icon?: string       // 图标（emoji），可选
}

// 表单里让用户填的字段。
// id 和 category 不由用户填写，所以单独分出来，由程序负责补上。
export interface ToolDraft {
  name: string
  url: string
  icon: string
  description: string
}

// 「全局搜索」在结果里点到文件夹时，需要让 App 切到文件管理并打开那个目录。
// 用一个带序号（seq）的请求对象，而不是直接传 folderId ——
// 因为同一个文件夹连点两次，只有 seq 变了，界面才知道"又收到一次新请求"。
export interface FileJumpRequest {
  folderId: string
  seq: number
}
