# 检查JDK.ps1 - 检查这台电脑有没有 JDK，没有就提醒下载
# 由 检查JDK.bat 调用。游戏服务端是 Java 程序，需要 JDK 17 或更高版本。
# 编码必须是 UTF-8 with BOM，否则 PowerShell 5.1 按 GBK 读中文会乱码。

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$need = 17                     # 项目要求的最低 JDK 大版本（见 run.bat 注释）

function Get-JavaMajor([string]$ver) {
    # java -version 输出形如：openjdk version "17.0.16" / "27-ea" / "1.8.0_431"
    $p = $ver.Split('.')
    if ($p[0] -eq '1') { return [int]$p[1] }        # Java 8 的老格式 1.8.0_xxx
    return [int]($p[0] -replace '[^0-9].*$', '')    # "27-ea" -> 27
}

function Get-JavaVer([string]$exe) {
    # java -version 的版本行是写到 stderr 的；脚本头设了 $ErrorActionPreference='Stop'，
    # 2>&1 合并流会被当成异常抛出（实测：THROW: openjdk version "27" ...）。
    # 所以这里临时把首选项降为 Continue，并用 Out-String 整体转成字符串再匹配。
    $old = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $out = (& $exe -version) 2>&1 | Out-String
        if ($out -match 'version "([^"]+)"') { return $Matches[1] }
    } catch { } finally {
        $ErrorActionPreference = $old
    }
    return $null
}

# ---- 多级查找：JAVA_HOME -> PATH -> 常见安装位置 ----
$found = @{}    # exe 路径 -> 信息（同一个 java.exe 不重复报）

if ($env:JAVA_HOME) {
    $exe = Join-Path $env:JAVA_HOME 'bin\java.exe'
    if (Test-Path -LiteralPath $exe) { $found[$exe] = 'JAVA_HOME 环境变量' }
}

$cmd = Get-Command java -ErrorAction SilentlyContinue
if ($cmd -and (Test-Path -LiteralPath $cmd.Source)) { $found[$cmd.Source] = '系统 PATH' }

$scanDirs = @(
    (Join-Path $env:USERPROFILE '.jdks'),                      # JetBrains / 手动装的
    "$env:ProgramFiles\Java",
    "${env:ProgramFiles(x86)}\Java",
    "$env:ProgramFiles\Eclipse Adoptium",
    "$env:ProgramFiles\Microsoft",                             # Microsoft Build of OpenJDK
    "$env:LOCALAPPDATA\Programs\Eclipse Adoptium"
)
foreach ($d in $scanDirs) {
    if (-not $d -or -not (Test-Path -LiteralPath $d)) { continue }
    Get-ChildItem -LiteralPath $d -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $exe = Join-Path $_.FullName 'bin\java.exe'
        if (Test-Path -LiteralPath $exe) { $found[$exe] = $_.FullName }
    }
}

Write-Host ''
Write-Host '  =========  JDK 环境检查  =========' -ForegroundColor Cyan
Write-Host ''

if ($found.Count -eq 0) {
    # ---------- 没找到：提醒 + 给下载入口 ----------
    Write-Host '  [X] 这台电脑没有检测到 JDK。' -ForegroundColor Red
    Write-Host ''
    Write-Host '  为什么需要它：游戏的服务端是 Java 程序，必须有 JDK 17 或更高版本'
    Write-Host '  才能运行（JRE 不行，要的是带开发包的 JDK）。'
    Write-Host ''
    Write-Host '  两种解决办法：'
    Write-Host '    [Y] 一键下载便携版到游戏目录（约 190MB，不动系统其它东西，推荐）'
    Write-Host '    [N] 打开 JDK 官网，自己下载安装'
    Write-Host ''
    $ans = Read-Host '  请选择 [Y/N]'
    if ($ans -eq 'Y' -or $ans -eq 'y') {
        $dl = Join-Path $root '下载便携JDK.bat'
        if (Test-Path -LiteralPath $dl) {
            Write-Host ''
            Write-Host '  正在打开便携 JDK 下载窗口，按它里面的提示操作；' -ForegroundColor Green
            Write-Host '  下载完成后回到这里双击「SquadDeck.bat」就能玩了。'
            Start-Sleep -Seconds 2
            Start-Process -FilePath $dl
        } else {
            Write-Host '  没找到 下载便携JDK.bat，请手动去官网下载：' -ForegroundColor Yellow
            Start-Process 'https://adoptium.net/'
        }
    } elseif ($ans -eq 'N' -or $ans -eq 'n') {
        Write-Host ''
        Write-Host '  已打开 JDK 官网，下载页选 Windows / JDK 17 或更高版本即可。' -ForegroundColor Green
        Start-Sleep -Seconds 2
        Start-Process 'https://adoptium.net/temurin/releases/'
    } else {
        Write-Host '  已取消。需要时重新双击「检查JDK.bat」。'
    }
    Write-Host ''
    Read-Host '  按回车退出'
    exit 1
}

# ---------- 找到了：逐个报版本，判断是否够用 ----------
$best = $null
foreach ($exe in ($found.Keys | Sort-Object)) {
    $ver = Get-JavaVer $exe
    $major = if ($ver) { Get-JavaMajor $ver } else { 0 }
    $src = $found[$exe]
    if ($major -ge $need) {
        Write-Host ("  [OK] JDK {0,-10} {1}" -f $ver, $src) -ForegroundColor Green
        if (-not $best -or $major -gt $best.Major) { $best = @{ Ver = $ver; Major = $major; Src = $src } }
    } elseif ($major -gt 0) {
        Write-Host ("  [!!] JDK {0,-10} {1}  （版本太低，游戏需要 {2} 或更高）" -f $ver, $src, $need) -ForegroundColor Yellow
    } else {
        Write-Host ("  [??] 取不到版本    {0}" -f $src) -ForegroundColor DarkGray
    }
}

Write-Host ''
if ($best) {
    Write-Host ("  结论：检测到 JDK {0}，满足运行要求，可以直接双击「SquadDeck.bat」开玩。" -f $best.Ver) -ForegroundColor Cyan
} else {
    Write-Host ("  结论：找到的 JDK 都低于 {0}，请先升级（可双击「下载便携JDK.bat」下新版）。" -f $need) -ForegroundColor Yellow
}
Write-Host ''
Read-Host '  按回车退出'
exit 0
