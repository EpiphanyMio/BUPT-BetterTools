// 图片混淆 / 解混淆引擎。
//
// 移植自 Java 库 ObfuscationUtils（作者 Uiloalxise，MIT License）：
// https://github.com/2195517546/ObfuscationUtils
//
// 为什么要在浏览器里重写一遍：原库是 Java（Gradle + AWT），网页里没有 JVM。
// 这些算法的本质都是「可逆的像素搬运」，搬到 TypeScript 之后可以完全在本地运行：
// 不用服务器、图片不用上传、速度快、也没有后端成本。
//
// 移植时逐行对照原实现，连 Java 特有的行为都照搬（int 溢出回绕、排序比较器、
// java.util.Random 的 LCG、String.hashCode），这样同一个密钥、同一张图，
// 两边得到的结果应当一致。
//
// 已移植：PicEncrypt 行、PicEncrypt 行列、Tomato、Block、RowPixel、PerPixel、
// Sort、Random。原库里的 XuanObfuscation 只是空壳（process 直接返回 null），未移植。
//
// 像素约定：原库用 BufferedImage.getRGB 拿到的是 ARGB int（A 在高 8 位），
// 这里内部统一转成 Int32Array 的 ARGB 再算，算完转回 Canvas 用的 RGBA 字节。

export type ProcessMode = 'encrypt' | 'decrypt'

export type AlgorithmId =
  | 'picencrypt-row-column'
  | 'picencrypt-row'
  | 'tomato'
  | 'block'
  | 'row-pixel'
  | 'per-pixel'
  | 'sort'
  | 'random'

/** 密钥是什么类型：不需要 / 数字 / 任意文本 / 整数种子 */
export type KeyKind = 'none' | 'number' | 'text' | 'seed'

export interface AlgorithmInfo {
  id: AlgorithmId
  /** 界面上显示的名字 */
  name: string
  /** 一句话说明，显示在算法下拉框下方 */
  summary: string
  keyKind: KeyKind
  /** 切换到该算法时填进密钥框的默认值 */
  defaultKey: string
  /** 密钥输入框下面的提示 */
  keyHint: string
}

export interface ImagePixels {
  rgba: Uint8ClampedArray
  width: number
  height: number
}

/** 处理上限（像素数）。超过这个量，内存和耗时都不划算，直接拒绝比卡死好。 */
export const MAX_PIXELS = 12_000_000

// 顺序就是界面下拉框里的顺序：最常用的排前面。
export const ALGORITHMS: readonly AlgorithmInfo[] = [
  {
    id: 'picencrypt-row-column',
    name: '行列混淆（PicEncrypt 行列）',
    summary: '最常见的一种：先按行打乱、再按列打乱，密钥通常是一个小数。',
    keyKind: 'number',
    defaultKey: '0.618',
    keyHint: '必须是数字，常见的有 0.618、0.114514 等；要和混淆时用的值完全一致。',
  },
  {
    id: 'picencrypt-row',
    name: '行混淆（PicEncrypt 行）',
    summary: '只按行打乱每个像素，左右错位、上下顺序不变。',
    keyKind: 'number',
    defaultKey: '0.618',
    keyHint: '必须是数字，常见的有 0.618、0.114514 等。',
  },
  {
    id: 'tomato',
    name: '番茄混淆（Tomato）',
    summary: '按一条希尔伯特曲线把整张图「拉直」再整体错位，打散得非常彻底。',
    keyKind: 'number',
    defaultKey: '114514',
    keyHint: '必须是数字（原库示例里常用 114514）。',
  },
  {
    id: 'block',
    name: '方块打乱（Block）',
    summary: '把图切成 32×32 的小方块再打乱位置，密钥可以是任意文字。',
    keyKind: 'text',
    defaultKey: 'bettertools',
    keyHint: '任意文字都行，要和混淆时一模一样（区分大小写）；建议只用英文/数字 —— 原库按系统编码处理中文，换台电脑可能对不上。',
  },
  {
    id: 'row-pixel',
    name: '行像素（RowPixel）',
    summary: '每一行内部按密钥打乱像素顺序，行的上下位置不变。',
    keyKind: 'text',
    defaultKey: 'bettertools',
    keyHint: '任意文字都行，要和混淆时一模一样（区分大小写）；建议只用英文/数字。',
  },
  {
    id: 'per-pixel',
    name: '像素级（PerPixel）',
    summary: '横竖两个方向都按密钥打乱，是这几种里「碎得最均匀」的。',
    keyKind: 'text',
    defaultKey: 'bettertools',
    keyHint: '任意文字都行，要和混淆时一模一样（区分大小写）；建议只用英文/数字。',
  },
  {
    id: 'sort',
    name: '排序混淆（Sort）',
    summary: '按第一行像素的大小重排列，密钥信息藏在最后一行里，不需要输入密钥。',
    keyKind: 'none',
    defaultKey: '',
    keyHint: '',
  },
  {
    id: 'random',
    name: '随机打乱（Random）',
    summary: '用种子生成随机的列顺序；密钥就是种子，必须和混淆时相同。',
    keyKind: 'seed',
    defaultKey: '114514',
    keyHint: '填整数种子即可（比如 114514）；随便一串文字也能用，但要和混淆时一致。',
  },
]

