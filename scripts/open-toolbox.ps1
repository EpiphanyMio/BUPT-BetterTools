<#
  我的工具箱 —— 桌面快捷方式启动器

  作用：确认本地网页服务在运行，然后打开浏览器。

  为什么需要它：
  「我的工具箱」是由 Vite 开发服务器在本机临时提供的网页，它不开机自启、
  也不注册成系统服务。所以如果只做一个网址快捷方式，在服务没启动时
  双击会看到「无法访问此网站」。这个脚本先探测服务，没启动就替你把
  服务拉起来，等它就绪后再打开浏览器。

  运行环境：
  用电脑上全局安装的 pnpm（就是 `npm i -g pnpm` 装的那个，在 %APPDATA%\npm 里）。
  以前这里写死了 DSH 客户端内部的 Node 和 pnpm 绝对路径 ——
  DSH 一升级、安装目录一变，脚本就找不到运行环境了。

  参数：
    -NoBrowser   只启动服务、不开浏览器（用于自检）
#>

param(
    [switch]$NoBrowser
)

# ── 配置 ──────────────────────────────────────────────────────────
# 项目目录由脚本自己的位置推出来（脚本在 <项目>\scripts\ 下），
# 这样整个项目换个地方放，这里也不用改。
$ProjectDir = Split-Path $PSScriptRoot -Parent
$Port       = 5173
$Url        = "http://localhost:$Port/"

# 判断网页服务是不是已经真的能用了。
#
# 这里有个实测踩出来的坑：
#   不能用 New-Object System.Net.Sockets.TcpClient 再去 Connect('::1')。
#   无参构造出来的是 IPv4 套接字，拿去连 IPv6 地址会直接报
#   "socket is not connected"。而 Vite 默认恰好只监听 IPv6 的 ::1，
#   于是「服务明明在跑」会被误判成「没跑」，进而重复启动一个服务。
# 所以改成发一个真正的 HTTP 请求 —— 能拿到 200，才算它可用。
function Test-ToolboxServer {
    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
        if ($response.StatusCode -eq 200) { return $true }
    } catch { }
    return $false
}

# 端口有没有被占着（不管上面跑的是什么程序）。
function Test-PortListening {
    $listening = netstat -ano | Select-String -Pattern (':' + $Port + '\s.*LISTENING')
    return [bool]$listening
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
if (Test-ToolboxServer) {
    # 服务已经在跑，什么都不用做
} else {
    # 端口被别的程序占着：Vite 加了 --strictPort 会直接退出，
    # 与其白等 90 秒再看超时提示，不如现在就讲清楚。
    if (Test-PortListening) {
        Show-Tip "端口 $Port 已经被别的程序占用了，工具箱起不来。`n`n请先关掉占用它的程序（多半是另一个没关掉的开发服务器窗口），再双击这个快捷方式。"
        exit 1
    }

    $pnpm = Get-Command 'pnpm.cmd' -ErrorAction SilentlyContinue
    if (-not $pnpm) {
        Show-Tip "找不到 pnpm。`n`n请在 PowerShell 里执行一次：`n`n    npm i -g pnpm`n`n装好之后再双击这个快捷方式。"
        exit 1
    }

    # 最小化窗口启动；关掉那个窗口就等于停止服务。
    #
    # --strictPort：5173 被占就直接报错退出，不要偷偷换到 5174。
    #   否则「脚本等的是 5173、浏览器开的是 5173」跟实际服务对不上。
    Start-Process -FilePath $pnpm.Source `
        -ArgumentList 'dev', '--strictPort' `
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
}

if (-not $NoBrowser) {
    Start-Process $Url
}

exit 0
