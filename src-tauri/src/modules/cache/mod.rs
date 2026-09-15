use serde::Serialize;
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheDir {
    path: String,
    // 路径来源：工具配置 / 环境变量 / 默认路径。
    source: &'static str,
    exists: bool,
    size_bytes: u64,
    file_count: u64,
    error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheTarget {
    id: &'static str,
    name: &'static str,
    category: &'static str,
    dirs: Vec<CacheDir>,
    total_bytes: u64,
}

// 询问工具自身配置得到缓存目录的命令，例如 `npm config get cache`。
struct Probe {
    program: &'static str,
    args: &'static [&'static str],
}

struct TargetSpec {
    id: &'static str,
    name: &'static str,
    category: &'static str,
    probes: &'static [Probe],
    // (环境变量, 变量值之下再追加的路径段)。
    env_dirs: &'static [(&'static str, &'static [&'static str])],
    defaults: fn() -> Vec<PathBuf>,
}

fn env_dir(key: &str) -> Option<PathBuf> {
    std::env::var_os(key)
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

fn home_dir() -> Option<PathBuf> {
    env_dir("USERPROFILE").or_else(|| env_dir("HOME"))
}

fn local_app_data() -> Option<PathBuf> {
    env_dir("LOCALAPPDATA").or_else(|| home_dir().map(|home| home.join("AppData/Local")))
}

fn xdg_cache() -> Option<PathBuf> {
    env_dir("XDG_CACHE_HOME").or_else(|| home_dir().map(|home| home.join(".cache")))
}

fn xdg_data() -> Option<PathBuf> {
    env_dir("XDG_DATA_HOME").or_else(|| home_dir().map(|home| home.join(".local/share")))
}

// 各平台通用的缓存根：Windows 为 %LOCALAPPDATA%，macOS 为 ~/Library/Caches，Linux 为 $XDG_CACHE_HOME 或 ~/.cache。
fn cache_base() -> Option<PathBuf> {
    if cfg!(windows) {
        local_app_data()
    } else if cfg!(target_os = "macos") {
        home_dir().map(|home| home.join("Library/Caches"))
    } else {
        xdg_cache()
    }
}

fn joined(base: Option<PathBuf>, segments: &[&str]) -> Vec<PathBuf> {
    base.map(|mut path| {
        for segment in segments {
            path.push(segment);
        }
        path
    })
    .into_iter()
    .collect()
}

fn defaults_npm() -> Vec<PathBuf> {
    if cfg!(windows) {
        joined(local_app_data(), &["npm-cache"])
    } else {
        joined(home_dir(), &[".npm"])
    }
}

fn defaults_pnpm_store() -> Vec<PathBuf> {
    let mut dirs = if cfg!(windows) {
        joined(local_app_data(), &["pnpm", "store"])
    } else if cfg!(target_os = "macos") {
        joined(home_dir(), &["Library", "pnpm", "store"])
    } else {
        joined(xdg_data(), &["pnpm", "store"])
    };
    // pnpm 7 之前的旧默认位置。
    dirs.extend(joined(home_dir(), &[".pnpm-store"]));
    dirs
}

fn defaults_pnpm_cache() -> Vec<PathBuf> {
    // Windows 的 %LOCALAPPDATA%\pnpm 是 PNPM_HOME（含 store），不是元数据缓存。
    if cfg!(windows) {
        joined(cache_base(), &["pnpm-cache"])
    } else {
        joined(cache_base(), &["pnpm"])
    }
}

fn defaults_yarn() -> Vec<PathBuf> {
    let mut dirs = if cfg!(windows) {
        joined(local_app_data(), &["Yarn", "Cache"])
    } else if cfg!(target_os = "macos") {
        joined(home_dir(), &["Library", "Caches", "Yarn"])
    } else {
        joined(xdg_cache(), &["yarn"])
    };
    // Yarn Berry 开启全局缓存时的位置。
    dirs.extend(joined(home_dir(), &[".yarn", "berry", "cache"]));
    dirs
}

fn defaults_node_gyp() -> Vec<PathBuf> {
    if cfg!(windows) {
        let mut dirs = joined(local_app_data(), &["node-gyp"]);
        dirs.extend(joined(home_dir(), &[".cache", "node-gyp"]));
        dirs
    } else {
        joined(xdg_cache(), &["node-gyp"])
    }
}

fn defaults_corepack() -> Vec<PathBuf> {
    if cfg!(windows) {
        joined(local_app_data(), &["node", "corepack"])
    } else {
        let mut dirs = joined(home_dir(), &[".cache", "node", "corepack"]);
        if cfg!(target_os = "macos") {
            dirs.extend(joined(home_dir(), &["Library", "Caches", "node", "corepack"]));
        }
        dirs
    }
}

fn defaults_bun() -> Vec<PathBuf> {
    joined(home_dir(), &[".bun", "install", "cache"])
}

fn defaults_deno() -> Vec<PathBuf> {
    joined(cache_base(), &["deno"])
}

fn defaults_cargo() -> Vec<PathBuf> {
    let mut dirs = joined(home_dir(), &[".cargo", "registry"]);
    dirs.extend(joined(home_dir(), &[".cargo", "git"]));
    dirs
}

fn defaults_rustup() -> Vec<PathBuf> {
    let mut dirs = joined(home_dir(), &[".rustup", "downloads"]);
    dirs.extend(joined(home_dir(), &[".rustup", "tmp"]));
    dirs
}

fn defaults_go_build() -> Vec<PathBuf> {
    joined(cache_base(), &["go-build"])
}

fn defaults_go_mod() -> Vec<PathBuf> {
    joined(home_dir(), &["go", "pkg", "mod"])
}

fn defaults_pip() -> Vec<PathBuf> {
    if cfg!(windows) {
        joined(local_app_data(), &["pip", "cache"])
    } else {
        joined(cache_base(), &["pip"])
    }
}

fn defaults_uv() -> Vec<PathBuf> {
    if cfg!(windows) {
        joined(local_app_data(), &["uv", "cache"])
    } else {
        let mut dirs = joined(xdg_cache(), &["uv"]);
        if cfg!(target_os = "macos") {
            dirs.extend(joined(home_dir(), &["Library", "Caches", "uv"]));
        }
        dirs
    }
}

fn defaults_gradle() -> Vec<PathBuf> {
    joined(home_dir(), &[".gradle", "caches"])
}

fn defaults_maven() -> Vec<PathBuf> {
    joined(home_dir(), &[".m2", "repository"])
}

fn defaults_sdkman() -> Vec<PathBuf> {
    let mut dirs = joined(home_dir(), &[".sdkman", "tmp"]);
    dirs.extend(joined(home_dir(), &[".sdkman", "archives"]));
    dirs
}

fn defaults_nuget() -> Vec<PathBuf> {
    joined(home_dir(), &[".nuget", "packages"])
}

const NODE: &str = "Node.js";

const SPECS: &[TargetSpec] = &[
    TargetSpec {
        id: "npm",
        name: "npm 缓存",
        category: NODE,
        probes: &[Probe {
            program: "npm",
            args: &["config", "get", "cache"],
        }],
        env_dirs: &[("npm_config_cache", &[])],
        defaults: defaults_npm,
    },
    TargetSpec {
        id: "pnpm-store",
        name: "pnpm store",
        category: NODE,
        probes: &[Probe {
            program: "pnpm",
            args: &["store", "path"],
        }],
        env_dirs: &[],
        defaults: defaults_pnpm_store,
    },
    TargetSpec {
        id: "pnpm-cache",
        name: "pnpm 元数据缓存",
        category: NODE,
        probes: &[
            Probe {
                program: "pnpm",
                args: &["config", "get", "cache-dir"],
            },
            Probe {
                program: "pnpm",
                args: &["config", "get", "cacheDir"],
            },
        ],
        env_dirs: &[],
        defaults: defaults_pnpm_cache,
    },
    TargetSpec {
        id: "yarn",
        name: "Yarn 缓存",
        category: NODE,
        probes: &[Probe {
            program: "yarn",
            args: &["cache", "dir"],
        }],
        env_dirs: &[("YARN_CACHE_FOLDER", &[])],
        defaults: defaults_yarn,
    },
    TargetSpec {
        id: "node-gyp",
        name: "node-gyp 缓存",
        category: NODE,
        probes: &[],
        env_dirs: &[],
        defaults: defaults_node_gyp,
    },
    TargetSpec {
        id: "corepack",
        name: "Corepack 缓存",
        category: NODE,
        probes: &[],
        env_dirs: &[("COREPACK_HOME", &[])],
        defaults: defaults_corepack,
    },
    TargetSpec {
        id: "bun",
        name: "Bun 缓存",
        category: NODE,
        probes: &[Probe {
            program: "bun",
            args: &["pm", "cache"],
        }],
        env_dirs: &[("BUN_INSTALL_CACHE_DIR", &[])],
        defaults: defaults_bun,
    },
    TargetSpec {
        id: "deno",
        name: "Deno 缓存",
        category: NODE,
        probes: &[],
        env_dirs: &[("DENO_DIR", &[])],
        defaults: defaults_deno,
    },
    TargetSpec {
        id: "cargo",
        name: "Cargo 包缓存",
        category: "Rust",
        probes: &[],
        env_dirs: &[("CARGO_HOME", &["registry"]), ("CARGO_HOME", &["git"])],
        defaults: defaults_cargo,
    },
    TargetSpec {
        id: "rustup",
        name: "Rustup 下载缓存",
        category: "Rust",
        probes: &[],
        env_dirs: &[("RUSTUP_HOME", &["downloads"]), ("RUSTUP_HOME", &["tmp"])],
        defaults: defaults_rustup,
    },
    TargetSpec {
        id: "go-build",
        name: "Go 构建缓存",
        category: "Go",
        probes: &[Probe {
            program: "go",
            args: &["env", "GOCACHE"],
        }],
        env_dirs: &[("GOCACHE", &[])],
        defaults: defaults_go_build,
    },
    TargetSpec {
        id: "go-mod",
        name: "Go 模块缓存",
        category: "Go",
        probes: &[Probe {
            program: "go",
            args: &["env", "GOMODCACHE"],
        }],
        env_dirs: &[("GOMODCACHE", &[]), ("GOPATH", &["pkg", "mod"])],
        defaults: defaults_go_mod,
    },
    TargetSpec {
        id: "pip",
        name: "pip 缓存",
        category: "Python",
        probes: &[
            Probe {
                program: "pip",
                args: &["cache", "dir"],
            },
            Probe {
                program: "pip3",
                args: &["cache", "dir"],
            },
        ],
        env_dirs: &[("PIP_CACHE_DIR", &[])],
        defaults: defaults_pip,
    },
    TargetSpec {
        id: "uv",
        name: "uv 缓存",
        category: "Python",
        probes: &[Probe {
            program: "uv",
            args: &["cache", "dir"],
        }],
        env_dirs: &[("UV_CACHE_DIR", &[])],
        defaults: defaults_uv,
    },
    TargetSpec {
        id: "gradle",
        name: "Gradle 缓存",
        category: "JVM",
        probes: &[],
        env_dirs: &[("GRADLE_USER_HOME", &["caches"])],
        defaults: defaults_gradle,
    },
    TargetSpec {
        id: "maven",
        name: "Maven 本地仓库",
        category: "JVM",
        probes: &[],
        env_dirs: &[],
        defaults: defaults_maven,
    },
    TargetSpec {
        id: "sdkman",
        name: "SDKMAN! 下载缓存",
        category: "JVM",
        probes: &[],
        env_dirs: &[("SDKMAN_DIR", &["tmp"]), ("SDKMAN_DIR", &["archives"])],
        defaults: defaults_sdkman,
    },
    TargetSpec {
        id: "nuget",
        name: "NuGet 全局包",
        category: ".NET",
        probes: &[],
        env_dirs: &[("NUGET_PACKAGES", &[])],
        defaults: defaults_nuget,
    },
];

// npm、pnpm、yarn 等在 Windows 上是 .cmd shim，CreateProcess 不会自动补全扩展名；
// .exe 安装（如独立版 pnpm、go）则直接用程序名解析。
// macOS/Linux 的 GUI 进程 PATH 很窄（从 Dock/Finder 启动时通常只有 /usr/bin 等），
// nvm、Homebrew、Volta 等版本管理器装的命令不在其中，需要手动补常见安装位置。
fn program_names(program: &str) -> Vec<String> {
    if cfg!(windows) {
        return vec![format!("{program}.cmd"), program.to_string()];
    }
    let mut names = vec![program.to_string()];
    for base in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
        names.push(format!("{base}/{program}"));
    }
    if let Some(home) = home_dir() {
        for rel in [
            ".local/bin",
            ".cargo/bin",
            ".bun/bin",
            ".deno/bin",
            ".volta/bin",
            ".asdf/shims",
            ".local/share/mise/shims",
            ".local/share/pnpm",
            "Library/pnpm",
        ] {
            names.push(home.join(rel).join(program).to_string_lossy().into_owned());
        }
        // nvm 每个版本一套 bin，逐个版本目录探测。
        if let Ok(entries) = fs::read_dir(home.join(".nvm/versions/node")) {
            for entry in entries.flatten() {
                names.push(
                    entry
                        .path()
                        .join("bin")
                        .join(program)
                        .to_string_lossy()
                        .into_owned(),
                );
            }
        }
    }
    names
}