const ALGORITHM_MAP = new Map<AlgorithmId, AlgorithmInfo>(
  ALGORITHMS.map((item) => [item.id, item]),
)

export function getAlgorithm(id: AlgorithmId): AlgorithmInfo {
  const info = ALGORITHM_MAP.get(id)
  if (!info) throw new Error('不认识的算法：' + id)
  return info
}

// ---------------------------------------------------------------- 对外的总入口

/**
 * 处理一张图片。
 *
 * @param algorithm 算法 id
 * @param mode      encrypt = 混淆，decrypt = 解混淆
 * @param key       密钥（按算法的 keyKind 解释；sort 忽略它）
 * @param source    原图像素（RGBA，Canvas 的 getImageData 那种格式）
 * @returns 处理后的像素；Block 会把宽高补齐到 32 的倍数，所以尺寸可能变大
 */
export function processImage(
  algorithm: AlgorithmId,
  mode: ProcessMode,
  key: string,
  source: ImagePixels,
): ImagePixels {
  const info = getAlgorithm(algorithm)
  const { width, height } = source
  if (!width || !height) throw new Error('图片尺寸无效')
  if (width * height > MAX_PIXELS) {
    throw new Error('图片太大，最多支持约 ' + MAX_PIXELS / 1_000_000 + ' 百万像素')
  }

  const pixels = rgbaToArgb(source.rgba, width * height)

  switch (algorithm) {
    case 'picencrypt-row-column':
      assertPixelCount(pixels, width, height)
      return toResult(
        picEncryptRowColumn(pixels, width, height, numberKey(info, key), mode),
        width,
        height,
      )
    case 'picencrypt-row':
      assertPixelCount(pixels, width, height)
      return toResult(picEncryptRow(pixels, width, height, numberKey(info, key), mode), width, height)
    case 'tomato':
      assertPixelCount(pixels, width, height)
      return toResult(tomato(pixels, width, height, numberKey(info, key), mode), width, height)
    case 'block': {
      const out = block(pixels, width, height, key, mode)
      return toResult(out.pixels, out.width, out.height)
    }
    case 'row-pixel':
      assertPixelCount(pixels, width, height)
      return toResult(rowPixel(pixels, width, height, key, mode), width, height)
    case 'per-pixel':
      assertPixelCount(pixels, width, height)
      return toResult(perPixel(pixels, width, height, key, mode), width, height)
    case 'sort':
      return toResult(columnScramble(pixels, width, height, mode, () => sortOrder(pixels, width)), width, height)
    case 'random':
      return toResult(
        columnScramble(pixels, width, height, mode, () =>
          javaShuffle(width, parseSeed(key)),
        ),
        width,
        height,
      )
  }
}

