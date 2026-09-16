$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Get-PortOwners {
    $lines = & "$env:SystemRoot\System32\netstat.exe" -ano
    if ($LASTEXITCODE -ne 0) { throw 'netstat 查询失败。' }
    foreach ($line in $lines) {
        $fields = $line.Trim() -split '\s+'
        if ($fields.Count -lt 4 -or $fields[0] -notin @('TCP', 'UDP')) { continue }
        $local = $fields[1]
        $separator = $local.LastIndexOf(':')
        if ($separator -lt 0) { continue }
        $localPort = [int]$local.Substring($separator + 1)
        $ownerId = [int]$fields[-1]
        # TIME_WAIT 等 PID 为 0 的记录没有可停止进程，不能把它们当成服务。
        if ($ownerId -eq 0 -or ($filterPort -ne 0 -and $localPort -ne $filterPort)) { continue }
        # TCP 第三列是对端地址；监听中的 0.0.0.0:0 / [::]:0 和 UDP 的 *:* 都不是真实对端。
        $remote = $null
        if ($fields[0] -eq 'TCP' -and $fields.Count -ge 5 -and $fields[2] -notin @('0.0.0.0:0', '[::]:0', '*:*')) {
            $remote = $fields[2]
        }
        [pscustomobject]@{
            protocol = $fields[0]
            address = $local.Substring(0, $separator)
            remoteAddress = $remote
            port = $localPort
            pid = $ownerId
            state = $(if ($fields[0] -eq 'TCP') { $fields[3] } else { 'BOUND' })
        }
    }
}

# 进程信息组件按源码哈希缓存编译产物，避免每次查询都重新编译。
# 返回 $null 表示可用；返回错误文本表示组件不可用。
function Initialize-ProcessInfo {
    $dll = $null
    try {
        $hash = [BitConverter]::ToString(
            [Security.Cryptography.SHA256]::Create().ComputeHash(
                [Text.Encoding]::UTF8.GetBytes($processInfoSource))).Replace('-', '').Substring(0, 16)
        $dir = Join-Path $env:LOCALAPPDATA 'Universal-Toolbox'
        $dll = Join-Path $dir "process-info-$hash.dll"
        if (Test-Path $dll) {
            Add-Type -Path $dll -ErrorAction Stop
        } else {
            [IO.Directory]::CreateDirectory($dir) | Out-Null
            Add-Type -TypeDefinition $processInfoSource -OutputAssembly $dll -ErrorAction Stop
            Add-Type -Path $dll -ErrorAction Stop
        }
        return $null
    } catch {
        # 缓存目录不可写、并发编译或产物损坏时退回内存编译。
        if ($null -ne $dll) { Remove-Item $dll -Force -ErrorAction SilentlyContinue }
        try { Add-Type -TypeDefinition $processInfoSource -ErrorAction Stop; return $null }
        catch { return "进程信息读取组件不可用：$($_.Exception.Message)" }
    }
}