fn run_capture(program: &str, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW，隐藏辅助控制台窗口。
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动 {program}：{error}"))?;
    // 配置查询输出只有一行；限制等待时间，避免工具异常时拖住整个扫描。
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                let output = child
                    .wait_with_output()
                    .map_err(|error| format!("无法读取 {program} 输出：{error}"))?;
                if !output.status.success() {
                    return Err(format!("{program} 退出码 {}", output.status));
                }
                return String::from_utf8(output.stdout)
                    .map_err(|error| format!("{program} 输出编码无效：{error}"));
            }
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(15));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{program} 探测超时"));
            }
        }
    }
}

fn probe_dir(probe: &Probe) -> Option<PathBuf> {
    for name in program_names(probe.program) {
        if let Ok(output) = run_capture(&name, probe.args) {
            // 有些命令在结果前后打印状态行，取最后一个形如绝对路径的输出行。
            let path = output
                .lines()
                .rev()
                .map(str::trim)
                .find(|line| !line.is_empty() && Path::new(line).is_absolute());
            if let Some(path) = path {
                return Some(PathBuf::from(path));
            }
        }
    }
    None
}

#[cfg(windows)]
fn is_reparse_point(entry: &fs::DirEntry) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    entry
        .metadata()
        .map(|meta| meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn is_reparse_point(_: &fs::DirEntry) -> bool {
    false
}

// 递归统计逻辑大小与文件数；跳过符号链接和 Windows 重解析点，避免循环或重复计算。
fn measure_dir(dir: &Path) -> (u64, u64, Option<String>) {
    let mut bytes = 0u64;
    let mut files = 0u64;
    let mut error: Option<String> = None;
    let record = |error: &mut Option<String>, entry: std::io::Error| {
        if error.is_none() {
            *error = Some(format!("部分文件无法读取：{entry}"));
        }
    };
    let mut pending = vec![dir.to_path_buf()];
    while let Some(current) = pending.pop() {
        let entries = match fs::read_dir(&current) {
            Ok(entries) => entries,
            Err(entry_error) => {
                record(&mut error, entry_error);
                continue;
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(entry_error) => {
                    record(&mut error, entry_error);
                    continue;
                }
            };
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(entry_error) => {
                    record(&mut error, entry_error);
                    continue;
                }
            };
            if file_type.is_symlink() || is_reparse_point(&entry) {
                continue;
            }
            if file_type.is_dir() {
                pending.push(entry.path());
            } else if file_type.is_file() {
                files += 1;
                match entry.metadata() {
                    Ok(meta) => bytes += meta.len(),
                    Err(meta_error) => record(&mut error, meta_error),
                }
            }
        }
    }
    (bytes, files, error)
}