// ---------------------------------------------------------------- 结果与密钥

function toResult(pixels: Int32Array, width: number, height: number): ImagePixels {
  return { rgba: argbToRgba(pixels), width, height }
}

function assertPixelCount(pixels: Int32Array, width: number, height: number): void {
  if (pixels.length !== width * height) throw new Error('图片像素数据不完整')
}

/** 把密钥字符串按 Java Double.parseDouble 的语义转成数字。 */
function numberKey(info: AlgorithmInfo, key: string): number {
  const text = key.trim()
  const value = Number(text)
  if (text === '' || !Number.isFinite(value)) {
    throw new Error('「' + info.name + '」的密钥必须是数字，比如 0.618')
  }
  return value
}

// ---------------------------------------------------------------- 像素格式转换

/** RGBA 字节（Canvas）→ ARGB int（Java BufferedImage.getRGB 的格式）。 */
function rgbaToArgb(rgba: Uint8ClampedArray, pixelCount: number): Int32Array {
  const argb = new Int32Array(pixelCount)
  for (let i = 0; i < pixelCount; i++) {
    const offset = i * 4
    // 用 |0 保留 Java int 的符号（A=255 时整体是负数），后面排序要按有符号比较
    argb[i] =
      ((rgba[offset + 3] << 24) |
        (rgba[offset] << 16) |
        (rgba[offset + 1] << 8) |
        rgba[offset + 2]) |
      0
  }
  return argb
}

/** ARGB int → RGBA 字节。 */
function argbToRgba(argb: Int32Array): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(argb.length * 4)
  for (let i = 0; i < argb.length; i++) {
    const value = argb[i]
    const offset = i * 4
    rgba[offset] = (value >>> 16) & 0xff
    rgba[offset + 1] = (value >>> 8) & 0xff
    rgba[offset + 2] = value & 0xff
    rgba[offset + 3] = (value >>> 24) & 0xff
  }
  return rgba
}

// ---------------------------------------------------------------- Java 兼容小工具

/** Java 的 Math.round(double)：floor(x + 0.5)（注意取整方向：-0.5 → 0）。 */
function javaRound(value: number): number {
  return Math.floor(value + 0.5)
}

/** Java 的 Math.signum(int)：-1 / 0 / 1。 */
function javaSignum(value: number): number {
  return value > 0 ? 1 : value < 0 ? -1 : 0
}

/** Java 的 String.hashCode()：31 进制，按 UTF-16 码元累加并回绕成 int。 */
function javaStringHashCode(text: string): number {
  let hash = 0
  for (let i = 0; i < text.length; i++) {
    hash = (Math.imul(31, hash) + text.charCodeAt(i)) | 0
  }
  return hash
}

// ---------------------------------------------------------------- MD5（Block / RowPixel / PerPixel 的密钥打乱）

const MD5_SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]

// floor(abs(sin(i + 1)) * 2^32)，RFC 1321 的常量表。写死比运行时算更稳。
const MD5_SINES = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee,
  0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
  0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
  0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
  0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
  0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05,
  0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039,
  0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
  0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
]

const TEXT_ENCODER = new TextEncoder()

function rotateLeft(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) | 0
}

