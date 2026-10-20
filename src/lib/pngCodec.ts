// 极简 PNG 编解码（无第三方依赖）。
//
// 为什么需要自己解 PNG：
//   Sort / Random 两个算法把「列顺序」编码进图片最后一行的像素里（原库的格式），
//   那些像素的 alpha 常常不是 255。浏览器 Canvas 内部是**预乘 alpha**的：
//   把这种图 putImageData / drawImage 之后，透明像素的 RGB 会被乘成 0，
//   最后一行的映射信息就毁了，解出来是一团噪点。
//   所以这两个算法要走「自己解 PNG → 拿到原始 RGBA 字节」的路径，绕开 Canvas。
//
// 支持的 PNG 子集：8 位色深、非隔行；颜色类型 0/2/3/4/6 都能解（含 tRNS）。
// 遇到不支持的（16 位、隔行等）会抛错，调用方回退到 Canvas 解码。

import type { ImagePixels } from './imageObfuscation'

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

// ---------------------------------------------------------------- CRC32（PNG 每个块末尾的校验）

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let value = n
    for (let k = 0; k < 8; k++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[n] = value >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

// ---------------------------------------------------------------- 解压 / 压缩（浏览器自带的 zlib 流）

async function inflateZlib(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([toArrayBuffer(bytes)]).stream().pipeThrough(new DecompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function deflateZlib(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([toArrayBuffer(bytes)]).stream().pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * 复制一份并只保留普通 ArrayBuffer 视图。
 * TS 的 BlobPart 只接受 ArrayBuffer（不接受 SharedArrayBuffer 视图），
 * 而 Uint8Array 的默认泛型是 ArrayBufferLike，所以这里显式收窄。
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length)
  copy.set(bytes)
  return copy.buffer
}

// ---------------------------------------------------------------- 解码

/**
 * 把 PNG 字节解成 RGBA 像素（非预乘、8 位/通道）。
 *
 * @throws 遇到不支持的 PNG（16 位、Adam7 隔行等）时抛错，调用方可以回退 Canvas。
 */
export async function decodePng(bytes: ArrayBuffer | Uint8Array): Promise<ImagePixels> {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (data.length < 8 || !PNG_SIGNATURE.every((value, index) => data[index] === value)) {
    throw new Error('不是 PNG 文件')
  }

  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  let palette: Uint8Array | null = null
  let transparency: Uint8Array | null = null
  const dataChunks: Uint8Array[] = []

  let offset = 8
  while (offset + 8 <= data.length) {
    const length = readUint32(data, offset)
    const type = String.fromCharCode(
      data[offset + 4],
      data[offset + 5],
      data[offset + 6],
      data[offset + 7],
    )
    const start = offset + 8
    const end = start + length
    if (end + 4 > data.length) throw new Error('PNG 数据被截断')
    const body = data.subarray(start, end)
    offset = end + 4 // 跳过 CRC

    if (type === 'IHDR') {
      width = readUint32(body, 0)
      height = readUint32(body, 4)
      bitDepth = body[8]
      colorType = body[9]
      interlace = body[12]
    } else if (type === 'PLTE') {
      palette = body.slice()
    } else if (type === 'tRNS') {
      transparency = body.slice()
    } else if (type === 'IDAT') {
      dataChunks.push(body)
    } else if (type === 'IEND') {
      break
    }
  }

  if (!width || !height) throw new Error('PNG 缺少尺寸信息')
  if (bitDepth !== 8) throw new Error('只支持 8 位色深的 PNG')
  if (interlace !== 0) throw new Error('不支持隔行（Adam7）PNG')
  if (![0, 2, 3, 4, 6].includes(colorType)) throw new Error('不支持的 PNG 颜色类型')
  if (colorType === 3 && !palette) throw new Error('调色板 PNG 缺少 PLTE')

  // 所有 IDAT 拼起来才是一整段 zlib 数据
  const compressed = concatChunks(dataChunks)
  const raw = await inflateZlib(compressed)

  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : 4
  const stride = width * channels
  if (raw.length < height * (stride + 1)) throw new Error('PNG 像素数据不完整')

  // 逐行反过滤（PNG 的五种过滤器）
  const scanlines = new Uint8Array(height * stride)
  let previous = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const current = new Uint8Array(stride)
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? current[x - channels] : 0
      const up = previous[x]
      const upLeft = x >= channels ? previous[x - channels] : 0
      let value = line[x]
      switch (filter) {
        case 0:
          break
        case 1:
          value += left
          break
        case 2:
          value += up
          break
        case 3:
          value += Math.floor((left + up) / 2)
          break
        case 4: {
          const estimate = left + up - upLeft
          const distanceLeft = Math.abs(estimate - left)
          const distanceUp = Math.abs(estimate - up)
          const distanceUpLeft = Math.abs(estimate - upLeft)
          value +=
            distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft
              ? left
              : distanceUp <= distanceUpLeft
                ? up
                : upLeft
          break
        }
        default:
          throw new Error('PNG 过滤器类型不支持：' + filter)
      }
      current[x] = value & 0xff
    }
    scanlines.set(current, y * stride)
    previous = current
  }

  return expandToRgba(scanlines, width, height, colorType, palette, transparency)
}