try {
    if ($action -eq 'list') {
        # 先解析端口占用：端口无占用时不做任何进程查询。
        $owners = @(Get-PortOwners | Sort-Object port, protocol, address, remoteAddress, pid, state -Unique)
        if ($owners.Count -eq 0) { '[]' }
        else {
            $componentError = Initialize-ProcessInfo
            $detailsWarnings = @()
            if ($null -ne $componentError) { $detailsWarnings += $componentError }
            # 进程快照一次读取全部进程的名称、创建时间与父进程。
            $snapshot = @{}
            if ($null -eq $componentError) {
                try {
                    foreach ($entry in [PortProcessInfo]::Snapshot().GetEnumerator()) {
                        $snapshot[$entry.Key] = $entry.Value
                    }
                } catch {
                    $detailsWarnings += "进程快照读取失败：$($_.Exception.Message)"
                }
            }
            # 第一遍只取快照中的名称与启动时间，不做任何逐进程读取。
            $processes = @{}
            foreach ($owner in $owners) {
                if ($processes.ContainsKey($owner.pid)) { continue }
                $info = @{ name = '未知进程'; path = $null; startedAt = $null; blockedReason = $null; startedAtDisplay = $null; workingDirectory = $null; workingDirectoryError = $componentError; commandLine = $null; loaded = $false }
                $identity = $snapshot[$owner.pid]
                if ($null -eq $identity) {
                    $info.blockedReason = '进程已退出或无权读取，请刷新或以管理员身份运行。'
                } else {
                    # 快照名带 .exe 后缀，去掉后与 ProcessName 口径一致。
                    $info.name = $identity.Name -replace '\.exe$', ''
                    $info.startedAt = $identity.CreateTicks.ToString()
                    $info.startedAtDisplay = [DateTime]::new($identity.CreateTicks, [DateTimeKind]::Utc).ToString('o')
                }
                $processes[$owner.pid] = $info
            }
            # 预设只按进程名筛选：先过滤，再仅为匹配进程读取详情。
            if ($matchPreset) {
                $owners = @($owners | Where-Object {
                    $name = $processes[$_.pid].name
                    switch ($matchPreset) {
                        'nodejs' { $name -eq 'node' }
                        'java' { $name -in @('java', 'javaw') }
                        'python' { $name -match '^pythonw?[\d.]*$' }
                        default { $false }
                    }
                })
            }
            # 第二遍读取工作目录、映像路径和启动命令；同一 PID 只读一次。
            foreach ($owner in $owners) {
                $info = $processes[$owner.pid]
                if ($info.loaded -or $null -eq $info.startedAt) { continue }
                $info.loaded = $true
                try {
                    $detail = [PortProcessInfo]::Read($owner.pid, [long]$info.startedAt)
                    $info.workingDirectory = $detail.WorkingDirectory
                    if ($null -ne $detail.WorkingDirectoryError) {
                        $info.workingDirectoryError = "无法读取工作目录：$($detail.WorkingDirectoryError)"
                    } else { $info.workingDirectoryError = $null }
                    $info.path = $detail.ImagePath
                    $info.commandLine = $detail.CommandLine
                } catch {
                    $info.blockedReason = '进程已退出或无权读取，请刷新或以管理员身份运行。'
                    $info.workingDirectoryError = "无法读取工作目录：$($_.Exception.GetBaseException().Message)"
                }
                if ($owner.pid -le 4 -or $owner.pid -eq $appPid) {
                    $info.blockedReason = '不允许停止系统进程或工具箱自身。'
                }
            }
            # 自由文本同时匹配进程名、启动命令和程序路径，否则搜脚本名会漏掉 node、java 这类宿主进程。
            if ($matchText) {
                $textPattern = [regex]::Escape($matchText)
                $owners = @($owners | Where-Object {
                    $info = $processes[$_.pid]
                    $info.name -match $textPattern -or
                        ($null -ne $info.path -and $info.path -match $textPattern) -or
                        ($null -ne $info.commandLine -and $info.commandLine -match $textPattern)
                })
            }
            # 启动命令、父进程和关联服务不随列表返回，打开详情时按需读取。
            $rows = @(foreach ($owner in $owners) {
                $info = $processes[$owner.pid]
                [pscustomobject]@{
                    protocol = $owner.protocol; address = $owner.address; remoteAddress = $owner.remoteAddress; port = $owner.port
                    pid = $owner.pid; state = $owner.state; name = $info.name; path = $info.path
                    startedAt = $info.startedAt; blockedReason = $info.blockedReason
                    workingDirectory = $info.workingDirectory; workingDirectoryError = $info.workingDirectoryError
                    startedAtDisplay = $info.startedAtDisplay
                    detailsWarnings = @($detailsWarnings)
                }
            })
            # PowerShell 5.1 对空数组的 -InputObject 序列化输出为空串，显式返回 []。
            if ($rows.Count -eq 0) { '[]' } else { ConvertTo-Json -InputObject $rows -Depth 3 -Compress }
        }
    } elseif ($action -eq 'details') {
        # 详情按需读取：只查目标进程，不扫描全机服务以外的信息。
        $warnings = @()
        $commandLine = $null
        $parentPid = $null
        $parentName = $null
        $serviceList = $null
        $componentError = Initialize-ProcessInfo
        if ($null -ne $componentError) { $warnings += $componentError }
        $snapshot = @{}
        if ($null -eq $componentError) {
            try {
                foreach ($entry in [PortProcessInfo]::Snapshot().GetEnumerator()) {
                    $snapshot[$entry.Key] = $entry.Value
                }
            } catch {
                $warnings += "进程快照读取失败：$($_.Exception.Message)"
                $componentError = '进程快照不可用'
            }
        }
        $identity = $snapshot[$targetPid]
        if ($null -ne $componentError) {
            $warnings += '无法校验进程身份，详情不可用。'
        } elseif ($null -eq $identity -or $identity.CreateTicks.ToString() -ne $expectedStart) {
            $warnings += '进程已退出或已变化，无法读取详情，请刷新。'
        } else {
            try { $commandLine = [PortProcessInfo]::Read($targetPid, $identity.CreateTicks).CommandLine }
            catch { $warnings += "启动命令读取失败：$($_.Exception.GetBaseException().Message)" }
            if ($identity.ParentPid -gt 0) {
                $parentPid = $identity.ParentPid
                $parent = $snapshot[$identity.ParentPid]
                # 父进程退出后 PID 可能复用，比子进程更晚启动的不能显示为父进程。
                if ($null -ne $parent -and $parent.CreateTicks -le $identity.CreateTicks) { $parentName = $parent.Name }
            }
            try {
                $serviceList = @(Get-CimInstance Win32_Service -Filter "ProcessId = $targetPid" -Property Name, DisplayName, State -OperationTimeoutSec 10 | ForEach-Object {
                    [pscustomobject]@{ name = $_.Name; displayName = $_.DisplayName; state = $_.State }
                })
            } catch {
                $warnings += "关联服务读取失败：$($_.Exception.Message)"
            }
        }
        ConvertTo-Json -InputObject ([pscustomobject]@{
            commandLine = $commandLine; parentPid = $parentPid; parentName = $parentName
            services = $serviceList; warnings = @($warnings)
        }) -Depth 3 -Compress
    } else {
        if ($targetPid -le 4 -or $targetPid -eq $appPid) { throw '不允许停止系统进程或工具箱自身。' }
        try { $process = [System.Diagnostics.Process]::GetProcessById($targetPid) }
        catch { throw '进程已退出，请刷新。' }
        try {
            # 先持有进程句柄，再比较启动时间，避免 PID 被复用后停止另一个程序。
            $null = $process.Handle
            if ($process.StartTime.ToUniversalTime().Ticks.ToString() -ne $expectedStart) {
                throw '进程已变化，请重新查询后操作。'
            }
            $owner = @(Get-PortOwners | Where-Object { $_.pid -eq $targetPid })
            if ($owner.Count -eq 0) { throw '该进程已不再占用此端口，请刷新。' }
            # 只终止所确认的进程，不扩大到整棵进程树或更改 Windows 服务配置。
            $process.Kill()
            if (-not $process.WaitForExit(5000)) { throw '已发出停止请求，但进程尚未退出，请刷新确认。' }
        } finally { $process.Dispose() }
        'null'
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