/** 标准 MD5，返回 32 位小写十六进制字符串（和 Java BigInteger.toString(16) 左补零后一致）。 */
function md5Hex(input: string): string {
  const message = TEXT_ENCODER.encode(input)
  const bitLength = message.length * 8
  const paddedLength = Math.ceil((message.length + 9) / 64) * 64
  const buffer = new Uint8Array(paddedLength)
  buffer.set(message)
  buffer[message.length] = 0x80

  const view = new DataView(buffer.buffer)
  view.setUint32(paddedLength - 8, bitLength >>> 0, true)
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 0x1_0000_0000), true)

  let a0 = 0x67452301 | 0
  let b0 = 0xefcdab89 | 0
  let c0 = 0x98badcfe | 0
  let d0 = 0x10325476 | 0

  const words = new Uint32Array(16)

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4, true)

    let a = a0
    let b = b0
    let c = c0
    let d = d0

    for (let i = 0; i < 64; i++) {
      let f: number
      let g: number
      if (i < 16) {
        f = (b & c) | (~b & d)
        g = i
      } else if (i < 32) {
        f = (d & b) | (~d & c)
        g = (5 * i + 1) % 16
      } else if (i < 48) {
        f = b ^ c ^ d
        g = (3 * i + 5) % 16
      } else {
        f = c ^ (b | ~d)
        g = (7 * i) % 16
      }

      const sum = (a + f + MD5_SINES[i] + words[g]) | 0
      a = d
      d = c
      c = b
      b = (b + rotateLeft(sum, MD5_SHIFTS[i])) | 0
    }

    a0 = (a0 + a) | 0
    b0 = (b0 + b) | 0
    c0 = (c0 + c) | 0
    d0 = (d0 + d) | 0
  }

  const out = new Uint8Array(16)
  const outView = new DataView(out.buffer)
  outView.setUint32(0, a0 >>> 0, true)
  outView.setUint32(4, b0 >>> 0, true)
  outView.setUint32(8, c0 >>> 0, true)
  outView.setUint32(12, d0 >>> 0, true)

  let hex = ''
  for (let i = 0; i < out.length; i++) hex += out[i].toString(16).padStart(2, '0')
  return hex
}

/**
 * 用 MD5 生成可复现的洗牌顺序（对应 Java PixelObfuscation.shuffle）。
 * 每一轮用 md5(key + i) 的前 7 个十六进制位取模，和 i 位置交换。
 */
function shuffleByKey(key: string, length: number): Int32Array {
  const order = new Int32Array(length)
  for (let i = 0; i < length; i++) order[i] = i

  for (let i = length - 1; i > 0; i--) {
    const rand = parseInt(md5Hex(key + i).slice(0, 7), 16) % (i + 1)
    const tmp = order[rand]
    order[rand] = order[i]
    order[i] = tmp
  }
  return order
}

// ---------------------------------------------------------------- java.util.Random（Random 算法的种子打乱）

const RANDOM_MULTIPLIER = 0x5deece66dn
const RANDOM_ADDEND = 0xbn
const RANDOM_MASK = (1n << 48n) - 1n

/**
 * 逐位复刻 java.util.Random 的 LCG。
 * 必须用 BigInt：48 位种子乘法会超出 Number 的安全整数范围，用浮点算会错位。
 */
class JavaRandom {
  private seed: bigint

  constructor(seedBits: bigint) {
    // Java 构造时先把种子和魔法数异或（Random(long seed) 的实现）
    this.seed = (BigInt.asUintN(64, seedBits) ^ RANDOM_MULTIPLIER) & RANDOM_MASK
  }

  /** 生成 bits 个高位随机位（1 ≤ bits ≤ 32）。 */
  next(bits: number): number {
    this.seed = (this.seed * RANDOM_MULTIPLIER + RANDOM_ADDEND) & RANDOM_MASK
    return Number(this.seed >> BigInt(48 - bits))
  }

  /** java.util.Random.nextInt(bound)。 */
  nextInt(bound: number): number {
    if (bound <= 0) throw new Error('bound 必须是正数')
    let r = this.next(31)
    const m = bound - 1
    if ((bound & m) === 0) {
      // bound 是 2 的幂：直接按 31 位缩放
      return Number((BigInt(bound) * BigInt(r)) >> 31n)
    }
    let u = r
    for (;;) {
      r = u % bound
      // Java 这里靠 int 溢出判断：u - r + m < 0 时重新抽
      if (((u - r + m) | 0) >= 0) return r
      u = this.next(31)
    }
  }
}

