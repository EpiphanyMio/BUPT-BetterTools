// 无头浏览器验证工具 —— 写一次，以后每个功能直接 import，不用再抄 CDP 样板。
//
// 为什么要有这个文件：之前每验证一个功能，都要重写一遍
// 「启动 Chrome → 连调试端口 → 发 CDP 命令 → 轮询判断」这五六十行，
// 同一个对话里重写了八九遍，纯浪费。
//
// 典型用法（一个测试文件只要十几行）：
//
//   import { openBrowser, createChecks } from './browser-verify.mjs'
//
//   const page = await openBrowser({ url: 'http://localhost:5173/' })
//   const t = createChecks()
//
//   await page.waitText('登录')
//   t.ok('登录页能打开', await page.has('保存后同步到云端'))
//   await page.clickText('访客预览')
//   await page.waitText('访客预览模式')
//   t.ok('访客横幅出现', await page.has('只能查看，不能修改'))
//
//   t.report()          // 打印 PASS/FAIL，有失败时 process.exitCode = 1
//   await page.close()
//
// 跑线上站点要加代理（本机 DNS 对 workers.dev 有污染，直连必超时）：
//   const page = await openBrowser({ url: SITE, proxy: 'http://127.0.0.1:7897' })
//
// 【沙箱注意】Chrome 必须用 stdio: 'ignore' 启动。受限沙箱禁止管道，
// 用默认的 pipe 会直接 spawn EPERM —— 这个文件里已经处理好了。
//
// 【写法约定】本文件刻意不用模板字符串（反引号），
// 拼页面脚本一律用字符串相加 —— 免得外面的脚本再套一层引号就崩。

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean)

