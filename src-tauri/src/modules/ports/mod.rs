use serde::{Deserialize, Serialize};

#[cfg(any(target_os = "macos", test))]
mod macos;
#[cfg(target_os = "macos")]
use macos::{list, stop};

#[cfg(target_os = "macos")]
fn details(pid: u32, started_at: &str) -> Result<PortOwnerDetails, String> {
    macos::owner_details(pid, started_at)
}

fn windows_platform() -> String {
    "windows".into()
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortOwner {
    #[serde(default = "windows_platform")]
    platform: String,
    protocol: String,
    address: String,
    remote_address: Option<String>,
    port: u16,
    pid: u32,
    state: String,
    name: String,
    path: Option<String>,
    working_directory: Option<String>,
    working_directory_error: Option<String>,
    started_at: Option<String>,
    blocked_reason: Option<String>,
    started_at_display: Option<String>,
    command_line: Option<String>,
    parent_pid: Option<u32>,
    parent_name: Option<String>,
    services: Option<Vec<ProcessService>>,
    details_warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessService {
    name: String,
    display_name: String,
    state: String,
}

/// 打开详情时才读取的字段；列表查询不附带这些需要 CIM 的数据。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortOwnerDetails {
    command_line: Option<String>,
    parent_pid: Option<u32>,
    parent_name: Option<String>,
    services: Option<Vec<ProcessService>>,
    warnings: Vec<String>,
}

#[cfg(windows)]
fn run_script(arguments: &str) -> Result<String, String> {
    use std::{os::windows::process::CommandExt, process::Command};
    let root = std::env::var_os("SystemRoot").ok_or("无法定位 Windows 系统目录。")?;
    let executable =
        std::path::PathBuf::from(root).join("System32/WindowsPowerShell/v1.0/powershell.exe");
    // 使用系统自带 PowerShell，无需用户额外安装；隐藏辅助控制台窗口。
    let output = Command::new(executable)
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"])
        .arg(format!(
            "{arguments}\n$processInfoSource = @'\n{}\n'@\n{}",
            include_str!("process-info.cs"),
            include_str!("ports.ps1")
        ))
        .creation_flags(0x08000000)
        .output()
        .map_err(|error| format!("无法执行端口操作：{error}"))?;
    if !output.status.success() {
        return Err(format!(
            "端口操作失败（权限不足时请以管理员身份运行）：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    String::from_utf8(output.stdout).map_err(|error| format!("端口结果编码无效：{error}"))
}

#[cfg(not(any(windows, target_os = "macos")))]
fn list(_: Option<u16>, _: Option<&str>, _: Option<&str>) -> Result<Vec<PortOwner>, String> {
    Err("端口管理目前仅支持 Windows 和 macOS。".into())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn details(_: u32, _: &str) -> Result<PortOwnerDetails, String> {
    Err("端口管理目前仅支持 Windows 和 macOS。".into())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn stop(_: u16, _: u32, _: &str) -> Result<(), String> {
    Err("端口管理目前仅支持 Windows 和 macOS。".into())
}

#[cfg(windows)]
fn list(port: Option<u16>, name: Option<&str>, preset: Option<&str>) -> Result<Vec<PortOwner>, String> {
    if port == Some(0) {
        return Err("端口必须在 1–65535 之间。".into());
    }
    // 搜索词进入 PowerShell 单引号字面量，字面量内唯一需要转义的是单引号本身。
    let match_text = name.map_or("$null".into(), |name| {
        format!("'{}'", name.replace('\'', "''"))
    });
    let match_preset = preset.map_or("$null".into(), |preset| format!("'{preset}'"));
    let output = run_script(&format!(
        "$action = 'list'; $filterPort = {}; $appPid = {}; $matchText = {match_text}; $matchPreset = {match_preset};",
        port.unwrap_or(0),
        std::process::id()
    ))?;
    serde_json::from_str(output.trim()).map_err(|error| format!("无法解析端口结果：{error}"))
}

#[cfg(windows)]
fn details(pid: u32, started_at: &str) -> Result<PortOwnerDetails, String> {
    if pid == 0 || pid > i32::MAX as u32 {
        return Err("进程无效。".into());
    }
    if started_at.is_empty()
        || started_at.len() > 19
        || !started_at.bytes().all(|b| b.is_ascii_digit())
    {
        return Err("进程身份信息无效，请重新查询。".into());
    }
    let output = run_script(&format!(
        "$action = 'details'; $targetPid = {pid}; $expectedStart = '{started_at}';"
    ))?;
    serde_json::from_str(output.trim()).map_err(|error| format!("无法解析进程详情：{error}"))
}

fn validate_stop(port: u16, pid: u32, started_at: &str) -> Result<(), String> {
    // IPC 参数同样校验；仅把数值和数字串放入固定脚本，禁止传入任意命令。
    if port == 0 || pid <= 4 || pid > i32::MAX as u32 || pid == std::process::id() {
        return Err("端口或进程无效，不允许停止系统进程或工具箱自身。".into());
    }
    if started_at.is_empty()
        || started_at.len() > 19
        || !started_at.bytes().all(|b| b.is_ascii_digit())
    {
        return Err("进程身份信息无效，请重新查询。".into());
    }
    Ok(())
}

#[cfg(windows)]
fn stop(port: u16, pid: u32, started_at: &str) -> Result<(), String> {
    validate_stop(port, pid, started_at)?;
    run_script(&format!(
        "$action = 'stop'; $filterPort = {port}; $appPid = {}; $targetPid = {pid}; $expectedStart = '{started_at}';",
        std::process::id()
    ))?;
    Ok(())
}

#[tauri::command]
pub async fn list_port_owners(
    port: Option<u16>,
    name: Option<String>,
    preset: Option<String>,
) -> Result<Vec<PortOwner>, String> {
    if let Some(preset) = preset.as_deref() {
        if !matches!(preset, "nodejs" | "java" | "python") {
            return Err("无效的进程类型筛选。".into());
        }
    }
    let name = match name {
        Some(name)
            if name.len() > 200
                || name
                    .chars()
                    .any(|c| c == '\0' || c == '\r' || c == '\n') =>
        {
            return Err("进程名搜索内容无效。".into());
        }
        other => other.filter(|name| !name.is_empty()),
    };
    // 系统查询放到阻塞线程，避免扫描端口时阻塞桌面 UI。
    tauri::async_runtime::spawn_blocking(move || list(port, name.as_deref(), preset.as_deref()))
        .await
        .map_err(|error| format!("端口查询任务失败：{error}"))?
}

#[tauri::command]
pub async fn get_port_owner_details(
    pid: u32,
    started_at: String,
) -> Result<PortOwnerDetails, String> {
    tauri::async_runtime::spawn_blocking(move || details(pid, &started_at))
        .await
        .map_err(|error| format!("进程详情任务失败：{error}"))?
}

#[tauri::command]
pub async fn stop_port_owner(port: u16, pid: u32, started_at: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || stop(port, pid, &started_at))
        .await
        .map_err(|error| format!("停止进程任务失败：{error}"))?
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader},
        os::windows::process::CommandExt,
        process::{Child, Command, Stdio},
    };

    struct TestProcess(Child);
    impl Drop for TestProcess {
        fn drop(&mut self) {
            // 只清理测试自己创建的进程，即使断言失败也不遗留占用。
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[test]
    fn query_and_stop_owned_tcp_udp_process() {
        let executable = std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let mut child = TestProcess(
            Command::new(executable)
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    r#"
                $ErrorActionPreference = 'Stop'
                [Environment]::CurrentDirectory = [IO.Path]::GetTempPath()
                $tcp = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
                $tcp.Start()
                $port = $tcp.LocalEndpoint.Port
                $udp = [System.Net.Sockets.UdpClient]::new($port)
                [Console]::WriteLine($port)
                [Console]::Out.Flush()
                [Console]::ReadLine() | Out-Null
            "#,
                ])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .creation_flags(0x08000000)
                .spawn()
                .unwrap(),
        );
        let mut line = String::new();
        BufReader::new(child.0.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let port: u16 = line.trim().parse().expect("测试进程应输出随机监听端口");
        let rows = list(Some(port), None, None).unwrap();
        let owned: Vec<_> = rows.iter().filter(|row| row.pid == child.0.id()).collect();
        assert!(owned
            .iter()
            .any(|row| row.protocol == "TCP" && row.state == "LISTENING"));
        assert!(owned.iter().any(|row| row.protocol == "UDP"));
        let owner = owned[0];
        assert!(owner.blocked_reason.is_none(), "{:?}", owner);
        assert!(
            owner.working_directory_error.is_none(),
            "{:?}",
            owner.working_directory_error
        );
        assert_eq!(
            std::fs::canonicalize(
                owner
                    .working_directory
                    .as_ref()
                    .expect("应读取真实工作目录")
            )
            .unwrap(),
            std::fs::canonicalize(std::env::temp_dir()).unwrap()
        );
        assert!(owner
            .started_at_display
            .as_deref()
            .is_some_and(|value| value.contains('T')));
        // 名称筛选在后端执行：按进程名应命中，按其它预设应排除。
        assert!(list(Some(port), Some("powershell"), None)
            .unwrap()
            .iter()
            .any(|row| row.pid == owner.pid));
        assert!(list(Some(port), None, Some("java"))
            .unwrap()
            .iter()
            .all(|row| row.pid != owner.pid));
        assert!(list(Some(port), Some("不存在的长尾关键字xyz"), None)
            .unwrap()
            .iter()
            .all(|row| row.pid != owner.pid));
        // 列表不附带 CIM 详情，详情按需读取。
        assert!(owner.command_line.is_none());
        let detail = details(owner.pid, owner.started_at.as_deref().unwrap()).unwrap();
        // 受限环境可能禁止 CIM，必须明确降级；不能把查询失败伪装成空详情。
        if detail.warnings.is_empty() {
            assert!(detail
                .command_line
                .as_deref()
                .is_some_and(|value| value.contains("TcpListener")));
            assert_eq!(detail.parent_pid, Some(std::process::id()));
            assert!(detail.parent_name.is_some());
            assert!(detail
                .services
                .as_ref()
                .is_some_and(|services| services.is_empty()));
        } else {
            assert!(detail.warnings.iter().all(|warning| !warning.is_empty()));
        }
        assert!(details(0, owner.started_at.as_deref().unwrap()).is_err());
        assert!(details(owner.pid, "1").is_err() || {
            let detail = details(owner.pid, "1").unwrap();
            detail.command_line.is_none() && !detail.warnings.is_empty()
        });
        assert!(list(Some(0), None, None).is_err());
        assert!(stop(port, 4, "1").is_err());
        assert!(stop(port, std::process::id(), "1").is_err());
        assert!(stop(port, owner.pid, "'; exit 0; '").is_err());
        assert!(stop(port, owner.pid, "1").is_err(), "过期身份必须拒绝停止");
        assert!(child.0.try_wait().unwrap().is_none());
        let other_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let other_port = other_listener.local_addr().unwrap().port();
        assert!(
            stop(other_port, owner.pid, owner.started_at.as_deref().unwrap()).is_err(),
            "不能停止已不再占用所选端口的进程"
        );
        assert!(list(None, None, None)
            .unwrap()
            .iter()
            .any(|row| row.pid == owner.pid && row.port == port));
        stop(port, owner.pid, owner.started_at.as_deref().unwrap()).unwrap();
        assert!(list(Some(port), None, None)
            .unwrap()
            .iter()
            .all(|row| row.pid != owner.pid));
    }
}
