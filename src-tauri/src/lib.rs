mod modules;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            greet,
            modules::cache::scan_dev_caches,
            modules::cache::set_cache_dir,
            modules::cache::open_cache_dir,
            modules::cache::list_cache_targets,
            modules::ports::get_port_owner_details,
            modules::ports::list_port_owners,
            modules::ports::stop_port_owner
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
