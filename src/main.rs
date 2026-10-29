#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod behavior_runner;
mod eth_can_bridge;
mod module_manager;
mod server;
mod types;
mod updater;
mod usb_can_bridge;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let headless = args.iter().any(|a| a == "--server" || a == "--headless");
    let port: u16 = std::env::var("ALTAIR_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8000);

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("Tokioランタイムの初期化に失敗しました");

    let app_state = rt
        .block_on(server::start_altair_server(port))
        .expect("Altairバックエンドサーバーの起動に失敗しました");

    if headless {
        println!(
            "Altair Control Server running in headless mode on http://127.0.0.1:{}",
            port
        );
        rt.block_on(async {
            let _ = tokio::signal::ctrl_c().await;
        });
        app_state.behavior_runner.stop_behavior();
        return;
    }

    let runner_for_exit = app_state.behavior_runner.clone();

    tauri::Builder::default()
        .build(tauri::generate_context!())
        .expect("Tauriアプリケーションの初期化に失敗しました")
        .run(move |_app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                runner_for_exit.stop_behavior();
            }
        });
}

