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
# ★ 必须带 LinkTargetIDList（2026-10-17 实测教训）：只写 LinkInfo.LocalBasePath 的
#   .lnk 过不了 IShellLink::Load，ShellExecute 退回按扩展名找关联，而 lnkfile 的
#   open command 为空 → ERROR_NO_ASSOCIATION「没有应用程序与此操作的指定文件有关
#   联」，目标路径再对也发射不了。条目格式见 New-IdListBytes 上方注释。

param(
    [switch]$SelfTest,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$ico = Join-Path $root 'OIP-C.ico'
$bat = Join-Path $root 'SquadDeck.bat'
$linkName = 'SquadDeck.lnk'
$desc = 'SquadDeck 联机游戏启动器'

# ---------------- LinkTargetIDList 构造（.lnk 能被发射的硬性要求） ----------------
# 条目格式按本机资源管理器正统 .lnk 逐字段逆向确认（测试文件/dump_idlist.py 可
# 复现，样本：桌面 Keil uVision5.LNK 全量 hexdump）。现代 Win10 .lnk 的 IDList
# 是「单项巨型」格式：<uint16 链长+2> + 经典条目链 + <00 00>，且每个文件夹/文件
# 条目尾部还带 48+UTF-16名长 字节的扩展区（EF BE 块 + UTF-16 名 + 旧尺寸字段）。
# 2026-10-17 实测：只写经典短条目（无外层、无扩展区）过不了 IShellLink::Load，
# 必须按下面完整结构逐字节复刻正统样本。
$script:DosStamp = [uint32]1610636625   # 0x60005D51 = 2026-10-17 12:00 的 DOS 打包时间，固定值即可

function New-FsItemBytes {
    param(
        [byte]$Type,                          # 0x31 文件夹 / 0x32 文件
        [Parameter(Mandatory)][string]$Name,  # 单层条目名（不含 \）
        [uint32]$FileSize,
        [uint32]$DosTime,
        [uint16]$Attrs                        # 0x10 目录 / 0x20 普通文件
    )
    $ansi = [System.Text.Encoding]::Default
    $uni = [System.Text.Encoding]::Unicode
    # ANSI 名区 = 名 + null，补到偶数字节（正统样本均如此，如 "UV4"=4B / "图吧工具箱"=12B）
    $ab = $ansi.GetBytes($Name) + [byte]0
    if ($ab.Length % 2 -eq 1) { $ab = $ab + [byte]0 }
    $ub = $uni.GetBytes($Name + "`0")        # UTF-16 名 + null，恒为偶数字节
    $extSize = 48 + $ub.Length               # 扩展区大小（文件夹/文件两条分支的固定段都是 20B）
    $itemSize = 14 + $ab.Length + $extSize
    $m = New-Object System.IO.MemoryStream
    # ---- 14B 经典头 ----
    [void]$m.Write([BitConverter]::GetBytes([uint16]$itemSize), 0, 2)
    [void]$m.WriteByte($Type); [void]$m.WriteByte(0)
    [void]$m.Write([BitConverter]::GetBytes($FileSize), 0, 4)
    [void]$m.Write([BitConverter]::GetBytes($DosTime), 0, 4)
    [void]$m.Write([BitConverter]::GetBytes($Attrs), 0, 2)
    [void]$m.Write($ab, 0, $ab.Length)
    # ---- 扩展区：字段值照抄正统样本（固定值/时间戳，不参与启动解析）----
    [void]$m.Write([BitConverter]::GetBytes([uint16]$extSize), 0, 2)
    [void]$m.Write([byte[]](0x09,0x00, 0x04,0x00, 0xEF,0xBE), 0, 6)
    [void]$m.Write([BitConverter]::GetBytes($DosTime), 0, 4)      # mtime（本项）
    [void]$m.Write([BitConverter]::GetBytes($DosTime), 0, 4)      # mtime（父项；固定戳同值）
    [void]$m.Write([byte[]](0x2E,0x00,0x00,0x00), 0, 4)
    if ($Type -eq 0x31) {
        [void]$m.Write([byte[]](0x25,0xD1,0x00,0x00,0x00,0x00), 0, 6)
        [void]$m.Write([byte[]](0x19,0x00), 0, 2)
        [void]$m.Write([byte[]](0,0,0,0,0,0,0,0,0,0,0,0,0,0), 0, 14)
        [void]$m.Write([byte[]](0xE5,0x6E,0xA6,0x00), 0, 4)
    } else {
        [void]$m.Write([byte[]](0xB7,0xD1,0x00,0x00,0x00,0x00), 0, 6)
        [void]$m.Write([byte[]](0x09,0x00), 0, 2)
        [void]$m.Write([byte[]](0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0), 0, 18)
    }
    [void]$m.Write($ub, 0, $ub.Length)                            # UTF-16 名 + null
    [void]$m.Write([BitConverter]::GetBytes([uint16](14 + $ab.Length)), 0, 2)  # 旧格式条目尺寸
    if ($m.Length -ne $itemSize) { throw "fs item build bug: len=$($m.Length) size=$itemSize" }
    return $m.ToArray()
}

function New-IdListBytes {
    param([Parameter(Mandatory)][string]$Target)
    $ansi = [System.Text.Encoding]::Default
    # [0] ThisPC 根条目（20B 固定）
    $id = [byte[]]@(
        0x14,0x00, 0x1F,0x50,
        0xE0,0x4F,0xD0,0x20,0xEA,0x3A,0x69,0x10,0xA2,0xD8,0x08,0x00,0x2B,0x30,0x30,0x9D
    )
    # [1] 盘符条目（25B）
    $drive = (Split-Path -Qualifier $Target) + '\'
    $db = $ansi.GetBytes($drive)
    $m = New-Object System.IO.MemoryStream
    [void]$m.WriteByte(0x19); [void]$m.WriteByte(0x00)
    [void]$m.WriteByte(0x2F)
    [void]$m.Write($db, 0, $db.Length)
    [void]$m.WriteByte(0)
    while ($m.Length -lt 25) { [void]$m.WriteByte(0) }
    $id += $m.ToArray()
    # [2..n-1] 文件夹条目：从盘符根逐级往下拆
    $folders = New-Object System.Collections.ArrayList
    $dir = Split-Path -Parent $Target
    while ($dir -and ($dir.TrimEnd('\') -ne $drive.TrimEnd('\')) -and $dir.Length -gt 3) {
        [void]$folders.Insert(0, (Split-Path -Leaf $dir))
        $dir = Split-Path -Parent $dir
    }
    foreach ($f in $folders) {
        $id += New-FsItemBytes -Type 0x31 -Name $f -FileSize 0 -DosTime $script:DosStamp -Attrs 0x10
    }
    # [n] 文件条目
    $fsize = 0
    try { $fsize = (Get-Item -LiteralPath $Target -ErrorAction Stop).Length } catch { }
    $id += New-FsItemBytes -Type 0x32 -Name (Split-Path -Leaf $Target) -FileSize $fsize -DosTime $script:DosStamp -Attrs 0x20
    # 现代 Win10 .lnk 的 IDList = <uint16 链长+2> + 条目链 + <00 00 终止符>
    $w = New-Object System.IO.MemoryStream
    [void]$w.Write([BitConverter]::GetBytes([uint16]($id.Length + 2)), 0, 2)
    [void]$w.Write($id, 0, $id.Length)
    [void]$w.WriteByte(0); [void]$w.WriteByte(0)
    return $w.ToArray()
}

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
    $flags = 0x01 -bor 0x02 -bor 0x40 -bor 0x80
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

    # ---- LinkTargetIDList（能否发射的硬性要求，见文件头注释）----
    $idBytes = New-IdListBytes -Target $Target

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
    return $hBytes + $idBytes + $liBytes + $sdBytes
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
        if (-not $Quiet) { Read-Host '  按回车退出' }; exit 1
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
        for ($i = 0; $i -lt 5 -and (Test-Path -LiteralPath $tmp); $i++) {
            try { Remove-Item -Recurse -Force -LiteralPath $tmp -ErrorAction Stop } catch { Start-Sleep -Milliseconds 300 }
        }
    }
    Write-Host ''
    if (-not $Quiet) { Read-Host '  按回车退出' }
    exit 0
}

# ---------------- 正式生成 ----------------
Write-Host ''
Write-Host '  =========  生成快捷方式  =========' -ForegroundColor Cyan
Write-Host ''

if (-not (Test-Path -LiteralPath $ico)) {
    Write-Host "  [X] 找不到图标文件：$ico" -ForegroundColor Red
    Write-Host '      它应该和本脚本放在同一个目录里。' -ForegroundColor Red
    if (-not $Quiet) { Read-Host '  按回车退出' }; exit 1
}
if (-not (Test-Path -LiteralPath $bat)) {
    Write-Host "  [X] 找不到启动入口：$bat" -ForegroundColor Red
    Write-Host '      它应该和本脚本放在同一个目录里。' -ForegroundColor Red
    if (-not $Quiet) { Read-Host '  按回车退出' }; exit 1
}

$made = @()

# 1) 测试文件目录内：.lnk 记的是本机绝对路径，换电脑/换目录必然失效，
#    所以它不算项目交付物，统一放 测试文件/（带相对路径 ..\SquadDeck.bat 作兜底）
$inFolder = Join-Path (Join-Path $root '测试文件') $linkName
$existed = Test-Path -LiteralPath $inFolder
New-Shortcut -LnkPath $inFolder -Target $bat -Icon $ico -Name $desc -RelativePath '..\SquadDeck.bat' -WorkingDir $root
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
    Write-Host '  [!!] 没找到桌面目录，只生成了测试文件目录里的快捷方式。' -ForegroundColor Yellow
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
if (-not $Quiet) { Read-Host '  按回车退出' }
exit 0