/**
 * 对应 Util.randomEncrypt 的种子解析：先按 Long.parseLong 解析，
 * 解析不了就用 String.hashCode()（原库就是这么兜底的）。
 */
function parseSeed(key: string): bigint {
  if (/^[+-]?\d+$/.test(key)) {
    const value = BigInt(key.replace(/^\+/, ''))
    if (value >= -(1n << 63n) && value <= (1n << 63n) - 1n) return value
  }
  return BigInt(javaStringHashCode(key))
}

/** 复刻 Collections.shuffle(list, random)：从尾到头，每次和 [0, i) 里的随机位置交换。 */
function javaShuffle(length: number, seedBits: bigint): Int32Array {
  const order = new Int32Array(length)
  for (let i = 0; i < length; i++) order[i] = i
  const random = new JavaRandom(seedBits)
  for (let i = length; i > 1; i--) {
    const j = random.nextInt(i)
    const tmp = order[i - 1]
    order[i - 1] = order[j]
    order[j] = tmp
  }
  return order
}

// ---------------------------------------------------------------- PicEncrypt（Logistic 混沌映射）

/**
 * 生成 [0, n) 的置换顺序：以 x1 为初值迭代 Logistic 映射，
 * 按生成值从小到大排序，记下原始下标（对应 PicEncryptObfuscation.generateLogistic + getSortedPositions）。
 *
 * 返回的 last 是第 n 个（最后一个）迭代值 —— 行列混淆会拿它当下一行/列的初值，
 * 所以不能只返回顺序。
 */
function logisticOrder(x1: number, n: number): { order: Int32Array; last: number } {
  const values = new Float64Array(n)
  let x = x1
  values[0] = x
  for (let i = 1; i < n; i++) {
    x = 3.9999999 * x * (1 - x)
    values[i] = x
  }

  // 原实现的比较器是 `a[0] > b[0] ? 1 : -1`；数值互不相等时和普通升序一致。
  const indices: number[] = new Array(n)
  for (let i = 0; i < n; i++) indices[i] = i
  indices.sort((a, b) => (values[a] > values[b] ? 1 : -1))

  return { order: Int32Array.from(indices), last: x }
}

/** PicEncrypt 行：每一行都用同一套列顺序错位。 */
function picEncryptRow(
  source: Int32Array,
  width: number,
  height: number,
  key: number,
  mode: ProcessMode,
): Int32Array {
  const order = logisticOrder(key, width).order
  const result = new Int32Array(width * height)
  const lastRowOffset = (height - 1) * width

  for (let i = 0; i < width; i++) {
    const m = order[i]
    for (let offset = lastRowOffset; offset >= 0; offset -= width) {
      if (mode === 'encrypt') result[i + offset] = source[m + offset]
      else result[m + offset] = source[i + offset]
    }
  }
  return result
}

/** PicEncrypt 行列：先对每一行（初值逐行链式传递）打乱，再对每一列打乱。 */
function picEncryptRowColumn(
  source: Int32Array,
  width: number,
  height: number,
  key: number,
  mode: ProcessMode,
): Int32Array {
  const result = new Int32Array(width * height)

  if (mode === 'encrypt') {
    // 第一步：行
    const temp = source.slice()
    let x = key
    for (let row = 0; row < height; row++) {
      const { order, last } = logisticOrder(x, width)
      x = last
      const offset = row * width
      for (let i = 0; i < width; i++) result[offset + i] = temp[offset + order[i]]
    }

    // 第二步：列（在行结果上继续）
    const afterRows = result.slice()
    x = key
    for (let col = 0; col < width; col++) {
      const { order, last } = logisticOrder(x, height)
      x = last
      for (let row = 0; row < height; row++) {
        result[col + row * width] = afterRows[col + order[row] * width]
      }
    }
    return result
  }

  // 解密顺序与加密相反：先列、再行
  const temp = source.slice()
  let x = key
  for (let col = 0; col < width; col++) {
    const { order, last } = logisticOrder(x, height)
    x = last
    for (let row = 0; row < height; row++) {
      result[col + order[row] * width] = temp[col + row * width]
    }
  }

  const afterCols = result.slice()
  x = key
  for (let row = 0; row < height; row++) {
    const { order, last } = logisticOrder(x, width)
    x = last
    const offset = row * width
    for (let i = 0; i < width; i++) result[offset + order[i]] = afterCols[offset + i]
  }
  return result
}