export function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error('找不到 Chrome，请用环境变量 CHROME_PATH 指定 chrome.exe 的路径')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 启动一个无头 Chrome 并连上调试端口，返回一个 page 对象。 */
export async function openBrowser(options = {}) {
  const {
    url = 'about:blank',
    port = 9400,
    proxy = '',
    width = 1280,
    height = 960,
    timeoutMs = 20000,
  } = options

  const chrome = findChrome()
  // 每次用全新的临时用户目录：保证 localStorage / IndexedDB 是干净的，
  // 不会被上一次测试的数据污染。这是「模拟一台新设备」的关键。
  const profile = mkdtempSync(path.join(tmpdir(), 'bverify-'))
  const args = [
    '--headless=new',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-gpu',
    '--disable-features=Translate',
    '--window-size=' + width + ',' + height,
  ]
  if (proxy) args.push('--proxy-server=' + proxy)
  args.push(url)

  // stdio: 'ignore' —— 见文件头的沙箱说明，改成 pipe 会 spawn EPERM
  const child = spawn(chrome, args, { stdio: 'ignore' })

  // 轮询 /json/list 直到调试端口可用
  let wsUrl = ''
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/json/list')
      const list = await response.json()
      const target = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (target) {
        wsUrl = target.webSocketDebuggerUrl
        break
      }
    } catch {
      // 端口还没起来，继续等
    }
    await sleep(200)
  }
  if (!wsUrl) {
    child.kill()
    rmSync(profile, { recursive: true, force: true })
    throw new Error('浏览器调试端口没起来（' + port + '），看是不是端口被占用了')
  }

  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error('连不上浏览器的 WebSocket'))
  })

  let nextId = 0
  const pending = new Map()
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    }
  }
  function send(method, params = {}) {
    const id = ++nextId
    ws.send(JSON.stringify({ id: id, method: method, params: params }))
    return new Promise((resolve) => pending.set(id, resolve))
  }

  await send('Runtime.enable')
  await send('Page.enable')

  /** 在页面里执行一段 JS。页面抛错时会在这里抛出，方便定位。 */
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', {
      expression: expression,
      awaitPromise: true,
      returnByValue: true,
    })
    const details = result.result && result.result.exceptionDetails
    if (details) {
      const detail = (details.exception && details.exception.description) || details.text
      throw new Error('页面里执行出错: ' + detail)
    }
    return result.result && result.result.result ? result.result.result.value : undefined
  }

  /** 当前页面的可见文字（默认整页）。判断有没有某个内容，用它最省事。 */
  async function text(selector = 'body') {
    // 注意这里的三重兜底：页面还没加载出 DOM 时 document.body 是 null，
    // 直接取 .innerText 会抛 TypeError。轮询等待期间完全可能撞上这个瞬间，
    // 所以拿不到就返回空串 —— 让 waitText 继续等，而不是把测试炸掉。
    const expression =
      "(() => {" +
      "const el = document.querySelector(" + JSON.stringify(selector) + ") || document.body;" +
      "return el ? el.innerText : \"\"" +
      "})()"
    return String(await evaluate(expression))
  }

  /** 立刻判断页面文字里有没有某段话（不做等待）。 */
  async function has(needle) {
    return (await text()).includes(needle)
  }

  /** 等页面文字里出现某段话，超时抛错。比 sleep 固定时间可靠。 */
  async function waitText(needle, waitOptions = {}) {
    const limit = waitOptions.timeoutMs || 15000
    const intervalMs = waitOptions.intervalMs || 250
    const stopAt = Date.now() + limit
    while (Date.now() < stopAt) {
      if (await has(needle)) return true
      await sleep(intervalMs)
    }
    throw new Error('等了 ' + limit + 'ms 也没看到文字：' + needle)
  }

  /** 点击第一个文字里包含 needle 的 button（找不到返回 false）。 */
  async function clickText(needle) {
    const expression =
      "(() => {" +
      "const button = [...document.querySelectorAll('button')]" +
      ".find((item) => item.textContent.includes(" + JSON.stringify(needle) + "));" +
      "if (!button) return false; button.click(); return true" +
      "})()"
    return evaluate(expression)
  }

  /** 点击 aria-label 完全等于 label 的 button。 */
  async function clickAria(label) {
    const expression =
      "(() => {" +
      "const button = [...document.querySelectorAll('button')]" +
      ".find((item) => item.getAttribute('aria-label') === " + JSON.stringify(label) + ");" +
      "if (!button) return false; button.click(); return true" +
      "})()"
    return evaluate(expression)
  }

  /** 给第 index 个 input 填值（React 受控组件必须走原生 setter + input 事件）。 */
  async function fillInput(index, value) {
    const expression =
      "(() => {" +
      "const input = [...document.querySelectorAll('input')][" + index + "];" +
      "if (!input) return false;" +
      "const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;" +
      "setter.call(input, " + JSON.stringify(value) + ");" +
      "input.dispatchEvent(new Event('input', { bubbles: true })); return true" +
      "})()"
    return evaluate(expression)
  }

  /** 按 placeholder 包含的文字找 input 并填值。 */
  async function fillByPlaceholder(placeholder, value) {
    const expression =
      "(() => {" +
      "const input = [...document.querySelectorAll('input')]" +
      ".find((item) => (item.placeholder || '').includes(" + JSON.stringify(placeholder) + "));" +
      "if (!input) return false;" +
      "const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;" +
      "setter.call(input, " + JSON.stringify(value) + ");" +
      "input.dispatchEvent(new Event('input', { bubbles: true })); return true" +
      "})()"
    return evaluate(expression)
  }

  /** 读 localStorage 里某个键的**原始字符串**（不存在返回 null）。
   *  标记类（值为 "1"）用它 —— 走 storage() 会被 JSON.parse 成数字 1。
   */
  async function storageRaw(key) {
    const value = await evaluate('localStorage.getItem(' + JSON.stringify(key) + ')')
    return value === undefined ? null : value
  }

  /** 读 localStorage 里的某个键并 JSON.parse（不存在返回 null）。 */
  async function storage(key) {
    const raw = await storageRaw(key)
    if (raw === null) return null
    try { return JSON.parse(raw) } catch { return raw }
  }

  async function reload() {
    await evaluate('location.reload()')
    await sleep(1500)
  }

  async function goto(target) {
    await send('Page.navigate', { url: target })
    await sleep(1500)
  }

  /** 模拟手机尺寸（响应式验证用）。 */
  async function setViewport(w, h, mobile = false) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: w,
      height: h,
      deviceScaleFactor: mobile ? 2 : 1,
      mobile: mobile,
    })
  }

  /** 截图存盘（给人看的证据）。 */
  async function screenshot(filePath) {
    const result = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(filePath, Buffer.from(result.result.data, 'base64'))
    return filePath
  }

  async function close() {
    try { ws.close() } catch {}
    try { child.kill() } catch {}
    await sleep(300)
    try { rmSync(profile, { recursive: true, force: true }) } catch {}
  }

  return {
    evaluate: evaluate,
    text: text,
    has: has,
    waitText: waitText,
    clickText: clickText,
    clickAria: clickAria,
    fillInput: fillInput,
    fillByPlaceholder: fillByPlaceholder,
    storage: storage,
    storageRaw: storageRaw,
    reload: reload,
    goto: goto,
    setViewport: setViewport,
    screenshot: screenshot,
    close: close,
    send: send,
  }
}

/**
 * 断言收集器。
 *
 *   const t = createChecks()
 *   t.ok('横幅出现了', await page.has('访客预览模式'))
 *   t.report()   // 打印结果；有失败时把 process.exitCode 设为 1
 */
export function createChecks(title) {
  const lines = []
  let pass = 0
  let fail = 0
  return {
    ok: function (name, condition, detail) {
      const extra = detail ? '   [' + detail + ']' : ''
      if (condition) {
        pass += 1
        lines.push('  PASS  ' + name + extra)
      } else {
        fail += 1
        lines.push('  FAIL  ' + name + extra)
      }
    },
    report: function () {
      if (title) console.log('\n=== ' + title + ' ===')
      console.log(lines.join('\n'))
      console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败')
      if (fail > 0) process.exitCode = 1
      return fail === 0
    },
  }
}