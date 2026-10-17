# MakeShortcut.ps1 - 为 lkserver2-game 生成带 OIP-C.ico 图标的启动快捷方式
# 由 生成快捷方式.bat 调用。编码必须是 UTF-8 with BOM，否则 PowerShell 5.1
# 按 GBK 读中文会乱码。
#
# 原理：直接按 MS-SHLLINK 二进制格式写 .lnk——不依赖 WScript.Shell COM，
# 也不需要任何第三方工具，任何有 PowerShell 的 Windows 都能跑。
# 结构参照本机 Windows 官方 .lnk 逆向确认：
#   头 76 字节（注意 72~76 还有 4 字节保留区）
#   LinkInfo version 1：28 字节头 + VolumeID(16B) + ANSI LocalBasePath
#   StringData：NAME/REL_PATH/WORKING_DIR/ICON_LOCATION，计数含结尾 null
# 已知取舍：不带 LinkTargetIDList（可选结构），靠 LocalBasePath 绝对路径定位，
#   与多个成熟 .lnk 写入库的做法一致；selftest 模式会真点火验证。

param(
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$ico = Join-Path $root 'OIP-C.ico'
$bat = Join-Path $root 'SquadDeck.bat'
$linkName = 'SquadDeck.lnk'
$desc = 'SquadDeck 联机游戏启动器'

# ---------------- .lnk 二进制构造（MS-SHLLINK） ----------------
function New-LnkBytes {
    param(
        [Parameter(Mandatory)][string]$Target,   # 目标绝对路径（LinkInfo.LocalBasePath，ANSI）
        [Parameter(Mandatory)][string]$Icon,     # 图标绝对路径（StringData.IconLocation）
        [string]$Name,                            # 快捷方式备注名（StringData.NAME）
        [string]$RelativePath,                    # 相对路径（StringData.REL_PATH），传空则不带
        [string]$WorkingDir                       # 工作目录（StringData.WORKING_DIR）
    )
    $uni = [System.Text.Encoding]::Unicode       # UTF-16LE，GetBytes 不带 BOM
    $ansi = [System.Text.Encoding]::Default      # 系统 ANSI 码页（中文系统 = GBK）

    # LinkFlags：HasLinkInfo | HasIconLocation | IsUnicode 为基底，
    # 再按内容追加 HasName / HasRelativePath / HasWorkingDir
    $flags = 0x02 -bor 0x40 -bor 0x80
    if ($Name)         { $flags = $flags -bor 0x04 }
    if ($RelativePath) { $flags = $flags -bor 0x08 }
    if ($WorkingDir)   { $flags = $flags -bor 0x10 }

    # ---- StringData（顺序固定：NAME -> REL_PATH -> WORKING_DIR -> ARGS -> ICON_LOCATION）----
    $sd = New-Object System.IO.MemoryStream
    function Add-Str([string]$s) {
        $b = $uni.GetBytes($s)
        $cnt = $s.Length + 1                     # 字符数含结尾 null（Windows 实测如此）
        [void]$sd.WriteByte($cnt -band 0xFF)
        [void]$sd.WriteByte(($cnt -shr 8) -band 0xFF)
        [void]$sd.Write($b, 0, $b.Length)
        [void]$sd.WriteByte(0); [void]$sd.WriteByte(0)
    }
    if ($Name)         { Add-Str $Name }
    if ($RelativePath) { Add-Str $RelativePath }
    if ($WorkingDir)   { Add-Str $WorkingDir }
    Add-Str $Icon

    # ---- LinkInfo（version 1，头部 28 字节）----
    # [0]Size [4]HeaderSize=28 [8]Flags=1(VolumeIDAndLocalBasePath)
    # [12]VolumeIDOffset [16]LocalBasePathOffset [20]CommonNetRelLinkOffset=0
    # [24]CommonPathSuffixOffset [28..]VolumeID [..]LocalBasePath(ANSI) [..]孤立 null
    $volLabel = ''
    try {
        $di = New-Object System.IO.DriveInfo((Split-Path -Qualifier $Target))
        if ($di.IsReady) { $volLabel = $di.VolumeLabel }
    } catch { }
    $labelBytes = $ansi.GetBytes($volLabel)       # 卷标允许为空串（只剩一个 null）
    $volSize = 16 + $labelBytes.Length + 1
    $lbpBytes = $ansi.GetBytes($Target)
    $volOff = 28
    $lbpOff = $volOff + $volSize
    $suffixOff = $lbpOff + $lbpBytes.Length + 1
    $liSize = $suffixOff + 1

    $li = New-Object System.IO.MemoryStream
    [void]$li.Write([BitConverter]::GetBytes([int]$liSize), 0, 4)
    [void]$li.Write([BitConverter]::GetBytes(28), 0, 4)
    [void]$li.Write([BitConverter]::GetBytes(1), 0, 4)
    [void]$li.Write([BitConverter]::GetBytes($volOff), 0, 4)
    [void]$li.Write([BitConverter]::GetBytes($lbpOff), 0, 4)
    [void]$li.Write([BitConverter]::GetBytes(0), 0, 4)
    [void]$li.Write([BitConverter]::GetBytes($suffixOff), 0, 4)
    # VolumeID: Size, DriveType=3(固定磁盘), SerialNumber=0, VolumeLabelOffset=16
    [void]$li.Write([BitConverter]::GetBytes([int]$volSize), 0, 4)
    [void]$li.Write([BitConverter]::GetBytes(3), 0, 4)
    [void]$li.Write([BitConverter]::GetBytes(0), 0, 4)
    [void]$li.Write([BitConverter]::GetBytes(16), 0, 4)
    [void]$li.Write($labelBytes, 0, $labelBytes.Length)
    [void]$li.WriteByte(0)
    [void]$li.Write($lbpBytes, 0, $lbpBytes.Length)
    [void]$li.WriteByte(0)
    [void]$li.WriteByte(0)                        # 空的 CommonPathSuffix

    # ---- 头（76 字节）----
    $h = New-Object System.IO.MemoryStream
    [void]$h.Write([BitConverter]::GetBytes(76), 0, 4)
    [void]$h.Write([byte[]](0x01,0x14,0x02,0x00,0x00,0x00,0x00,0x00,0xC0,0x00,0x00,0x00,0x00,0x00,0x00,0x46), 0, 16)
    [void]$h.Write([BitConverter]::GetBytes($flags), 0, 4)
    [void]$h.Write([BitConverter]::GetBytes(0x20), 0, 4)   # FILE_ATTRIBUTE_ARCHIVE（同 Windows）
    [void]$h.Write([byte[]](0,0,0,0,0,0,0,0), 0, 8)        # CreationTime
    [void]$h.Write([byte[]](0,0,0,0,0,0,0,0), 0, 8)        # AccessTime
    [void]$h.Write([byte[]](0,0,0,0,0,0,0,0), 0, 8)        # WriteTime
    [void]$h.Write([BitConverter]::GetBytes(0), 0, 4)      # FileSize
    [void]$h.Write([BitConverter]::GetBytes(0), 0, 4)      # IconIndex
    [void]$h.Write([BitConverter]::GetBytes(1), 0, 4)      # ShowCommand = SW_SHOWNORMAL
    [void]$h.WriteByte(0); [void]$h.WriteByte(0)           # HotKey
    [void]$h.WriteByte(0); [void]$h.WriteByte(0)           # Reserved1
    [void]$h.Write([BitConverter]::GetBytes(0), 0, 4)      # Reserved2
    [void]$h.Write([BitConverter]::GetBytes(0), 0, 4)      # Reserved3（补足 76 字节）
    if ($h.Length -ne 76) { throw "header build bug: length=$($h.Length)" }

    $hBytes = $h.ToArray()
    $liBytes = $li.ToArray()
    $sdBytes = $sd.ToArray()
    return $hBytes + $liBytes + $sdBytes
}

function New-Shortcut {
    param(
        [string]$LnkPath, [string]$Target, [string]$Icon,
        [string]$Name, [string]$RelativePath, [string]$WorkingDir
    )
    $bytes = New-LnkBytes -Target $Target -Icon $Icon -Name $Name -RelativePath $RelativePath -WorkingDir $WorkingDir
    $dir = Split-Path -Parent $LnkPath
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [System.IO.File]::WriteAllBytes($LnkPath, $bytes)
}

# ---------------- 自检：中文路径 + bat 目标，真点火 ----------------
if ($SelfTest) {
    Write-Host ''
    Write-Host '  =========  快捷方式自检  =========' -ForegroundColor Cyan
    Write-Host '  会生成一个临时快捷方式并启动它（目标是记事本），用来验证系统能识别本脚本生成的 .lnk。'
    if (-not (Test-Path -LiteralPath $ico)) {
        Write-Host "  [X] 找不到图标 $ico" -ForegroundColor Red
        Read-Host '  按回车退出'; exit 1
    }
    $tmp = Join-Path $env:TEMP 'lkserver2-selftest'
    if (Test-Path -LiteralPath $tmp) { Remove-Item -Recurse -Force -LiteralPath $tmp }
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    try {
        # 中文文件名 + 纯 ASCII 内容（cmd 按 GBK 解析 bat，内容不能有中文）
        $tb = Join-Path $tmp '自检启动器.bat'
        [System.IO.File]::WriteAllText($tb, "@echo off`r`nstart notepad`r`n", [System.Text.Encoding]::ASCII)
        $tl = Join-Path $tmp '自检.lnk'
        New-Shortcut -LnkPath $tl -Target $tb -Icon $ico -Name 'LKSERVER2 快捷方式自检' -RelativePath '自检启动器.bat' -WorkingDir $tmp
        Write-Host "  已生成临时快捷方式，正在点火..." -ForegroundColor DarkGray
        $before = @(Get-Process notepad -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
        Start-Process -FilePath $tl
        $newPid = $null
        for ($i = 0; $i -lt 80; $i++) {
            Start-Sleep -Milliseconds 100
            $p = Get-Process notepad -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id }
            if ($p) { $newPid = $p.Id; break }
        }
        if ($newPid) {
            Write-Host '  [OK] 系统成功识别了快捷方式，记事本已弹出——本脚本生成的 .lnk 可用。' -ForegroundColor Green
            Start-Sleep -Seconds 1
            Stop-Process -Id $newPid -Force -ErrorAction SilentlyContinue
        } else {
            Write-Host '  [X] 自检失败：快捷方式没有被系统识别（记事本未出现）。' -ForegroundColor Red
            Write-Host '      请把本窗口截图反馈。' -ForegroundColor Red
        }
    } finally {
        if (Test-Path -LiteralPath $tmp) { Remove-Item -Recurse -Force -LiteralPath $tmp }
    }
    Write-Host ''
    Read-Host '  按回车退出'
    exit 0
}

# ---------------- 正式生成 ----------------
Write-Host ''
Write-Host '  =========  生成快捷方式  =========' -ForegroundColor Cyan
Write-Host ''

if (-not (Test-Path -LiteralPath $ico)) {
    Write-Host "  [X] 找不到图标文件：$ico" -ForegroundColor Red
    Write-Host '      它应该和本脚本放在同一个目录里。' -ForegroundColor Red
    Read-Host '  按回车退出'; exit 1
}
if (-not (Test-Path -LiteralPath $bat)) {
    Write-Host "  [X] 找不到启动入口：$bat" -ForegroundColor Red
    Write-Host '      它应该和本脚本放在同一个目录里。' -ForegroundColor Red
    Read-Host '  按回车退出'; exit 1
}

$made = @()

# 1) 项目目录内：带相对路径，整个文件夹搬家后依然有效
$inFolder = Join-Path $root $linkName
$existed = Test-Path -LiteralPath $inFolder
New-Shortcut -LnkPath $inFolder -Target $bat -Icon $ico -Name $desc -RelativePath 'SquadDeck.bat' -WorkingDir $root
$made += $inFolder

# 2) 桌面：绝对路径定位（不带相对路径，避免猜错相对位置）
$desktop = [Environment]::GetFolderPath('Desktop')
if (-not $desktop -or -not (Test-Path -LiteralPath $desktop)) { $desktop = Join-Path $env:USERPROFILE 'Desktop' }
$deskLink = $null
if (Test-Path -LiteralPath $desktop) {
    $deskLink = Join-Path $desktop $linkName
    New-Shortcut -LnkPath $deskLink -Target $bat -Icon $ico -Name $desc -WorkingDir $root
    $made += $deskLink
}

Write-Host ''
foreach ($m in $made) {
    $tag = if (($m -eq $inFolder) -and $existed) { '已更新' } else { '已生成' }
    Write-Host ("  [OK] {0}  {1}" -f $tag, $m) -ForegroundColor Green
}
if (-not $deskLink) {
    Write-Host '  [!!] 没找到桌面目录，只生成了项目目录里的快捷方式。' -ForegroundColor Yellow
}
Write-Host ''
Write-Host "  目标：$bat"
Write-Host "  图标：$ico"

# 中文路径在非中文系统上会被 ANSI 码页打成 '?'，提前警告
$ansi = [System.Text.Encoding]::Default
if ($ansi.GetString($ansi.GetBytes($bat)) -ne $bat) {
    Write-Host ''
    Write-Host '  [!!] 当前系统默认代码页装不下中文路径，快捷方式在别的电脑上可能失效。' -ForegroundColor Yellow
    Write-Host '      建议直接用中文版 Windows，或把项目放到纯英文路径下。' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '  双击快捷方式即可开玩。' -ForegroundColor Cyan
Write-Host '  把整个文件夹拷给别人时，让对方运行一次本脚本重新生成（.lnk 里记的是本机绝对路径）。' -ForegroundColor DarkGray
Write-Host ''
Read-Host '  按回车退出'
exit 0
