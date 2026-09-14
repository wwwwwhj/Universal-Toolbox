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
        [pscustomobject]@{
            protocol = $fields[0]
            address = $local.Substring(0, $separator)
            port = $localPort
            pid = $ownerId
            state = $(if ($fields[0] -eq 'TCP') { $fields[3] } else { 'BOUND' })
        }
    }
}

try {
    if ($action -eq 'list') {
        $workingDirectoryError = $null
        try { Add-Type -TypeDefinition $workingDirectorySource -ErrorAction Stop }
        catch { $workingDirectoryError = "工作目录读取组件不可用：$($_.Exception.Message)" }
        # CIM 信息批量读取一次，避免每条端口记录都触发一次系统查询。
        # 详情权限不足不应影响基础端口查询，更不能把读取失败显示成“没有服务”。
        $metadata = @{}
        $services = @{}
        $detailsWarnings = @()
        try {
            Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, CommandLine, CreationDate -OperationTimeoutSec 10 | ForEach-Object {
                $metadata[[int]$_.ProcessId] = $_
            }
        } catch { $detailsWarnings += "启动命令和父进程信息读取失败：$($_.Exception.Message)" }
        $servicesAvailable = $true
        try {
            Get-CimInstance Win32_Service -Property ProcessId, Name, DisplayName, State -OperationTimeoutSec 10 | ForEach-Object {
                if ($_.ProcessId -gt 0) {
                    $services[[int]$_.ProcessId] += @([pscustomobject]@{ name = $_.Name; displayName = $_.DisplayName; state = $_.State })
                }
            }
        } catch {
            $servicesAvailable = $false
            $detailsWarnings += "关联服务读取失败：$($_.Exception.Message)"
        }
        $processes = @{}
        $rows = @(foreach ($owner in (Get-PortOwners | Sort-Object port, protocol, address, pid, state -Unique)) {
            if (-not $processes.ContainsKey($owner.pid)) {
                $info = @{ name = '未知进程'; path = $null; startedAt = $null; blockedReason = $null; startedAtDisplay = $null; workingDirectory = $null; workingDirectoryError = $workingDirectoryError }
                $process = $null
                try {
                    $process = Get-Process -Id $owner.pid -ErrorAction Stop
                    $info.name = $process.ProcessName
                    $info.startedAt = $process.StartTime.ToUniversalTime().Ticks.ToString()
                    $info.startedAtDisplay = $process.StartTime.ToUniversalTime().ToString('o')
                    $info.path = $process.Path
                } catch {
                    $info.blockedReason = '进程已退出或无权读取，请刷新或以管理员身份运行。'
                } finally {
                    if ($null -ne $process) { $process.Dispose() }
                }
                if ($null -eq $workingDirectoryError -and $null -ne $info.startedAt) {
                    try { $info.workingDirectory = [PortWorkingDirectory]::Read($owner.pid, [long]$info.startedAt) }
                    catch { $info.workingDirectoryError = "无法读取工作目录：$($_.Exception.GetBaseException().Message)" }
                }
                if ($owner.pid -le 4 -or $owner.pid -eq $appPid) {
                    $info.blockedReason = '不允许停止系统进程或工具箱自身。'
                }
                $processes[$owner.pid] = $info
            }
            $info = $processes[$owner.pid]
            $meta = $metadata[$owner.pid]
            # CIM 快照可能比端口快照更早，启动时间不一致时不能显示复用 PID 的旧详情。
            $sameProcess = $null -ne $meta -and $null -ne $info.startedAt -and
                $null -ne $meta.CreationDate -and
                [Math]::Abs(($meta.CreationDate.ToUniversalTime() - [DateTime]::new([long]$info.startedAt, [DateTimeKind]::Utc)).TotalMilliseconds) -lt 1
            $parent = $null
            if ($sameProcess) {
                $parent = $metadata[[int]$meta.ParentProcessId]
                if ($null -ne $parent -and $parent.CreationDate -gt $meta.CreationDate) { $parent = $null }
            }
            $processServices = $null
            if ($servicesAvailable -and $sameProcess) {
                $processServices = @($services[$owner.pid] | Where-Object { $null -ne $_ })
            }
            [pscustomobject]@{
                protocol = $owner.protocol; address = $owner.address; port = $owner.port
                pid = $owner.pid; state = $owner.state; name = $info.name; path = $info.path
                startedAt = $info.startedAt; blockedReason = $info.blockedReason
                workingDirectory = $info.workingDirectory; workingDirectoryError = $info.workingDirectoryError
                startedAtDisplay = $info.startedAtDisplay
                commandLine = $(if ($sameProcess) { $meta.CommandLine } else { $null })
                parentPid = $(if ($sameProcess) { [int]$meta.ParentProcessId } else { $null })
                parentName = $(if ($null -ne $parent) { $parent.Name } else { $null })
                services = $processServices
                detailsWarnings = @($detailsWarnings)
            }
        })
        ConvertTo-Json -InputObject $rows -Depth 3 -Compress
    } else {
        if ($targetPid -le 4 -or $targetPid -eq $appPid) { throw '不允许停止系统进程或工具箱自身。' }
        $process = Get-Process -Id $targetPid -ErrorAction Stop
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