// ---------------------------------------------------------------- Tomato（希尔伯特曲线 + 整体错位）

/**
 * 按希尔伯特曲线（Gilbert 2D 变体）把二维坐标拉成一维序列，
 * 返回「遍历顺序 → 像素下标」的数组。逐行对照原实现的递归分块。
 */
function gilbertCurve(width: number, height: number): Int32Array {
  const positions = new Int32Array(width * height)
  let pos = 0

  const walk = (x: number, y: number, ax: number, ay: number, bx: number, by: number): void => {
    const w = Math.abs(ax + ay)
    const h = Math.abs(bx + by)
    const dax = javaSignum(ax)
    const day = javaSignum(ay)
    const dbx = javaSignum(bx)
    const dby = javaSignum(by)

    if (h === 1) {
      for (let i = 0; i < w; i++) {
        positions[pos++] = x + y * width
        x += dax
        y += day
      }
      return
    }

    if (w === 1) {
      for (let i = 0; i < h; i++) {
        positions[pos++] = x + y * width
        x += dbx
        y += dby
      }
      return
    }

    // Java 的 Math.floorDiv 对负数是「向下取整」，不能用 JS 的截断除法
    let ax2 = Math.floor(ax / 2)
    let ay2 = Math.floor(ay / 2)
    let bx2 = Math.floor(bx / 2)
    let by2 = Math.floor(by / 2)
    const w2 = Math.abs(ax2 + ay2)
    const h2 = Math.abs(bx2 + by2)

    if (2 * w > 3 * h) {
      if ((w2 & 1) === 1 && w > 2) {
        ax2 += dax
        ay2 += day
      }
      walk(x, y, ax2, ay2, bx, by)
      walk(x + ax2, y + ay2, ax - ax2, ay - ay2, bx, by)
    } else {
      if ((h2 & 1) === 1 && h > 2) {
        bx2 += dbx
        by2 += dby
      }
      walk(x, y, bx2, by2, ax2, ay2)
      walk(x + bx2, y + by2, ax, ay, bx - bx2, by - by2)
      walk(
        x + (ax - dax) + (bx2 - dbx),
        y + (ay - day) + (by2 - dby),
        -bx2,
        -by2,
        -(ax - ax2),
        -(ay - ay2),
      )
    }
  }

  if (width >= height) walk(0, 0, width, 0, 0, height)
  else walk(0, 0, 0, height, width, 0)

  return positions
}

/** Tomato：按曲线顺序整体平移 offset 个像素，offset 由黄金比例和密钥算出。 */
function tomato(
  source: Int32Array,
  width: number,
  height: number,
  key: number,
  mode: ProcessMode,
): Int32Array {
  const pixelCount = width * height
  const rawOffset = ((Math.sqrt(5) - 1) / 2) * pixelCount * key
  const rounded = javaRound(rawOffset)
  if (!Number.isFinite(rounded) || Math.abs(rounded) > Number.MAX_SAFE_INTEGER) {
    throw new Error('Tomato 的密钥数值太大，无法处理')
  }

  const offset = ((rounded % pixelCount) + pixelCount) % pixelCount
  const loopPosition = pixelCount - offset
  const positions = gilbertCurve(width, height)
  const result = new Int32Array(pixelCount)

  if (mode === 'encrypt') {
    for (let i = 0; i < loopPosition; i++) {
      result[positions[i + offset]] = source[positions[i]]
    }
    for (let i = loopPosition; i < pixelCount; i++) {
      result[positions[i - loopPosition]] = source[positions[i]]
    }
  } else {
    for (let i = 0; i < loopPosition; i++) {
      result[positions[i]] = source[positions[i + offset]]
    }
    for (let i = loopPosition; i < pixelCount; i++) {
      result[positions[i]] = source[positions[i - loopPosition]]
    }
  }
  return result
}

