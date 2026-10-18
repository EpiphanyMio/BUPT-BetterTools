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

// ---------------------------------------------------------------- 云端同步
//
// 下面这几样只给「云端同步」用（src/lib/sync.ts 和 src/hooks/useSync.ts）。

// 多台设备之间要保持一致的那部分数据。
//
// 为什么只有这五项：devSettings 是调试参数，theme 是这台设备自己的显示偏好 ——
// 手机白天用浅色、电脑晚上用深色都是合理的，把它们也同步过去，
// 等于用另一台设备的偏好把你的设置盖掉，反而添乱。
export interface SyncData {
  tools: Tool[]
  groups: string[]
  favorites: string[]
  order: string[]
  appSettings: { defaultCategory: string }
}

// 云端的一份快照。revision 由服务器维护：每写一次 +1，0 表示"云端从来没存过数据"。
//
// 为什么用版本号而不是比时间戳：各台设备的系统时钟不一定准（差几分钟很常见），
// 拿时间戳判断"谁更新"迟早会判错；版本号是服务器自己数的，只有一个来源，不会打架。
export interface SyncSnapshot {
  revision: number
  updatedAt: number      // 服务器写入这份数据的时间（毫秒时间戳），0 表示还没有数据
  data: SyncData | null
}

// 同步状态机的六个状态：
//   unconfigured —— 还没填令牌，什么都不做
//   idle         —— 填了令牌，等着第一次同步
//   syncing      —— 请求发出去了、还没回来
//   synced       —— 本地和云端一致
//   offline      —— 连不上服务器（断网 / 服务没起来），本地照常可用
//   error        —— 服务器明确报错（令牌失效、数据超限…），需要人看一眼
export type SyncStatus = 'unconfigured' | 'idle' | 'syncing' | 'synced' | 'error' | 'offline'

// 给界面读的状态。整个应用只有一份，由 src/lib/sync.ts 维护并缓存在模块顶层。
export interface SyncState {
  status: SyncStatus
  revision: number      // 本地记住的云端版本号（我上次看到的云端是第几版）
  updatedAt: number     // 云端那份数据最后一次被写入的时间
  lastError: string     // 中文错误说明，没出错时是空字符串
  lastSyncedAt: number  // 这台设备上次同步成功的时间，0 表示本次打开还没成功过
}

