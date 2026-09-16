use crate::modules::ports::PortOwner;

// lsof 使用 NUL 分隔字段，不能按空格或换行拆路径（目录可以包含这些字符）。
// 字段规范：https://lsof.readthedocs.io/en/stable/manpage/#output-for-other-programs
#[derive(Default, Debug)]
struct FileRecord {
    pid: u32,
    name: String,
    fd: String,
    family: String,
    protocol: String,
    address: String,
    state: String,
}

fn parse_files(output: &str) -> Result<Vec<FileRecord>, String> {
    let mut result = Vec::new();
    let mut pid = 0;
    let mut name = String::new();
    let mut file: Option<FileRecord> = None;
    for field in output.split('\0') {
        let field = field.trim_start_matches('\n');
        if field.is_empty() {
            continue;
        }
        if !field.as_bytes()[0].is_ascii() {
            return Err("lsof 返回了无效字段标识。".into());
        }
        let (tag, value) = field.split_at(1);
        if tag == "p" || tag == "f" {
            if let Some(record) = file.take() {
                result.push(record);
            }
        }
        match tag {
            "p" => {
                pid = value.parse().map_err(|_| "lsof 返回了无效 PID。")?;
                name.clear();
            }
            "c" => name = value.into(),
            "f" => {
                file = Some(FileRecord {
                    pid,
                    name: name.clone(),
                    fd: value.into(),
                    ..Default::default()
                })
            }
            _ => {
                if let Some(record) = file.as_mut() {
                    match tag {
                        "t" => record.family = value.into(),
                        "P" => record.protocol = value.into(),
                        "n" => record.address = value.into(),
                        "T" => {
                            if let Some(state) = value.strip_prefix("ST=") {
                                record.state = state.into();
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
    }
    if let Some(record) = file {
        result.push(record);
    }
    Ok(result)
}

fn local_endpoint(record: &FileRecord) -> Option<(String, u16, Option<String>)> {
    if !matches!(record.protocol.as_str(), "TCP" | "UDP") {
        return None;
    }
    // -i:端口也会匹配远端端口，因此在解析后只按本地端口过滤。
    let mut parts = record.address.split("->");
    let local = parts.next()?;
    // 监听或未连接的 UDP 没有对端，lsof 写作 * 或不输出 -> 部分。
    let remote = parts
        .next()
        .filter(|remote| !remote.is_empty() && !remote.starts_with('*'))
        .map(str::to_string);
    let (address, port) = local.rsplit_once(':')?;
    let port = port.parse::<u16>().ok().filter(|port| *port > 0)?;
    let address = if address == "*" {
        match record.family.as_str() {
            "IPv4" => "0.0.0.0",
            "IPv6" => "[::]",
            _ => return None,
        }
        .into()
    } else {
        address.to_string()
    };
    Some((address, port, remote))
}

// Unix 时间戳转 UTC 显示文本，替代每个进程一次 /bin/date 调用。
fn format_utc(seconds: u64) -> String {
    let days = (seconds / 86400) as i64;
    let secs = seconds % 86400;
    let (hour, minute, second) = (secs / 3600, secs % 3600 / 60, secs % 60);
    // Howard Hinnant 的 civil_from_days，纪元日 1970-01-01 对应 z = 719468。
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

// 与 Windows 端 ports.ps1 的预设口径一致：按进程名精确匹配。
fn matches_preset(preset: &str, name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    match preset {
        "nodejs" => name == "node",
        "java" => name == "java" || name == "javaw",
        "python" => name
            .strip_prefix("python")
            .map(|rest| rest.strip_prefix('w').unwrap_or(rest))
            .is_some_and(|rest| rest.bytes().all(|b| b.is_ascii_digit() || b == b'.')),
        _ => false,
    }
}

fn matches_filter(row: &PortOwner, name: Option<&str>, preset: Option<&str>) -> bool {
    if let Some(preset) = preset {
        return matches_preset(preset, &row.name);
    }
    let Some(text) = name else {
        return true;
    };
    let text = text.to_lowercase();
    [
        Some(row.name.as_str()),
        row.command_line.as_deref(),
        row.path.as_deref(),
    ]
    .into_iter()
    .flatten()
    .any(|value| value.to_lowercase().contains(&text))
}

#[cfg(target_os = "macos")]
pub(super) use native::{list, owner_details, stop};

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use crate::modules::ports::{validate_stop, PortOwnerDetails};
    use std::{collections::HashMap, ffi::c_void, process::Command, time::Duration};

    // Darwin proc_bsdinfo ABI，字段宽度在 Intel/Apple Silicon 上一致。
    // https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info.h
    #[repr(C)]
    #[derive(Default)]
    struct ProcessInfo {
        flags: u32,
        status: u32,
        exit_status: u32,
        pid: u32,
        parent: u32,
        uid: u32,
        gid: u32,
        real_uid: u32,
        real_gid: u32,
        saved_uid: u32,
        saved_gid: u32,
        reserved: u32,
        command: [u8; 16],
        name: [u8; 32],
        files: u32,
        group: u32,
        job: u32,
        device: u32,
        terminal_group: u32,
        nice: i32,
        seconds: u64,
        microseconds: u64,
    }

    #[link(name = "proc")]
    extern "C" {
        fn proc_pidinfo(pid: i32, flavor: i32, arg: u64, buffer: *mut c_void, size: i32) -> i32;
        fn proc_pidpath(pid: i32, buffer: *mut c_void, size: u32) -> i32;
    }
    extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }

    fn process_info(pid: u32) -> Result<ProcessInfo, String> {
        if pid == 0 || pid > i32::MAX as u32 {
            return Err("无效 PID。".into());
        }
        let mut info = ProcessInfo::default();
        let size = std::mem::size_of::<ProcessInfo>() as i32;
        // 缓冲区大小与 C ABI 一致，系统返回完整数据后才读取字段。
        let count =
            unsafe { proc_pidinfo(pid as i32, 3, 0, &mut info as *mut _ as *mut c_void, size) };
        if count != size {
            return Err(format!(
                "无法读取进程 {pid}（可能已退出或权限不足）：{}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(info)
    }

    fn identity(info: &ProcessInfo) -> String {
        format!("{}{:06}", info.seconds, info.microseconds)
    }

    fn output(program: &str, args: &[&str], empty_allowed: bool) -> Result<String, String> {
        let result = Command::new(program)
            .args(args)
            .env("LC_ALL", "C")
            .output()
            .map_err(|error| format!("无法执行 {program}：{error}"))?;
        let error = String::from_utf8_lossy(&result.stderr);
        // lsof 无匹配时退出码为 1；带诊断信息的失败不能伪装成空结果。
        if !error.trim().is_empty()
            || (!result.status.success()
                && !(empty_allowed && result.status.code() == Some(1) && result.stdout.is_empty()))
        {
            return Err(format!(
                "{program} 查询失败（请检查权限）：{} {}",
                result.status,
                error.trim()
            ));
        }
        String::from_utf8(result.stdout).map_err(|error| format!("查询结果不是 UTF-8：{error}"))
    }

    fn sockets(port: Option<u16>) -> Result<Vec<FileRecord>, String> {
        let selector = port
            .map(|port| format!("-i:{port}"))
            .unwrap_or_else(|| "-i".into());
        parse_files(&output(
            "/usr/sbin/lsof",
            &["-nP", &selector, "+c", "0", "-F0pcftPnT"],
            true,
        )?)
    }

    // 命令行和工作目录按 PID 集合各批量取一次，代替逐进程起 ps / lsof 子进程。
    #[derive(Default)]
    struct ProcessContext {
        commands: HashMap<u32, String>,
        cwds: HashMap<u32, String>,
        cwd_error: Option<String>,
        warnings: Vec<String>,
    }

    fn load_context(pids: &[u32]) -> ProcessContext {
        let mut ctx = ProcessContext::default();
        if pids.is_empty() {
            return ctx;
        }
        let pid_list = pids
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(",");
        match output(
            "/bin/ps",
            &["-ww", "-p", &pid_list, "-o", "pid=,command="],
            true,
        ) {
            Ok(text) => {
                for line in text.lines() {
                    let line = line.trim_start();
                    let Some((pid, command)) = line.split_once(char::is_whitespace) else {
                        continue;
                    };
                    if let Ok(pid) = pid.parse() {
                        ctx.commands.insert(pid, command.trim().into());
                    }
                }
            }
            Err(error) => ctx.warnings.push(error),
        }
        match output(
            "/usr/sbin/lsof",
            &["-a", "-p", &pid_list, "-d", "cwd", "-F0pfn"],
            true,
        ) {
            Ok(text) => match parse_files(&text) {
                Ok(files) => {
                    for file in files {
                        if file.fd == "cwd" && file.address.starts_with('/') {
                            ctx.cwds.insert(file.pid, file.address);
                        }
                    }
                }
                Err(error) => ctx.cwd_error = Some(error),
            },
            Err(error) => ctx.cwd_error = Some(error),
        }
        ctx
    }

    fn details(pid: u32, name: &str, ctx: &ProcessContext) -> PortOwner {
        let mut row = PortOwner {
            platform: "macos".into(),
            pid,
            name: name.into(),
            protocol: String::new(),
            address: String::new(),
            remote_address: None,
            port: 0,
            state: String::new(),
            path: None,
            working_directory: None,
            working_directory_error: None,
            started_at: None,
            blocked_reason: None,
            started_at_display: None,
            command_line: None,
            parent_pid: None,
            parent_name: None,
            services: None,
            details_warnings: vec![],
        };
        let info = match process_info(pid) {
            Ok(info) => info,
            Err(error) => {
                row.blocked_reason = Some(error.clone());
                row.details_warnings.push(error);
                return row;
            }
        };
        row.started_at = Some(identity(&info));
        if pid <= 4 || pid == std::process::id() || info.flags & 1 != 0 {
            row.blocked_reason = Some("不允许停止系统进程或工具箱自身。".into());
        }
        let mut path = [0u8; 4096];
        let count = unsafe {
            proc_pidpath(
                pid as i32,
                path.as_mut_ptr() as *mut c_void,
                path.len() as u32,
            )
        };
        if count > 0 && count as usize <= path.len() {
            row.path = Some(
                String::from_utf8_lossy(&path[..count as usize])
                    .trim_end_matches('\0')
                    .into(),
            );
        } else {
            row.details_warnings.push(format!(
                "无法读取程序路径：{}",
                std::io::Error::last_os_error()
            ));
        }
        row.details_warnings.extend(ctx.warnings.iter().cloned());
        row.command_line = ctx.commands.get(&pid).cloned();
        row.started_at_display = Some(format_utc(info.seconds));
        row.parent_pid = Some(info.parent);
        // 父进程退出后 PID 可能复用，不展示比子进程更晚启动的“父进程”。
        if let Ok(parent) = process_info(info.parent) {
            if (parent.seconds, parent.microseconds) <= (info.seconds, info.microseconds) {
                let bytes = if parent.name[0] == 0 {
                    &parent.command[..]
                } else {
                    &parent.name[..]
                };
                row.parent_name =
                    Some(String::from_utf8_lossy(bytes).trim_end_matches('\0').into());
            }
        }
        match ctx.cwds.get(&pid) {
            Some(path) => row.working_directory = Some(path.clone()),
            None => {
                row.working_directory_error = Some(
                    ctx.cwd_error
                        .clone()
                        .unwrap_or_else(|| "工作目录不可用（权限不足或进程已退出）。".into()),
                )
            }
        }
        // 查询各项详情期间也可能发生进程替换，不返回混合身份的数据。
        if process_info(pid).map(|current| identity(&current)).ok() != row.started_at {
            row.started_at = None;
            row.path = None;
            row.command_line = None;
            row.working_directory = None;
            row.started_at_display = None;
            row.parent_pid = None;
            row.parent_name = None;
            row.blocked_reason = Some("进程已变化，请刷新。".into());
            row.details_warnings
                .push("详情查询期间进程已变化，请刷新。".into());
        }
        row
    }

    pub(crate) fn owner_details(pid: u32, started_at: &str) -> Result<PortOwnerDetails, String> {
        let info = process_info(pid)?;
        if identity(&info) != started_at {
            return Err("进程已变化，请刷新。".into());
        }
        let bytes = if info.name[0] == 0 {
            &info.command[..]
        } else {
            &info.name[..]
        };
        let name = String::from_utf8_lossy(bytes).trim_end_matches('\0').to_string();
        let ctx = load_context(&[pid]);
        let row = details(pid, &name, &ctx);
        Ok(PortOwnerDetails {
            command_line: row.command_line,
            parent_pid: row.parent_pid,
            parent_name: row.parent_name,
            services: None,
            warnings: row.details_warnings,
        })
    }

    pub(crate) fn list(
        port: Option<u16>,
        name: Option<&str>,
        preset: Option<&str>,
    ) -> Result<Vec<PortOwner>, String> {
        if port == Some(0) {
            return Err("端口必须在 1–65535 之间。".into());
        }
        let files = sockets(port)?;
        let mut pids = Vec::new();
        for file in &files {
            if let Some((_, local_port, _)) = local_endpoint(file) {
                if port.is_some_and(|port| port != local_port) || pids.contains(&file.pid) {
                    continue;
                }
                pids.push(file.pid);
            }
        }
        let ctx = load_context(&pids);
        let mut processes = HashMap::new();
        let mut rows = Vec::new();
        for file in files {
            if let Some((address, local_port, remote)) = local_endpoint(&file) {
                if port.is_some_and(|port| port != local_port) {
                    continue;
                }
                let mut row = processes
                    .entry(file.pid)
                    .or_insert_with(|| details(file.pid, &file.name, &ctx))
                    .clone();
                row.address = address;
                row.remote_address = remote;
                row.port = local_port;
                row.protocol = file.protocol;
                row.state = match file.state.as_str() {
                    "LISTEN" => "LISTENING".into(),
                    "" if row.protocol == "UDP" => "BOUND".into(),
                    "" => "UNKNOWN".into(),
                    _ => file.state,
                };
                rows.push(row);
            }
        }
        rows.sort_by(|a, b| {
            (a.port, &a.protocol, &a.address, &a.remote_address, a.pid, &a.state).cmp(&(
                b.port,
                &b.protocol,
                &b.address,
                &b.remote_address,
                b.pid,
                &b.state,
            ))
        });
        rows.dedup_by(|a, b| {
            a.port == b.port
                && a.remote_address == b.remote_address
                && a.pid == b.pid
                && a.protocol == b.protocol
                && a.address == b.address
                && a.state == b.state
        });
        rows.retain(|row| matches_filter(row, name, preset));
        Ok(rows)
    }

    pub(crate) fn stop(port: u16, pid: u32, started_at: &str) -> Result<(), String> {
        validate_stop(port, pid, started_at)?;
        let info = process_info(pid)?;
        if info.flags & 1 != 0 || identity(&info) != started_at {
            return Err("系统进程不可停止，或进程身份已变化，请刷新。".into());
        }
        if !sockets(Some(port))?.iter().any(|file| {
            file.pid == pid && local_endpoint(file).is_some_and(|(_, local, _)| local == port)
        }) {
            return Err("该进程已不再占用此端口，请刷新。".into());
        }
        if identity(&process_info(pid)?) != started_at {
            return Err("进程已变化，请刷新。".into());
        }
        // ponytail: macOS 的 kill 按 PID 寻址，复核与发信号之间仍有极小竞态窗口。
        // 若未来系统提供按稳定进程句柄发信号的 API，应替换这里；不自动强杀或停止子树。
        if unsafe { kill(pid as i32, 15) } != 0 {
            return Err(format!("停止失败：{}", std::io::Error::last_os_error()));
        }
        for _ in 0..25 {
            match process_info(pid) {
                Ok(current) if identity(&current) != started_at || current.status == 5 => {
                    return Ok(())
                }
                Err(error) => {
                    // 查询失败不必然等于进程退出，只在 ESRCH 时报告成功。
                    if unsafe { kill(pid as i32, 0) } != 0
                        && std::io::Error::last_os_error().raw_os_error() == Some(3)
                    {
                        return Ok(());
                    }
                    return Err(format!("已发送终止信号，但无法确认退出：{error}"));
                }
                _ => std::thread::sleep(Duration::from_millis(200)),
            }
        }
        Err("已发送终止信号，但进程尚未退出，请刷新；未自动强制结束。".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_local_ports_and_cwd_without_losing_path_characters() {
        let files = parse_files("p20944\0cnode\0\nf1\0tIPv6\0PTCP\0n*:3000\0TST=LISTEN\0\nf2\0tIPv4\0PTCP\0n127.0.0.1:50000->127.0.0.1:3000\0TST=ESTABLISHED\0\nf3\0tIPv4\0PUDP\0n*:3000\0\np20945\0cnode\0\nf4\0tIPv6\0PTCP\0n[::1]:3000\0TST=LISTEN\0\n").unwrap();
        assert_eq!(files.len(), 4);
        assert_eq!(files[0].name, "node");
        assert_eq!(local_endpoint(&files[0]), Some(("[::]".into(), 3000, None)));
        assert_eq!(
            local_endpoint(&files[1]),
            Some(("127.0.0.1".into(), 50000, Some("127.0.0.1:3000".into())))
        );
        assert_eq!(local_endpoint(&files[2]), Some(("0.0.0.0".into(), 3000, None)));
        assert_eq!(files[3].pid, 20945);
        assert_eq!(local_endpoint(&files[3]), Some(("[::1]".into(), 3000, None)));
        assert_eq!(format_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(format_utc(1704067200), "2024-01-01T00:00:00Z");
        assert_eq!(format_utc(1735689599), "2024-12-31T23:59:59Z");
        let cwd = parse_files("p20944\0\nfcwd\0n/Users/test/中文 项目\n目录\0\n").unwrap();
        assert_eq!(cwd[0].address, "/Users/test/中文 项目\n目录");
        assert_eq!(cwd[0].fd, "cwd");
        assert!(local_endpoint(&cwd[0]).is_none());
        assert!(parse_files("").unwrap().is_empty());
        assert!(parse_files("pbad\0").is_err());
        assert!(parse_files("无效\0").is_err());
    }

    #[test]
    fn name_filters_match_frontend_presets() {
        let mut row = PortOwner::default();
        row.name = "node".into();
        assert!(matches_filter(&row, None, Some("nodejs")));
        assert!(!matches_filter(&row, None, Some("java")));
        assert!(!matches_filter(&row, None, Some("unknown")));
        row.name = "Python3.11".into();
        assert!(matches_filter(&row, None, Some("python")));
        row.name = "pythonw".into();
        assert!(matches_filter(&row, None, Some("python")));
        row.name = "pythonista".into();
        assert!(!matches_filter(&row, None, Some("python")));
        assert!(matches_filter(&row, None, None));
        // 自由文本同时匹配进程名、启动命令和程序路径，大小写不敏感。
        row.name = "node".into();
        row.command_line = Some("node /srv/Vite Site/server.js".into());
        row.path = Some("/usr/local/bin/node".into());
        assert!(matches_filter(&row, Some("vite site"), None));
        assert!(matches_filter(&row, Some("BIN/NODE"), None));
        assert!(!matches_filter(&row, Some("redis"), None));
        // preset 存在时优先于自由文本。
        assert!(!matches_filter(&row, Some("node"), Some("java")));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn listener_child() {
        if std::env::var_os("TOOLBOX_PORT_TEST_CHILD").is_none() {
            return;
        }
        use std::io::Write;
        let tcp = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = tcp.local_addr().unwrap().port();
        let _udp = std::net::UdpSocket::bind(("127.0.0.1", port)).unwrap();
        println!("\nPORT:{port}");
        std::io::stdout().flush().unwrap();
        std::thread::sleep(std::time::Duration::from_secs(60));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn query_and_stop_owned_macos_process() {
        use std::{
            io::{BufRead, BufReader},
            process::{Command, Stdio},
        };
        struct OwnedChild(std::process::Child);
        impl Drop for OwnedChild {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        // 测试子进程使用同一个测试可执行文件，不依赖 Node/Python，也不触碰用户服务。
        let mut child = OwnedChild(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "modules::ports::macos::tests::listener_child",
                    "--nocapture",
                ])
                .env("TOOLBOX_PORT_TEST_CHILD", "1")
                .current_dir(std::env::temp_dir())
                .stdout(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let port = BufReader::new(child.0.stdout.take().unwrap())
            .lines()
            .map(|line| line.unwrap())
            .find_map(|line| {
                line.strip_prefix("PORT:")
                    .map(|port| port.parse::<u16>().unwrap())
            })
            .expect("测试子进程应返回端口");
        let rows = list(Some(port), None, None).unwrap();
        let owned: Vec<_> = rows.iter().filter(|row| row.pid == child.0.id()).collect();
        assert!(owned.iter().any(|row| row.protocol == "TCP"));
        assert!(owned.iter().any(|row| row.protocol == "UDP"));
        let owner = owned[0];
        assert_eq!(
            std::fs::canonicalize(owner.working_directory.as_ref().unwrap()).unwrap(),
            std::fs::canonicalize(std::env::temp_dir()).unwrap()
        );
        assert!(owner.command_line.is_some());
        assert_eq!(owner.parent_pid, Some(std::process::id()));
        assert!(stop(port, owner.pid, "1").is_err());
        assert!(child.0.try_wait().unwrap().is_none());
        stop(port, owner.pid, owner.started_at.as_deref().unwrap()).unwrap();
        assert!(list(Some(port), None, None)
            .unwrap()
            .iter()
            .all(|row| row.pid != owner.pid));
    }
}