// ---------------------------------------------------------------- 像素洗牌类（Block / RowPixel / PerPixel）

/** Block：32×32 方块整体打乱。宽高会补齐到 32 的倍数，所以输出尺寸可能变大。 */
function block(
  source: Int32Array,
  width: number,
  height: number,
  key: string,
  mode: ProcessMode,
): { pixels: Int32Array; width: number; height: number } {
  const blockX = 32
  const blockY = 32
  const xOrder = shuffleByKey(key, blockX)
  const yOrder = shuffleByKey(key, blockY)

  const newWidth = width % blockX > 0 ? width + blockX - (width % blockX) : width
  const newHeight = height % blockY > 0 ? height + blockY - (height % blockY) : height
  const blockWidth = newWidth / blockX
  const blockHeight = newHeight / blockY
  const result = new Int32Array(newWidth * newHeight)

  for (let i = 0; i < newWidth; i++) {
    for (let j = 0; j < newHeight; j++) {
      let n = j
      let m = (xOrder[Math.floor(n / blockHeight) % blockX] * blockWidth + i) % newWidth
      m = xOrder[Math.floor(m / blockWidth)] * blockWidth + (m % blockWidth)
      n = (yOrder[Math.floor(m / blockWidth) % blockY] * blockHeight + n) % newHeight
      n = yOrder[Math.floor(n / blockHeight)] * blockHeight + (n % blockHeight)

      if (mode === 'encrypt') {
        result[i + j * newWidth] = source[(m % width) + (n % height) * width]
      } else {
        result[m + n * newWidth] = source[(i % width) + (j % height) * width]
      }
    }
  }

  return { pixels: result, width: newWidth, height: newHeight }
}

/** RowPixel：每一行内部按密钥洗牌，行与行之间不动。 */
function rowPixel(
  source: Int32Array,
  width: number,
  height: number,
  key: string,
  mode: ProcessMode,
): Int32Array {
  const xOrder = shuffleByKey(key, width)
  const result = new Int32Array(width * height)

  for (let i = 0; i < width; i++) {
    for (let j = 0; j < height; j++) {
      const m = xOrder[(xOrder[j % width] + i) % width]
      if (mode === 'encrypt') result[i + j * width] = source[m + j * width]
      else result[m + j * width] = source[i + j * width]
    }
  }
  return result
}

/** PerPixel：横竖两套置换叠加，像素被彻底打散。 */
function perPixel(
  source: Int32Array,
  width: number,
  height: number,
  key: string,
  mode: ProcessMode,
): Int32Array {
  const xOrder = shuffleByKey(key, width)
  const yOrder = shuffleByKey(key, height)
  const result = new Int32Array(width * height)

  for (let i = 0; i < width; i++) {
    for (let j = 0; j < height; j++) {
      const m = xOrder[(xOrder[j % width] + i) % width]
      const n = yOrder[(yOrder[m % height] + j) % height]
      if (mode === 'encrypt') result[i + j * width] = source[m + n * width]
      else result[m + n * width] = source[i + j * width]
    }
  }
  return result
}

// ---------------------------------------------------------------- Sort / Random（按列重排，密钥藏在最后一行）

/**
 * Sort / Random 共用的「按列重排」。
 *
 * 加密时用第一行像素的排序（Sort）或种子洗牌（Random）决定列顺序，
 * 并把这个映射编码进最后一行；解密时直接从最后一行读回来。
 * 编码方式：高 16 位放原列号，低 16 位放该像素压缩成 RGB565 的值 ——
 * 所以最后一行会有轻微画质损失，这是原算法的设计。
 */
