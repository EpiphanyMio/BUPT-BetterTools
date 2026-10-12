<#
  我的工具箱 —— 桌面快捷方式启动器

  作用：确认本地网页服务在运行，然后打开浏览器。

  为什么需要它：
  「我的工具箱」是由 Vite 开发服务器在本机临时提供的网页，它不开机自启、
  也不注册成系统服务。所以如果只做一个网址快捷方式，在服务没启动时
  双击会看到「无法访问此网站」。这个脚本先探测服务，没启动就替你把
  服务拉起来，等它就绪后再打开浏览器。

  参数：
    -NoBrowser   只启动服务、不开浏览器（用于自检）
#>

param(
    [switch]$NoBrowser
)

# ── 配置 ──────────────────────────────────────────────────────────
$ProjectDir = 'D:\Users\ROG\Desktop\Workflow\BetterTools'
$NodeExe    = 'C:\Users\ROG\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$PnpmScript = 'C:\Users\ROG\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs'
$Port       = 5173
$Url        = "http://localhost:$Port/"

# 判断网页服务是不是已经跑起来了。
#
# 这里有两个坑，都是实测踩出来的：
#   1. 不能用 New-Object System.Net.Sockets.TcpClient 再去 Connect('::1')。
#      无参构造出来的是 IPv4 套接字，拿去连 IPv6 地址会直接报
#      "socket is not connected"。而 Vite 默认恰好只监听 IPv6 的 ::1，
#      于是「服务明明在跑」会被误判成「没跑」，进而重复启动一个服务。
#   2. 所以改成发一个真正的 HTTP 请求 —— 能拿到 200，才说明网页确实可用。
#      再用 netstat 兜底，覆盖「端口已监听但还没开始响应」的瞬间。
function Test-ToolboxServer {
    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
        if ($response.StatusCode -eq 200) { return $true }
    } catch { }

    $listening = netstat -ano | Select-String -Pattern (':' + $Port + '\s.*LISTENING')
    if ($listening) { return $true }

    return $false
}

# 出错时弹个窗。脚本是隐藏运行的，不弹窗用户什么都看不到。
function Show-Tip([string]$message) {
    try {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show($message, '我的工具箱', 'OK', 'Warning') | Out-Null
    } catch {
        Write-Host $message
    }
}

# ── 主流程 ────────────────────────────────────────────────────────
if (-not (Test-Path $NodeExe) -or -not (Test-Path $PnpmScript)) {
    Show-Tip "找不到运行环境（Node / pnpm）。`n`nDSH 客户端更新后路径可能会变，需要重新生成快捷方式。`n`n预期路径：`n$NodeExe"
    exit 1
}

if (Test-ToolboxServer) {
    # 服务已经在跑，什么都不用做
} else {
    $env:PATH = (Split-Path $NodeExe) + ';' + $env:PATH

    # 最小化窗口启动；关掉那个窗口就等于停止服务
    Start-Process -FilePath $NodeExe `
        -ArgumentList $PnpmScript, 'dev' `
        -WorkingDirectory $ProjectDir `
        -WindowStyle Minimized

    # 等它编译完（首次要几秒），最多等 90 秒
    $ready = $false
    for ($i = 0; $i -lt 90; $i++) {
        Start-Sleep -Seconds 1
        if (Test-ToolboxServer) { $ready = $true; break }
    }

    if (-not $ready) {
        Show-Tip "本地服务启动超时（90 秒）。`n`n请检查：`n  1. 项目目录是否存在：$ProjectDir`n  2. 依赖是否装好（node_modules）`n`n也可以手动打开任务栏上那个最小化的窗口看报错。"
        exit 1
    }

    # 端口通了不代表已经能正常响应，稍等一下再开浏览器
    Start-Sleep -Seconds 1
}

if (-not $NoBrowser) {
    Start-Process $Url
}

exit 0
