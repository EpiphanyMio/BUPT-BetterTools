// 「图片解混淆」模块。
//
// 数据流很简单：
//   选图片 → 浏览器把图片画到 Canvas → 取出 RGBA 像素 → 引擎在本地做置换 → 画回 Canvas 导出 PNG
// 全程没有 fetch、没有上传，所以断网也能用，图片也不会离开这台电脑。
//
// 真正的算法在 src/lib/imageObfuscation.ts（从 Java 库 ObfuscationUtils 移植），
// 这个文件只负责界面和流程。

import { useEffect, useRef, useState } from 'react'
import {
  ALGORITHMS,
  MAX_PIXELS,
  getAlgorithm,
  processImage,
  type AlgorithmId,
  type ImagePixels,
  type ProcessMode,
} from '../lib/imageObfuscation'
import { decodePng, encodePng } from '../lib/pngCodec'

interface ImageDeobfuscateModuleProps {
  onBack: () => void
  /** 打开「全局搜索」浮层 */
  onSearch: () => void
}

/** 已经读进内存的图片。pixels 是 Canvas 的 RGBA 字节。 */
interface LoadedImage {
  name: string
  /** 给 <img> 预览用的 object URL */
  previewUrl: string
  pixels: ImagePixels
}

/** 处理完成的结果。url 是导出的 PNG 的 object URL。 */
interface ProcessedImage {
  url: string
  width: number
  height: number
  mode: ProcessMode
  algorithmName: string
  key: string
  elapsedMs: number
}