function columnScramble(
  source: Int32Array,
  width: number,
  height: number,
  mode: ProcessMode,
  encryptOrder: () => Int32Array,
): Int32Array {
  const pixels = source.slice()
  const lastRowStart = (height - 1) * width

  if (mode === 'encrypt') {
    if (height < 2) throw new Error('该算法要求图片高度至少 2 行')

    const order = encryptOrder()

    // 第一步：除最后一行外，按 order 重排每一列
    const temp = pixels.slice()
    for (let newX = 0; newX < width; newX++) {
      const originalX = order[newX]
      for (let y = 0; y < height - 1; y++) {
        pixels[y * width + newX] = temp[y * width + originalX]
      }
    }

    // 第二步：最后一行写入「原列号 + 压缩后的原像素」
    // 读和写都是同一列，先读后写，原地操作不会互相干扰。
    for (let newX = 0; newX < width; newX++) {
      const originalX = order[newX]
      const originalPixel = pixels[lastRowStart + newX]
      const r = (originalPixel >> 16) & 0xff
      const g = (originalPixel >> 8) & 0xff
      const b = originalPixel & 0xff
      const rgb565 = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)
      pixels[lastRowStart + newX] = ((originalX & 0xffff) << 16) | (rgb565 & 0xffff)
    }
    return pixels
  }

  // 解密：先从最后一行读列映射，再按映射把每一列送回原位置
  const mapping = new Int32Array(width)
  for (let x = 0; x < width; x++) {
    mapping[x] = (pixels[lastRowStart + x] >> 16) & 0xffff
    // 合法映射一定是 0..width-1。越界说明这张图不是用该算法混淆的（或者被重新压缩/裁剪过），
    // 直接报错比默默画出一张噪点图更有用 —— Java 原库在这里会抛数组越界。
    if (mapping[x] >= width) {
      throw new Error(
        '最后一行里没有有效的列映射：这张图可能不是用「排序混淆 / 随机打乱」加密的，' +
          '或者经过 JPEG 重压缩、裁剪后信息已经损坏',
      )
    }
  }

  const temp = pixels.slice()
  for (let currentX = 0; currentX < width; currentX++) {
    const originalX = mapping[currentX]
    for (let y = 0; y < height; y++) {
      const currentIndex = y * width + currentX
      const originalIndex = y * width + originalX
      if (y === height - 1) {
        // 最后一行还原 RGB565（有损）
        const rgb565 = temp[currentIndex] & 0xffff
        const r = ((rgb565 >> 11) & 0x1f) << 3
        const g = ((rgb565 >> 5) & 0x3f) << 2
        const b = (rgb565 & 0x1f) << 3
        pixels[originalIndex] = (0xff000000 | (r << 16) | (g << 8) | b) | 0
      } else {
        pixels[originalIndex] = temp[currentIndex]
      }
    }
  }
  return pixels
}

/** 第一行像素按有符号 ARGB 从小到大排序（Java Integer.compare），得到列顺序。 */
function sortOrder(pixels: Int32Array, width: number): Int32Array {
  const indices: number[] = new Array(width)
  for (let i = 0; i < width; i++) indices[i] = i
  indices.sort((a, b) => pixels[a] - pixels[b])
  return Int32Array.from(indices)
}

/**
 * 只给 Node 单测用的内部出口。
 *
 * 页面里只会用到 processImage；这里导出 MD5 和 Java 随机数，
 * 是为了在 Node 里直接拿 node:crypto / Java 已知随机序列来「对拍」，
 * 确认移植没有走样（这两个东西一旦错了，混淆结果就和原库对不上）。
 */
export const __testing = {
  md5Hex,
  javaShuffle,
  javaStringHashCode,
  parseSeed,
  JavaRandom,
  gilbertCurve,
  logisticOrder,
}
