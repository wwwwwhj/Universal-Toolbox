use serde::Serialize;
use std::{
    collections::HashMap,
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
    // 列表中存在被本目录覆盖的子目录条目；本目录的大小已排除那些子树。
    nested: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheTarget {
    id: &'static str,
    name: &'static str,
    category: &'static str,
    dirs: Vec<CacheDir>,
    total_bytes: u64,
    can_set: bool,
    // 展示给用户看的命令模板，例如 `npm config set cache <新目录>`。
    set_command: Option<&'static str>,
    // 没有 CLI 配置命令时，给出环境变量或配置文件的操作指引。
    relocate_guide: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    targets: Vec<CacheTarget>,
    // 跨目标去重后的合计：不同工具指向相同或父子重叠的目录只计一次。
    union_bytes: u64,
}

// 询问工具自身配置得到缓存目录的命令，例如 `npm config get cache`。
struct Probe {
    program: &'static str,
    args: &'static [&'static str],
}

// 通过 CLI 修改缓存目录的命令，例如 `npm config set cache <dir>`。
struct Setter {
    programs: &'static [&'static str],
    // 命令参数；{path} 会被替换为新目录，没有占位符时在末尾追加路径。
    args: &'static [&'static str],
    label: &'static str,
}

// 修改缓存位置的方式：能直接执行的命令，或需要用户手动操作的指引。
enum Relocate {
    Command(Setter),
    // 通过环境变量指定；note 为额外注意事项（如移动的其实是整个主目录）。
    Env { var: &'static str, note: &'static str },
    // 其他机制（编辑配置文件等），自定义说明文案。
    Guide(&'static str),
}

struct TargetSpec {
    id: &'static str,
    name: &'static str,
    category: &'static str,
    probes: &'static [Probe],
    // (环境变量, 变量值之下再追加的路径段)。
    env_dirs: &'static [(&'static str, &'static [&'static str])],
    defaults: fn() -> Vec<PathBuf>,
    relocate: Option<Relocate>,
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
        relocate: Some(Relocate::Command(Setter {
            programs: &["npm"],
            args: &["config", "set", "cache", "{path}"],
            label: "npm config set cache <新目录>",
        })),
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
        relocate: Some(Relocate::Command(Setter {
            programs: &["pnpm"],
            args: &["config", "set", "--global", "store-dir", "{path}"],
            label: "pnpm config set --global store-dir <新目录>",
        })),
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
        relocate: Some(Relocate::Command(Setter {
            programs: &["pnpm"],
            args: &["config", "set", "--global", "cache-dir", "{path}"],
            label: "pnpm config set --global cache-dir <新目录>",
        })),
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
        relocate: Some(Relocate::Command(Setter {
            programs: &["yarn"],
            args: &["config", "set", "cache-folder", "{path}"],
            label: "yarn config set cache-folder <新目录>",
        })),
    },
    TargetSpec {
        id: "node-gyp",
        name: "node-gyp 缓存",
        category: NODE,
        probes: &[],
        env_dirs: &[],
        defaults: defaults_node_gyp,
        relocate: Some(Relocate::Guide(
            "node-gyp 没有持久化配置命令。在 npm 场景下可执行 npm config set devdir <新目录>；直接调用 node-gyp 时使用 --devdir <新目录> 参数。",
        )),
    },
    TargetSpec {
        id: "corepack",
        name: "Corepack 缓存",
        category: NODE,
        probes: &[],
        env_dirs: &[("COREPACK_HOME", &[])],
        defaults: defaults_corepack,
        relocate: Some(Relocate::Env {
            var: "COREPACK_HOME",
            note: "",
        }),
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
        relocate: Some(Relocate::Env {
            var: "BUN_INSTALL_CACHE_DIR",
            note: "也可在 bunfig.toml 的 [install] 段设置 cacheDir。",
        }),
    },
    TargetSpec {
        id: "deno",
        name: "Deno 缓存",
        category: NODE,
        probes: &[],
        env_dirs: &[("DENO_DIR", &[])],
        defaults: defaults_deno,
        relocate: Some(Relocate::Env {
            var: "DENO_DIR",
            note: "",
        }),
    },
    TargetSpec {
        id: "cargo",
        name: "Cargo 包缓存",
        category: "Rust",
        probes: &[],
        env_dirs: &[("CARGO_HOME", &["registry"]), ("CARGO_HOME", &["git"])],
        defaults: defaults_cargo,
        relocate: Some(Relocate::Env {
            var: "CARGO_HOME",
            note: "这会移动整个 Cargo 主目录（含 bin、credentials 等），不只是缓存；旧目录内容需手动迁移。",
        }),
    },
    TargetSpec {
        id: "rustup",
        name: "Rustup 下载缓存",
        category: "Rust",
        probes: &[],
        env_dirs: &[("RUSTUP_HOME", &["downloads"]), ("RUSTUP_HOME", &["tmp"])],
        defaults: defaults_rustup,
        relocate: Some(Relocate::Env {
            var: "RUSTUP_HOME",
            note: "这会移动整个 Rustup 主目录（含全部工具链），不只是缓存；旧目录内容需手动迁移。",
        }),
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
        relocate: Some(Relocate::Command(Setter {
            programs: &["go"],
            args: &["env", "-w", "GOCACHE={path}"],
            label: "go env -w GOCACHE=<新目录>",
        })),
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
        relocate: Some(Relocate::Command(Setter {
            programs: &["go"],
            args: &["env", "-w", "GOMODCACHE={path}"],
            label: "go env -w GOMODCACHE=<新目录>",
        })),
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
        relocate: Some(Relocate::Command(Setter {
            programs: &["pip", "pip3"],
            args: &["config", "set", "global.cache-dir", "{path}"],
            label: "pip config set global.cache-dir <新目录>",
        })),
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
        relocate: Some(Relocate::Env {
            var: "UV_CACHE_DIR",
            note: "",
        }),
    },
    TargetSpec {
        id: "gradle",
        name: "Gradle 缓存",
        category: "JVM",
        probes: &[],
        env_dirs: &[("GRADLE_USER_HOME", &["caches"])],
        defaults: defaults_gradle,
        relocate: Some(Relocate::Env {
            var: "GRADLE_USER_HOME",
            note: "这会移动整个 Gradle 工作目录（含 wrapper 发行版），不只是缓存。",
        }),
    },
    TargetSpec {
        id: "maven",
        name: "Maven 本地仓库",
        category: "JVM",
        probes: &[],
        env_dirs: &[],
        defaults: defaults_maven,
        relocate: Some(Relocate::Guide(
            "Maven 没有命令行配置。编辑 ~/.m2/settings.xml，在 <settings> 节点中加入 <localRepository>新目录</localRepository>。",
        )),
    },
    TargetSpec {
        id: "sdkman",
        name: "SDKMAN! 下载缓存",
        category: "JVM",
        probes: &[],
        env_dirs: &[("SDKMAN_DIR", &["tmp"]), ("SDKMAN_DIR", &["archives"])],
        defaults: defaults_sdkman,
        relocate: Some(Relocate::Env {
            var: "SDKMAN_DIR",
            note: "这会移动整个 SDKMAN! 根目录（含已安装的各版本 SDK），不只是缓存。",
        }),
    },
    TargetSpec {
        id: "nuget",
        name: "NuGet 全局包",
        category: ".NET",
        probes: &[],
        env_dirs: &[("NUGET_PACKAGES", &[])],
        defaults: defaults_nuget,
        relocate: Some(Relocate::Env {
            var: "NUGET_PACKAGES",
            note: "也可编辑 NuGet.Config 中的 globalPackagesFolder。",
        }),
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

#[derive(Debug)]
enum CaptureError {
    // 程序不存在：继续尝试下一个候选程序名/路径。
    NotFound,
    // 程序确实运行了但失败：保留信息用于报错。
    Failed(String),
}

fn run_capture(program: &str, args: &[&str]) -> Result<String, CaptureError> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW，隐藏辅助控制台窗口。
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            CaptureError::NotFound
        } else {
            CaptureError::Failed(format!("无法启动 {program}：{error}"))
        }
    })?;
    // 配置查询输出只有一行；限制等待时间，避免工具异常时拖住整个扫描。
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                let output = child
                    .wait_with_output()
                    .map_err(|error| CaptureError::Failed(format!("无法读取 {program} 输出：{error}")))?;
                if !output.status.success() {
                    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
                    return Err(CaptureError::Failed(if detail.is_empty() {
                        format!("{program} 退出码 {}", output.status)
                    } else {
                        format!("{program} 失败：{detail}")
                    }));
                }
                return String::from_utf8(output.stdout)
                    .map_err(|error| CaptureError::Failed(format!("{program} 输出编码无效：{error}")));
            }
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(15));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(CaptureError::Failed(format!("{program} 探测超时")));
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
// exclude 为规范化 key：同目标中已单独统计的子目录，遍历时跳过其子树。
fn measure_dir(dir: &Path, exclude: &[String]) -> (u64, u64, Option<String>) {
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
                let path = entry.path();
                if exclude
                    .iter()
                    .any(|excluded| same_or_within(&normalize_key(&path), excluded))
                {
                    continue;
                }
                pending.push(path);
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

// 词法归一化路径：折叠重复分隔符并解析 `.`、`..`（`a/b/..` → `a`），
// 保证同一目录的多种写法在去重与子树判断下被视为同一路径。
// 注意：components() 不会解析 `..`（为符号链接安全保留了 ParentDir），这里手动弹出。
fn normalize_path(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut normalized = PathBuf::new();
    for component in path.components() {
        // 前一段是普通目录名时 `..` 可安全弹出；位于开头或根之后的 `..` 原样保留。
        if component == Component::ParentDir && normalized.file_name().is_some() {
            normalized.pop();
        } else if component != Component::CurDir || normalized.as_os_str().is_empty() {
            normalized.push(component.as_os_str());
        }
    }
    normalized
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

// key 为规范化后的路径串；parent 与 key 相同或为祖先目录时返回 true。
fn same_or_within(key: &str, parent: &str) -> bool {
    key == parent
        || key
            .strip_prefix(parent)
            .is_some_and(|rest| rest.starts_with('/'))
}

fn resolve_target(spec: &TargetSpec, previous: &[String]) -> CacheTarget {
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

    // 相同路径去重（保留优先级更高的来源）。父子目录重叠时两者都保留：
    // 父目录测量时排除已单列的子树避免重复计数，列表仍能看到「工具配置」等更具体来源。
    let mut kept: Vec<(PathBuf, &'static str, String)> = Vec::new();
    for (path, source) in candidates {
        let path = normalize_path(&path);
        let key = normalize_key(&path);
        if kept.iter().any(|(_, _, k)| k == &key) {
            continue;
        }
        kept.push((path, source, key));
    }
    // 上次扫描存在、但本次不再由配置/环境/默认路径报告的目录（如修改过缓存位置后的旧目录），
    // 仍然占磁盘，重新统计并标注为「之前的位置」；被已收目录覆盖或不复存在的跳过。
    for prev in previous {
        let path = normalize_path(Path::new(prev));
        let key = normalize_key(&path);
        if !path.is_dir() || kept.iter().any(|(_, _, k)| same_or_within(&key, k)) {
            continue;
        }
        kept.push((path, "之前的位置", key));
    }

    let keys: Vec<String> = kept.iter().map(|(_, _, key)| key.clone()).collect();
    let mut dirs = Vec::new();
    for (path, source, key) in kept {
        // 同目标中位于本目录之下的其他条目会单独统计，此处排除其子树。
        let exclude: Vec<String> = keys
            .iter()
            .filter(|other| other.as_str() != key.as_str() && same_or_within(other, &key))
            .cloned()
            .collect();
        let exists = path.is_dir();
        let (size_bytes, file_count, error) = if exists {
            measure_dir(&path, &exclude)
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
            nested: exists && !exclude.is_empty(),
        });
    }
    let total_bytes = dirs.iter().map(|dir| dir.size_bytes).sum();
    let (can_set, set_command, relocate_guide) = match &spec.relocate {
        Some(Relocate::Command(setter)) => (true, Some(setter.label), None),
        Some(Relocate::Env { var, note }) => (false, None, Some(env_guide(var, note))),
        Some(Relocate::Guide(text)) => (false, None, Some((*text).to_string())),
        None => (false, None, None),
    };
    CacheTarget {
        id: spec.id,
        name: spec.name,
        category: spec.category,
        dirs,
        total_bytes,
        can_set,
        set_command,
        relocate_guide,
    }
}

// 环境变量类工具的修改指引：按当前平台给出 setx 或 shell 配置的具体做法。
fn env_guide(var: &str, note: &str) -> String {
    let how = if cfg!(windows) {
        format!("可执行 setx {var} \"新目录\"（仅对新启动的进程生效），或在「系统属性 → 环境变量」中添加用户变量。")
    } else {
        format!("在 shell 配置（如 ~/.zshrc、~/.bashrc）中加入 export {var}=\"新目录\"，然后重新打开终端。")
    };
    let note = if note.is_empty() {
        String::new()
    } else {
        format!(" 注意：{note}")
    };
    format!("该工具没有配置命令，通过环境变量 {var} 指定。{how}{note}")
}

// 汇总时的跨目标去重：把全部已存在的条目看成一组目录树，
// 只统计没有任何祖先条目（无论是否同目标）的“最大”目录；
// 相同路径的条目测量口径可能不同（是否排除了已单列子树），取贡献较大者。
fn union_total(targets: &[CacheTarget]) -> u64 {
    let listed: Vec<(usize, String, u64)> = targets
        .iter()
        .enumerate()
        .flat_map(|(index, target)| {
            target
                .dirs
                .iter()
                .filter(|dir| dir.exists)
                .map(move |dir| (index, normalize_key(Path::new(&dir.path)), dir.size_bytes))
        })
        .collect();
    let mut contributions: Vec<(String, u64)> = Vec::new();
    for (index, key, size) in &listed {
        // 有祖先条目（含同目标父目录），其字节会由祖先的贡献覆盖。
        let covered = listed.iter().any(|(_, other_key, _)| {
            other_key.as_str() != key.as_str() && same_or_within(key, other_key)
        });
        if covered {
            continue;
        }
        // 条目 size 可能已排除同目标已单列的子树，加回这些后代条目还原完整目录大小。
        let descendants: u64 = listed
            .iter()
            .filter(|(other_index, other_key, _)| {
                other_index == index
                    && other_key.as_str() != key.as_str()
                    && same_or_within(other_key, key)
            })
            .map(|(_, _, descendant_size)| *descendant_size)
            .sum();
        let contribution = *size + descendants;
        match contributions
            .iter_mut()
            .find(|(existing, _)| *existing == *key)
        {
            Some((_, best)) => *best = (*best).max(contribution),
            None => contributions.push((key.clone(), contribution)),
        }
    }
    contributions.into_iter().map(|(_, bytes)| bytes).sum()
}

fn scan(previous: &HashMap<String, Vec<String>>) -> Result<ScanResult, String> {
    // 每个工具独立线程：命令探测与目录遍历互不等候。
    std::thread::scope(|scope| {
        let handles: Vec<_> = SPECS
            .iter()
            .map(|spec| {
                scope.spawn(|| {
                    resolve_target(spec, previous.get(spec.id).map(Vec::as_slice).unwrap_or(&[]))
                })
            })
            .collect();
        let targets: Vec<CacheTarget> = handles
            .into_iter()
            .map(|handle| {
                handle
                    .join()
                    .map_err(|_| "缓存扫描线程异常终止。".to_string())
            })
            .collect::<Result<_, _>>()?;
        Ok(ScanResult {
            union_bytes: union_total(&targets),
            targets,
        })
    })
}

#[tauri::command]
pub async fn scan_dev_caches(
    previous: Option<HashMap<String, Vec<String>>>,
) -> Result<ScanResult, String> {
    // 目录遍历是阻塞 IO，放到阻塞线程池执行以免卡住桌面 UI。
    tauri::async_runtime::spawn_blocking(move || scan(&previous.unwrap_or_default()))
        .await
        .map_err(|error| format!("缓存扫描任务失败：{error}"))?
}

// 通过工具自身的 CLI 把缓存目录写入其全局配置；只改动配置，不迁移或删除旧目录内容。
fn apply_cache_dir(id: &str, path: &str) -> Result<(), String> {
    let spec = SPECS
        .iter()
        .find(|spec| spec.id == id)
        .ok_or("未知的缓存目标。")?;
    let setter = match &spec.relocate {
        Some(Relocate::Command(setter)) => setter,
        _ => return Err("该工具不支持通过命令修改缓存目录。".into()),
    };
    let raw = path.trim();
    if raw.is_empty() || !Path::new(raw).is_absolute() {
        return Err("请输入新缓存目录的绝对路径。".into());
    }
    fs::create_dir_all(raw).map_err(|error| format!("无法创建目录 {raw}：{error}"))?;

    let has_placeholder = setter.args.iter().any(|arg| arg.contains("{path}"));
    let mut args: Vec<String> = setter
        .args
        .iter()
        .map(|arg| arg.replace("{path}", raw))
        .collect();
    if !has_placeholder {
        args.push(raw.to_string());
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();

    let mut failure: Option<String> = None;
    for program in setter.programs {
        for name in program_names(program) {
            match run_capture(&name, &arg_refs) {
                Ok(_) => return Ok(()),
                Err(CaptureError::NotFound) => continue,
                Err(CaptureError::Failed(error)) => {
                    failure.get_or_insert(error);
                }
            }
        }
    }
    Err(failure.unwrap_or_else(|| {
        format!(
            "未找到 {} 命令行，无法执行配置。",
            setter.programs.join(" / ")
        )
    }))
}

#[tauri::command]
pub async fn set_cache_dir(id: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || apply_cache_dir(&id, &path))
        .await
        .map_err(|error| format!("修改缓存目录任务失败：{error}"))?
}

// 在系统文件管理器中打开目录。走插件的 Rust API 而不是前端命令：
// opener 插件对 open_path 另有路径 scope 检查，缓存目录可能在任意盘符（如 E:\.pnpm-store），
// 这里只允许打开确实存在的目录，比配一个 ** 通配 scope 更收敛。
#[tauri::command]
pub fn open_cache_dir(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err("目录不存在或不是文件夹。".into());
    }
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|error| format!("无法打开目录：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_returns_all_targets() {
        let targets = scan(&HashMap::new()).unwrap().targets;
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
    fn set_cache_dir_validates_input() {
        assert!(apply_cache_dir("missing", "C:\\x").is_err());
        assert!(apply_cache_dir("npm", "relative/path").is_err());
        assert!(apply_cache_dir("npm", "").is_err());
        // deno 只能通过 DENO_DIR 环境变量调整，没有 CLI 配置命令。
        assert!(apply_cache_dir("deno", "C:\\x").is_err());
    }

    // 真实执行 npm config set 验证整条链路（.cmd shim → 写配置 → 探测生效）。
    // 结束或 panic 时通过 Drop 把 ~/.npmrc 恢复为执行前的字节内容。
    #[test]
    #[ignore = "会临时修改本机 npm 配置，需要验证修改链路时手动运行"]
    fn set_cache_dir_updates_npm_config() {
        let probe = Probe {
            program: "npm",
            args: &["config", "get", "cache"],
        };
        if probe_dir(&probe).is_none() {
            eprintln!("未检测到 npm，跳过");
            return;
        }
        let npmrc = home_dir().unwrap().join(".npmrc");
        let backup = fs::read(&npmrc).ok();
        struct Restore(PathBuf, Option<Vec<u8>>);
        impl Drop for Restore {
            fn drop(&mut self) {
                match &self.1 {
                    Some(content) => {
                        let _ = fs::write(&self.0, content);
                    }
                    None => {
                        let _ = fs::remove_file(&self.0);
                    }
                }
            }
        }
        let _restore = Restore(npmrc, backup);

        let target = std::env::temp_dir().join(format!("toolbox-npm-cache-{}", std::process::id()));
        apply_cache_dir("npm", &target.to_string_lossy()).unwrap();
        let probed = probe_dir(&probe).expect("修改后 npm config get cache 应返回路径");
        assert_eq!(normalize_key(&probed), normalize_key(&target));
        let _ = fs::remove_dir_all(&target);
    }

    fn dir(path: &str, size: u64) -> CacheDir {
        CacheDir {
            path: path.to_string(),
            source: "测试",
            // size 为 0 视为不存在，不参与合计。
            exists: size > 0,
            size_bytes: size,
            file_count: 0,
            error: None,
            nested: false,
        }
    }

    fn target(id: &'static str, dirs: Vec<CacheDir>) -> CacheTarget {
        CacheTarget {
            id,
            name: id,
            category: "",
            total_bytes: dirs.iter().map(|d| d.size_bytes).sum(),
            dirs,
            can_set: false,
            set_command: None,
            relocate_guide: None,
        }
    }

    #[test]
    fn union_total_dedupes_across_targets() {
        let base = if cfg!(windows) { "C:/x" } else { "/x" };
        let targets = vec![
            target("a", vec![dir(base, 15)]),
            // 与 a 相同的路径：只计一次。
            target("b", vec![dir(base, 15)]),
            // 被 a 的目录覆盖：大小已包含在 a 中。
            target("c", vec![dir(&format!("{base}/sub"), 5)]),
            target("d", vec![dir(if cfg!(windows) { "C:/other" } else { "/other" }, 7)]),
            // 不存在的目录不参与合计。
            target("e", vec![dir(if cfg!(windows) { "C:/missing" } else { "/missing" }, 0)]),
        ];
        assert_eq!(union_total(&targets), 22);
    }

    #[test]
    fn union_total_is_order_independent() {
        // A 目标把父目录和子目录分列（父目录大小已排除子目录），B 目标整体统计同一父目录。
        // 无论哪个目标在前，合计都应等于真实总量。
        let parent = if cfg!(windows) { "C:/x" } else { "/x" };
        let child = format!("{parent}/sub");
        let ab = vec![
            target("a", vec![dir(parent, 10), dir(&child, 5)]),
            target("b", vec![dir(parent, 15)]),
        ];
        let ba = vec![
            target("b", vec![dir(parent, 15)]),
            target("a", vec![dir(parent, 10), dir(&child, 5)]),
        ];
        assert_eq!(union_total(&ab), 15);
        assert_eq!(union_total(&ba), 15);
    }

    #[test]
    fn normalize_path_resolves_parent_segments() {
        let base = Path::new(if cfg!(windows) { "C:/a" } else { "/a" });
        let alias = base.join("child").join("..");
        // `a/child/..` 与 `a` 是同一目录，去重后不应重复统计。
        assert_eq!(normalize_key(&normalize_path(&alias)), normalize_key(&base));
    }

    #[test]
    fn same_or_within_covers_nested_paths() {
        let key = |p: &str| normalize_key(Path::new(p));
        assert!(same_or_within(&key("C:/a/b"), &key("C:/a")));
        assert!(same_or_within(&key("C:/a"), &key("C:/a")));
        // 前缀相同但不是目录边界的不算包含。
        assert!(!same_or_within(&key("C:/ab"), &key("C:/a")));
        assert!(!same_or_within(&key("C:/a"), &key("C:/a/b")));
        if cfg!(windows) {
            assert!(same_or_within(&key("c:\\a\\b"), &key("C:/A")));
        }
    }

    #[test]
    fn measure_dir_counts_nested_files() {
        let root = std::env::temp_dir().join(format!("toolbox-cache-test-{}", std::process::id()));
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("a.bin"), [0u8; 10]).unwrap();
        fs::write(root.join("sub/b.bin"), [0u8; 5]).unwrap();
        let (bytes, files, error) = measure_dir(&root, &[]);
        assert_eq!((bytes, files), (15, 2));
        assert!(error.is_none());
        // 排除已单列的子目录后，父目录只统计剩余部分。
        let (bytes, files, _) = measure_dir(&root, &[normalize_key(&root.join("sub"))]);
        fs::remove_dir_all(&root).unwrap();
        assert_eq!((bytes, files), (10, 1));
    }
}