fn normalize_key(path: &Path) -> String {
    let text = path
        .to_string_lossy()
        .trim_end_matches(['/', '\\'])
        .replace('\\', "/");
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text
    }
}

fn resolve_target(spec: &TargetSpec) -> CacheTarget {
    let mut candidates: Vec<(PathBuf, &'static str)> = Vec::new();
    for probe in spec.probes {
        if let Some(path) = probe_dir(probe) {
            candidates.push((path, "工具配置"));
            break;
        }
    }
    for (key, segments) in spec.env_dirs {
        candidates.extend(
            joined(env_dir(key), segments)
                .into_iter()
                .map(|path| (path, "环境变量")),
        );
    }
    candidates.extend(
        (spec.defaults)()
            .into_iter()
            .map(|path| (path, "默认路径")),
    );

    let mut seen = HashSet::new();
    let mut dirs = Vec::new();
    for (path, source) in candidates {
        if !seen.insert(normalize_key(&path)) {
            continue;
        }
        let exists = path.is_dir();
        let (size_bytes, file_count, error) = if exists {
            measure_dir(&path)
        } else {
            (0, 0, None)
        };
        dirs.push(CacheDir {
            path: path.to_string_lossy().into_owned(),
            source,
            exists,
            size_bytes,
            file_count,
            error,
        });
    }
    let total_bytes = dirs.iter().map(|dir| dir.size_bytes).sum();
    CacheTarget {
        id: spec.id,
        name: spec.name,
        category: spec.category,
        dirs,
        total_bytes,
    }
}

fn scan() -> Result<Vec<CacheTarget>, String> {
    // 每个工具独立线程：命令探测与目录遍历互不等候。
    std::thread::scope(|scope| {
        let handles: Vec<_> = SPECS
            .iter()
            .map(|spec| scope.spawn(|| resolve_target(spec)))
            .collect();
        handles
            .into_iter()
            .map(|handle| {
                handle
                    .join()
                    .map_err(|_| "缓存扫描线程异常终止。".to_string())
            })
            .collect()
    })
}

#[tauri::command]
pub async fn scan_dev_caches() -> Result<Vec<CacheTarget>, String> {
    // 目录遍历是阻塞 IO，放到阻塞线程池执行以免卡住桌面 UI。
    tauri::async_runtime::spawn_blocking(scan)
        .await
        .map_err(|error| format!("缓存扫描任务失败：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_returns_all_targets() {
        let targets = scan().unwrap();
        assert_eq!(targets.len(), SPECS.len());
        for target in &targets {
            assert!(!target.dirs.is_empty(), "{} 应至少给出一个候选目录", target.id);
        }
        for target in &targets {
            for dir in &target.dirs {
                if dir.exists {
                    eprintln!(
                        "{} | {} | {} B | {} 文件 | {}",
                        target.name, dir.path, dir.size_bytes, dir.file_count, dir.source
                    );
                }
            }
        }
    }

    #[test]
    fn measure_dir_counts_nested_files() {
        let root = std::env::temp_dir().join(format!("toolbox-cache-test-{}", std::process::id()));
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("a.bin"), [0u8; 10]).unwrap();
        fs::write(root.join("sub/b.bin"), [0u8; 5]).unwrap();
        let (bytes, files, error) = measure_dir(&root);
        fs::remove_dir_all(&root).unwrap();
        assert_eq!((bytes, files), (15, 2));
        assert!(error.is_none());
    }
}