function expandToRgba(
  samples: Uint8Array,
  width: number,
  height: number,
  colorType: number,
  palette: Uint8Array | null,
  transparency: Uint8Array | null,
): ImagePixels {
  const pixelCount = width * height
  const rgba = new Uint8ClampedArray(pixelCount * 4)

  for (let i = 0; i < pixelCount; i++) {
    const target = i * 4
    if (colorType === 0) {
      const gray = samples[i]
      const transparent =
        transparency !== null &&
        transparency.length >= 2 &&
        (((transparency[0] << 8) | transparency[1]) & 0xff) === gray
      rgba[target] = gray
      rgba[target + 1] = gray
      rgba[target + 2] = gray
      rgba[target + 3] = transparent ? 0 : 255
    } else if (colorType === 2) {
      const r = samples[i * 3]
      const g = samples[i * 3 + 1]
      const b = samples[i * 3 + 2]
      const key =
        transparency !== null && transparency.length >= 6
          ? (((transparency[0] << 8) | transparency[1]) & 0xff) === r &&
            (((transparency[2] << 8) | transparency[3]) & 0xff) === g &&
            (((transparency[4] << 8) | transparency[5]) & 0xff) === b
          : false
      rgba[target] = r
      rgba[target + 1] = g
      rgba[target + 2] = b
      rgba[target + 3] = key ? 0 : 255
    } else if (colorType === 3) {
      const index = samples[i]
      if (!palette || index * 3 + 2 >= palette.length) throw new Error('PNG 调色板索引越界')
      rgba[target] = palette[index * 3]
      rgba[target + 1] = palette[index * 3 + 1]
      rgba[target + 2] = palette[index * 3 + 2]
      rgba[target + 3] = transparency && index < transparency.length ? transparency[index] : 255
    } else if (colorType === 4) {
      const gray = samples[i * 2]
      rgba[target] = gray
      rgba[target + 1] = gray
      rgba[target + 2] = gray
      rgba[target + 3] = samples[i * 2 + 1]
    } else {
      rgba[target] = samples[i * 4]
      rgba[target + 1] = samples[i * 4 + 1]
      rgba[target + 2] = samples[i * 4 + 2]
      rgba[target + 3] = samples[i * 4 + 3]
    }
  }

  return { rgba, width, height }
}

// ---------------------------------------------------------------- 编码

/**
 * 把 RGBA 像素编码成 PNG（8 位 RGBA，非预乘）。
 * 只用「不过滤 + zlib 压缩」，文件会比 Canvas 导出的略大，但像素值完全保真。
 */
export async function encodePng(image: ImagePixels): Promise<Blob> {
  const { width, height, rgba } = image
  const stride = width * 4
  const raw = new Uint8Array(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // 过滤器类型 0（None）
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }
  const compressed = await deflateZlib(raw)

  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type：RGBA
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  const parts = [
    PNG_SIGNATURE,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', new Uint8Array(0)),
  ]
  return new Blob(parts as BlobPart[], { type: 'image/png' })
}

// ---------------------------------------------------------------- 小工具

function makeChunk(type: string, body: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + body.length)
  const view = new DataView(chunk.buffer)
  view.setUint32(0, body.length)
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i)
  chunk.set(body, 8)
  view.setUint32(8 + body.length, crc32(chunk.subarray(4, 8 + body.length)))
  return chunk
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  )
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const chunk of chunks) total += chunk.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}
