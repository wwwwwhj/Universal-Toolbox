use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortOwner {
    protocol: String,
    address: String,
    port: u16,
    pid: u32,
    state: String,
    name: String,
    path: Option<String>,
    started_at: Option<String>,
    blocked_reason: Option<String>,
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
        .arg(format!("{arguments}\n{}", include_str!("ports.ps1")))
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

#[cfg(not(windows))]
fn run_script(_: &str) -> Result<String, String> {
    Err("端口管理目前仅支持 Windows。".into())
}

fn list(port: Option<u16>) -> Result<Vec<PortOwner>, String> {
    if port == Some(0) {
        return Err("端口必须在 1–65535 之间。".into());
    }
    let output = run_script(&format!(
        "$action = 'list'; $filterPort = {}; $appPid = {};",
        port.unwrap_or(0),
        std::process::id()
    ))?;
    serde_json::from_str(output.trim()).map_err(|error| format!("无法解析端口结果：{error}"))
}

fn stop(port: u16, pid: u32, started_at: &str) -> Result<(), String> {
    // IPC 参数同样校验；仅把数值和数字串放入固定脚本，禁止传入任意命令。
    if port == 0 || pid <= 4 || pid == std::process::id() {
        return Err("端口或进程无效，不允许停止系统进程或工具箱自身。".into());
    }
    if started_at.is_empty()
        || started_at.len() > 19
        || !started_at.bytes().all(|b| b.is_ascii_digit())
    {
        return Err("进程身份信息无效，请重新查询。".into());
    }
    run_script(&format!(
        "$action = 'stop'; $filterPort = {port}; $appPid = {}; $targetPid = {pid}; $expectedStart = '{started_at}';",
        std::process::id()
    ))?;
    Ok(())
}

#[tauri::command]
pub async fn list_port_owners(port: Option<u16>) -> Result<Vec<PortOwner>, String> {
    // 系统查询放到阻塞线程，避免扫描端口时阻塞桌面 UI。
    tauri::async_runtime::spawn_blocking(move || list(port))
        .await
        .map_err(|error| format!("端口查询任务失败：{error}"))?
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
        let rows = list(Some(port)).unwrap();
        let owned: Vec<_> = rows.iter().filter(|row| row.pid == child.0.id()).collect();
        assert!(owned
            .iter()
            .any(|row| row.protocol == "TCP" && row.state == "LISTENING"));
        assert!(owned.iter().any(|row| row.protocol == "UDP"));
        let owner = owned[0];
        assert!(owner.blocked_reason.is_none(), "{:?}", owner);
        assert!(list(Some(0)).is_err());
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
        assert!(list(None)
            .unwrap()
            .iter()
            .any(|row| row.pid == owner.pid && row.port == port));
        stop(port, owner.pid, owner.started_at.as_deref().unwrap()).unwrap();
        assert!(list(Some(port))
            .unwrap()
            .iter()
            .all(|row| row.pid != owner.pid));
    }
}