export default function ImageDeobfuscateModule({
  onBack,
  onSearch,
}: ImageDeobfuscateModuleProps) {
  // 默认停在最常用的「行列混淆 + 解混淆」，进来就能直接选图处理。
  const [algorithm, setAlgorithm] = useState<AlgorithmId>('picencrypt-row-column')
  const [mode, setMode] = useState<ProcessMode>('decrypt')
  const [key, setKey] = useState(getAlgorithm('picencrypt-row-column').defaultKey)

  const [loaded, setLoaded] = useState<LoadedImage | null>(null)
  const [result, setResult] = useState<ProcessedImage | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)

  // object URL 是浏览器分配的临时地址，不用了必须手动释放，否则图片数据会一直占着内存。
  // 用 ref 记当前地址，是因为清理函数（组件卸载 effect）拿不到最新的 state。
  const loadedUrlRef = useRef('')
  const resultUrlRef = useRef('')

  useEffect(() => {
    return () => {
      if (loadedUrlRef.current) URL.revokeObjectURL(loadedUrlRef.current)
      if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current)
    }
  }, [])

  const info = getAlgorithm(algorithm)

  // ---- 读图片 ----
  async function loadFile(file: File) {
    setError('')
    if (file.type && !file.type.startsWith('image/')) {
      setError('请选择图片文件（PNG / JPG / WebP / GIF）')
      return
    }

    setBusy(true)
    try {
      const image = await readImagePixels(file)
      const pixelCount = image.width * image.height
      if (pixelCount > MAX_PIXELS) {
        throw new Error(
          '图片太大（' +
            image.width +
            '×' +
            image.height +
            '），最多支持约 ' +
            Math.round(MAX_PIXELS / 1_000_000) +
            ' 百万像素',
        )
      }

      // 换图时把上一张的临时地址放掉
      if (loadedUrlRef.current) URL.revokeObjectURL(loadedUrlRef.current)
      const previewUrl = URL.createObjectURL(file)
      loadedUrlRef.current = previewUrl

      // 结果对应的是上一张图，换图后继续留着只会让人误会
      if (resultUrlRef.current) {
        URL.revokeObjectURL(resultUrlRef.current)
        resultUrlRef.current = ''
      }
      setResult(null)

      setLoaded({
        name: file.name || '图片',
        previewUrl,
        pixels: { rgba: image.rgba, width: image.width, height: image.height },
      })
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '读取图片失败，换个文件试试')
    } finally {
      setBusy(false)
    }
  }

  // ---- 开始处理 ----
  async function handleProcess() {
    if (!loaded) {
      setError('请先选择一张图片')
      return
    }

    setBusy(true)
    setError('')
    try {
      // 先让浏览器把「处理中…」画出来，再做同步计算。
      // 不然大图的循环会卡住主线程，用户看到的是按钮没反应。
      await new Promise((resolve) => setTimeout(resolve, 30))
      const startedAt = performance.now()
      const output = processImage(algorithm, mode, key, loaded.pixels)
      const elapsedMs = performance.now() - startedAt

      const blob = await exportPng(output)
      if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current)
      const url = URL.createObjectURL(blob)
      resultUrlRef.current = url

      setResult({
        url,
        width: output.width,
        height: output.height,
        mode,
        algorithmName: info.name,
        key,
        elapsedMs,
      })
    } catch (processError) {
      setResult(null)
      setError(processError instanceof Error ? processError.message : '处理失败')
    } finally {
      setBusy(false)
    }
  }

  // ---- 下载结果 ----
  function handleDownload() {
    if (!result) return
    const baseName = loaded ? loaded.name.replace(/\.[^.]+$/, '') : 'image'
    const suffix = result.mode === 'decrypt' ? '已解混淆' : '已混淆'
    const link = document.createElement('a')
    link.href = result.url
    link.download = baseName + '-' + suffix + '.png'
    link.click()
  }

  // ---- 清空 ----
  function handleReset() {
    if (loadedUrlRef.current) URL.revokeObjectURL(loadedUrlRef.current)
    if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current)
    loadedUrlRef.current = ''
    resultUrlRef.current = ''
    setLoaded(null)
    setResult(null)
    setError('')
  }

  const canProcess = loaded !== null && !busy

  return (
    <div className="min-h-screen bg-surface-2 text-fg">
      <div className="mx-auto max-w-5xl px-4 py-8">
        <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="min-w-0">
            <h1 className="text-3xl font-bold tracking-tight text-fg">🖼️ 图片解混淆</h1>
            <p className="mt-1 text-sm text-fg-subtle">
              还原被混淆的图片：选图片 → 选算法 → 填密钥。全部在浏览器本地计算，图片不会上传。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
            <button type="button" onClick={onBack} className="btn btn-neutral">
              ← 返回首页
            </button>
            <button
              type="button"
              onClick={onSearch}
              title="搜索工具和文件（Ctrl+K）"
              aria-label="搜索工具和文件"
              className="btn btn-neutral w-10 px-0 leading-none"
            >
              🔍
            </button>
          </div>
        </header>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)] lg:items-start">
          {/* ---------------- 左：上传 + 参数 ---------------- */}
          <section className="card p-5">
            <div
              onDragOver={(event) => {
                event.preventDefault()
                setDragging(true)
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault()
                setDragging(false)
                const file = event.dataTransfer.files[0]
                if (file) void loadFile(file)
              }}
              className={
                'flex flex-col items-center justify-center rounded-card border border-dashed px-4 py-7 text-center transition ' +
                (dragging ? 'border-primary bg-primary-soft' : 'border-line bg-surface-2')
              }
            >
              <span className="text-3xl" aria-hidden="true">
                🖼️
              </span>
              <p className="mt-2 max-w-full truncate text-sm text-fg" title={loaded?.name}>
                {loaded ? '已选择：' + loaded.name : '把图片拖到这里'}
              </p>
              <p className="mt-1 text-xs text-fg-subtle">
                {loaded
                  ? loaded.pixels.width + ' × ' + loaded.pixels.height + ' 像素'
                  : '或点下面的按钮选择文件（PNG / JPG / WebP / GIF）'}
              </p>

              <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="btn btn-outline"
                  disabled={busy}
                >
                  {loaded ? '更换图片' : '选择图片'}
                </button>
                {loaded && (
                  <button type="button" onClick={handleReset} className="btn btn-text" disabled={busy}>
                    清空
                  </button>
                )}
              </div>

              {/* 真正的文件选择框藏起来，用上面的按钮替它露头（原生控件太难看得统一） */}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  // 清掉 value，否则选同一个文件第二次不会触发 change
                  event.target.value = ''
                  if (file) void loadFile(file)
                }}
              />
            </div>

            <label className="mt-5 block">
              <span className="block text-sm font-medium text-fg-muted">算法</span>
              <select
                value={algorithm}
                onChange={(event) => {
                  const next = event.target.value as AlgorithmId
                  setAlgorithm(next)
                  // 换算法时把密钥重置成该算法的默认值：
                  // 数字算法的框里留着上次的文本密钥，点处理只会得到一句报错。
                  setKey(getAlgorithm(next).defaultKey)
                  setError('')
                }}
                className="field field-boxed mt-2"
              >
                {ALGORITHMS.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-xs leading-relaxed text-fg-subtle">
                {info.summary}
              </span>
            </label>

            <div className="mt-4">
              <span className="block text-sm font-medium text-fg-muted">方向</span>
              <div className="mt-2 inline-flex w-full rounded-btn border border-line bg-surface p-1 text-sm">
                <button
                  type="button"
                  onClick={() => setMode('decrypt')}
                  className={
                    'flex-1 rounded-btn px-3 py-1.5 transition ' +
                    (mode === 'decrypt'
                      ? 'bg-primary-soft font-medium text-primary'
                      : 'text-fg-subtle hover:bg-surface-3')
                  }
                >
                  解混淆
                </button>
                <button
                  type="button"
                  onClick={() => setMode('encrypt')}
                  className={
                    'flex-1 rounded-btn px-3 py-1.5 transition ' +
                    (mode === 'encrypt'
                      ? 'bg-primary-soft font-medium text-primary'
                      : 'text-fg-subtle hover:bg-surface-3')
                  }
                >
                  混淆
                </button>
              </div>
            </div>

            {info.keyKind === 'none' ? (
              <p className="mt-4 text-xs leading-relaxed text-fg-subtle">
                这个算法不需要密钥，列顺序信息直接藏在图片最后一行里。
              </p>
            ) : (
              <label className="mt-4 block">
                <span className="block text-sm font-medium text-fg-muted">密钥</span>
                <input
                  type="text"
                  value={key}
                  onChange={(event) => {
                    setKey(event.target.value)
                    setError('')
                  }}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={info.keyKind === 'number' ? '例如 0.618' : '例如 114514'}
                  className="field field-boxed mt-2 font-mono"
                />
                <span className="mt-1 block text-xs leading-relaxed text-fg-subtle">
                  {info.keyHint}
                </span>
              </label>
            )}

            <button
              type="button"
              onClick={() => void handleProcess()}
              disabled={!canProcess}
              className="btn btn-primary mt-5 w-full"
            >
              {busy ? '处理中…' : mode === 'decrypt' ? '开始解混淆' : '开始混淆'}
            </button>

            {error && (
              <p
                role="alert"
                className="mt-3 rounded-btn bg-danger-bg px-3 py-2 text-xs leading-relaxed text-danger"
              >
                {error}
              </p>
            )}

            <p className="mt-4 text-xs leading-relaxed text-fg-subtle">
              提示：图片必须和混淆时<strong>尺寸完全一致</strong>，密钥也必须一致；
              经过 JPEG 重新压缩或裁剪过的图，像素已经变了，通常无法还原。
            </p>
          </section>

          {/* ---------------- 右：原图 / 结果 ---------------- */}
          <section className="grid gap-4 sm:grid-cols-2">
            <figure className="card flex min-h-[260px] flex-col p-4">
              <figcaption className="mb-2 flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium text-fg">原图</span>
                {loaded && (
                  <span className="text-xs text-fg-subtle">
                    {loaded.pixels.width} × {loaded.pixels.height}
                  </span>
                )}
              </figcaption>
              {loaded ? (
                <img
                  src={loaded.previewUrl}
                  alt="原图预览"
                  className="max-h-[50vh] w-full flex-1 rounded-btn bg-surface-2 object-contain"
                />
              ) : (
                <EmptyPreview text="还没有选择图片" />
              )}
            </figure>

            <figure className="card flex min-h-[260px] flex-col p-4">
              <figcaption className="mb-2 flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium text-fg">结果</span>
                {result && (
                  <span className="text-xs text-fg-subtle">
                    {result.width} × {result.height}
                  </span>
                )}
              </figcaption>

              {result ? (
                <>
                  <img
                    src={result.url}
                    alt="处理结果预览"
                    className="max-h-[50vh] w-full flex-1 rounded-btn bg-surface-2 object-contain"
                  />
                  <p className="mt-2 text-xs leading-relaxed text-fg-subtle">
                    {result.mode === 'decrypt' ? '解混淆' : '混淆'} · {result.algorithmName}
                    {result.key ? ' · 密钥 ' + result.key : ''} · 用时{' '}
                    {result.elapsedMs < 1 ? '<1' : Math.round(result.elapsedMs)} ms
                  </p>
                  <button type="button" onClick={handleDownload} className="btn btn-primary mt-3">
                    ⬇ 下载 PNG
                  </button>
                </>
              ) : (
                <EmptyPreview text={busy ? '正在处理…' : '处理后的图片会显示在这里'} />
              )}
            </figure>
          </section>
        </div>

        <p className="mt-8 text-center text-xs leading-relaxed text-fg-subtle">
          算法移植自开源项目 ObfuscationUtils（MIT License）；所有计算都在你的浏览器里完成。
        </p>
      </div>
    </div>
  )
}

