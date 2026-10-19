// Cloudflare R2 的最小类型声明。
//
// 和 worker/d1.ts 同一个理由：这里只用到 put / get / delete 三个方法，
// 为了几个类型装 @cloudflare/workers-types（几十 MB）不划算。
// worker/ 也不在 tsconfig 的 include 里（只有 src/），tsc 本来就不检查这个目录，
// 这些声明主要是给编辑器和读代码的人看的。

export interface R2ObjectMeta {
  /** 对象真实字节数（R2 记的，比客户端声明的 Content-Length 可信） */
  size: number
  httpMetadata?: {
    contentType?: string
  }
  /**
   * 自定义元数据（键值都是字符串，总大小 ≤ 2KB）。
   *
   * 目前只放一个 uploader：公共文件池的内容不属于某一个账号，
   * 但配额是记在「谁传的」头上的 —— 删除时要靠它把钱退给对的人。
   * 为什么不另建一张 D1 表：那需要线上跑 schema，漏跑会让上传 500；
   * 元数据跟着对象走，天然是原子的，也不增加一次数据库读写。
   */
  customMetadata?: Record<string, string>
}

export interface R2ObjectBody extends R2ObjectMeta {
  /** 文件内容。直接塞进 new Response(...) 就能流式返回，不用整个读进内存。 */
  body: ReadableStream
}

export interface R2Bucket {
  /**
   * 写入一个对象。value 可以是一个流 —— 上传接口就是把 request.body 原样转发，
   * 这样 50MB 的文件也不会在 Worker 内存里堆成一大块。
   */
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | string,
    options?: {
      httpMetadata?: { contentType?: string }
      customMetadata?: Record<string, string>
    },
  ): Promise<unknown>

  /** 读一个对象；不存在返回 null（不是抛错）。 */
  get(key: string): Promise<R2ObjectBody | null>

  /**
   * 只读元数据，不读内容。
   *
   * 用途：算配额差额。客户端在传内容之前会先推一份「猜测的大小」用于列表显示，
   * 库里的 size 不能拿来当「已占字节」；真正的用量以 R2 里的对象为准。
   * 删除时也要靠它知道该把多少字节退回去。
   */
  head(key: string): Promise<R2ObjectMeta | null>

  /** 删除一个对象；对象本来就不存在也算成功。 */
  delete(key: string): Promise<void>
}
