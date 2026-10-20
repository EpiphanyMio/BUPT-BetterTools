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

// Deadline 管理器只保存文件名和相对路径，不保存作业正文。
// 截止时间未知时留空，避免把文件修改时间误写成截止时间。
export interface DeadlineAssignment {
  id: string
  title: string
  dueAt: string
  priority: 1 | 2 | 3
  done: boolean
  sourceKey: string
  sourceFiles: string[]
}

// AI 配置只保存在当前浏览器，不进入账号快照；API Key 每次识别时临时交给 Worker 转发。
export interface DeadlineAiSettings {
  apiBaseUrl: string
  model: string
  apiKey: string
}

// 模型先给“候选建议”，用户确认后才会写进 DeadlineAssignment。
export interface DeadlineAiSuggestion {
  sourceKey: string
  title: string
  dueAt: string | null
  dueText: string
  priority: 1 | 2 | 3
  confidence: number
  evidence: string
  estimatedHours: number | null
}

// 「全局搜索」在结果里点到文件夹时，需要让 App 切到文件管理并打开那个目录。
// 用一个带序号（seq）的请求对象，而不是直接传 folderId ——
// 因为同一个文件夹连点两次，只有 seq 变了，界面才知道"又收到一次新请求"。
export interface FileJumpRequest {
  folderId: string
  /** 目标文件夹在「我的文件」还是「公共文件池」；不传按我的文件处理 */
  scope?: 'private' | 'public'
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

// 同步状态机的七个状态：
//   unauthenticated —— 没登录（没有会话令牌），一个请求都不发
//   unconfigured —— 旧版"没填共享令牌"留下的状态，现在已经不会出现，保留只是为了兼容旧代码
//   idle         —— 已登录，等着第一次同步
//   syncing      —— 请求发出去了、还没回来
//   synced       —— 本地和云端一致
//   offline      —— 连不上服务器（断网 / 服务没起来），本地照常可用
//   error        —— 服务器明确报错（令牌失效、数据超限…），需要人看一眼
export type SyncStatus =
  | 'unauthenticated'
  | 'unconfigured'
  | 'idle'
  | 'syncing'
  | 'synced'
  | 'error'
  | 'offline'

// 给界面读的状态。整个应用只有一份，由 src/lib/sync.ts 维护并缓存在模块顶层。
export interface SyncState {
  status: SyncStatus
  revision: number      // 本地记住的云端版本号（我上次看到的云端是第几版）
  updatedAt: number     // 云端那份数据最后一次被写入的时间
  lastError: string     // 中文错误说明，没出错时是空字符串
  lastSyncedAt: number  // 这台设备上次同步成功的时间，0 表示本次打开还没成功过
}

// ---------------------------------------------------------------- 多用户登录
//
// 下面这几样只给「登录 / 邀请码」用（src/lib/auth.ts、src/components/AuthScreen.tsx、
// src/components/InviteAdmin.tsx）。它们的形状必须和 worker/ 里的接口契约一致 ——
// 前后端共用同一份约定，改一处就得同时改另一处。

// 当前登录的人。
//
// isAdmin 只能来自服务器（登录、注册、GET /api/auth/me 这三个响应）。
// 为什么不存进 localStorage：存了就能被手动改，管理员区块虽然只是"显示"，但界面
// 一旦按假身份渲染，用户会以为那些操作真的生效了 —— 服务端回 403 之后更难解释。
export interface AuthUser {
  id: number
  username: string
  isAdmin: boolean
}

// 登录状态机三态：
//   loading       —— 本地存着令牌，正在向服务器确认它还有没有效
//   anonymous     —— 没有令牌（或者令牌已失效），只显示登录界面
//   authenticated —— 令牌有效，已经拿到 user
export type AuthStatus = 'loading' | 'anonymous' | 'authenticated'

// 给界面读的状态。整个应用只有一份，由 src/lib/auth.ts 维护并缓存在模块顶层。
export interface AuthState {
  status: AuthStatus
  user: AuthUser | null   // 只有 authenticated 时才有值
  lastError: string       // 中文错误说明，没出错时是空字符串
}

// 一条邀请码。每个邀请码只能注册一个账号，用过之后会记下是谁用的。
export interface Invite {
  code: string
  createdAt: number        // 创建时间（毫秒时间戳）
  usedBy: string | null    // 使用者的用户名；没用过是 null
  usedAt: number | null    // 使用时间（毫秒时间戳）；没用过是 null
}

// ---------------------------------------------------------------- 用户组管理
//
// 下面这两样只给「用户组管理」用（src/lib/userAdmin.ts、src/modules/UserAdminModule.tsx）。
// 形状必须和 worker/ 的 GET /api/admin/users 契约一致 —— 前后端共用同一份约定。

// 一个注册用户在管理员视角下的全貌。
//
// 为什么把用量、文件数、登录信息全塞进同一行，而不是只给用户名：
//   管理员打开这个页面通常是为了排查"云盘谁占满了"或"这个账号最近有没有异常登录"，
//   如果还要再点开每个用户，一次排查就得多发十几个请求。接口一次给全，页面才能一眼扫完。
export interface AdminUser {
  id: number
  username: string
  isAdmin: boolean
  createdAt: number             // 注册时间（毫秒时间戳）
  lastLoginAt: number | null    // 最近登录时间；null 表示从未登录
  lastLoginIp: string           // 最近登录 IP；空字符串表示没有记录
  usedBytes: number             // 云盘已用字节数
  fileCount: number             // 文件数
  folderCount: number           // 文件夹数
  shareCount: number            // 公开分享链接数
  // 这个账号自己的配额（字节）。为什么配额是"每人一份"而不是全站统一：
  // 管理员需要按账号分配空间（比如给常用的人多批一点、给测试号清零），
  // 全站统一值表达不了这种差异。不带这个字段就分不清哪一行超额了。
  quota: number
}

// GET /api/admin/users 的完整响应。
//
// 为什么是三个字段而不是一个 quota：
//   siteQuota    —— 全站池子的上限（10 GB），决定"总量还能装多少"；
//   defaultQuota —— 没单独设置过的账号用的默认额度（500 MB），
//                   "恢复默认"按钮和输入框占位都靠它；
//   users[].quota—— 每个账号实际生效的个人额度。
// 只返回其中一个，页面就没法同时解释"为什么这个人是 500 MB、全站却写着 10 GB"。
// 注意 quota 现在在用户行里，顶层不再有统一配额字段。
export interface AdminUsersResult {
  users: AdminUser[]
  defaultQuota: number          // 默认单账号配额（字节）
  siteQuota: number             // 全站总配额（字节）
}