/** 预览卡片里"还没有内容"时的占位块。 */
function EmptyPreview({ text }: { text: string }) {
  return (
    <div className="flex flex-1 items-center justify-center rounded-btn border border-dashed border-line bg-surface-2 px-4 py-16 text-center text-xs text-fg-subtle">
      {text}
    </div>
  )
}

/**
 * 读一张图片的像素。
 *
 * PNG 优先用自己写的解码器：Canvas 会把透明像素的 RGB 预乘成 0，
 * 而 Sort / Random 的「列顺序」恰好藏在最后一行的透明/半透明像素里。
 * 遇到自己解不了的 PNG（16 位、隔行等）再回退 Canvas —— 主流图片不受影响。
 */
async function readImagePixels(file: File): Promise<ImagePixels> {
  const isPng = file.type === 'image/png' || /\.png$/i.test(file.name)
  if (isPng) {
    try {
      return await decodePng(await file.arrayBuffer())
    } catch {
      // 交给下面的 Canvas 兜底
    }
  }

  // createImageBitmap 比 <img> + onload 简洁，也能正确处理 EXIF 方向。
  const bitmap = await createImageBitmap(file)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('浏览器不支持 Canvas，无法处理图片')
    context.drawImage(bitmap, 0, 0)
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height)
    return { rgba: imageData.data, width: canvas.width, height: canvas.height }
  } finally {
    bitmap.close()
  }
}

/**
 * 把结果导出成 PNG Blob。
 *
 * 不透明图用 Canvas 导出（它带的过滤 + 压缩更省体积）；
 * 只要有一个像素不是全不透明，就走自己写的编码器 —— Canvas 的预乘 alpha
 * 会把这些像素的 RGB 改掉，Sort / Random 的密文必须逐位保真才能再解回来。
 */
async function exportPng(image: ImagePixels): Promise<Blob> {
  if (hasTransparentPixels(image.rgba)) return encodePng(image)

  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('浏览器不支持 Canvas，无法导出图片')

  // 这里复制一份：ImageData 构造器要求独立的 Uint8ClampedArray
  const pixels = new Uint8ClampedArray(image.rgba)
  context.putImageData(new ImageData(pixels, image.width, image.height), 0, 0)

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob)
        else reject(new Error('导出 PNG 失败，可能是图片尺寸太大'))
      },
      'image/png',
    )
  })
}

function hasTransparentPixels(rgba: Uint8ClampedArray): boolean {
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) return true
  }
  return false
}
