// Cloudflare D1 的最小类型声明。
//
// 为什么不装 @cloudflare/workers-types：这里只用到五六条方法，为一个类型包多装几十 MB
// 依赖不划算。而且 worker/ 不在 tsconfig 的 include（只有 src/）里，
// pnpm build 的 tsc 本来就不会检查这个目录，这些声明主要是给编辑器和读代码的人看的。
//
// 为什么单独拆一个文件：index.ts 和 auth.ts 都要用这几个类型。各抄一份的话，
// 将来 D1 这边加一个方法（比如 batch）就得记得改两处，漏一处编译期没感觉、运行期才炸。

export interface D1Result<T = Record<string, unknown>> {
  success: boolean
  meta: {
    /** 这条语句实际改到了几行 —— 乐观锁、邀请码有没有抢到，全靠它判断 */
    changes: number
  }
  results: T[]
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>
  run(): Promise<D1Result>
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement
}
