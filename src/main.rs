#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod behavior_runner;
mod eth_can_bridge;
mod gamepad_service;
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

    // 待受アドレス: 認証のない API (Python コードの保存/実行を含む) を LAN に公開しないよう、
    // GUI モードは既定で 127.0.0.1 のみで待ち受ける。
    // ヘッドレス (ロボット搭載PCをスマホ等から操作する運用) は従来通り 0.0.0.0。
    // どちらも ALTAIR_BIND_ADDR で上書きできる
    let bind_ip: std::net::IpAddr = std::env::var("ALTAIR_BIND_ADDR")
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or_else(|| {
            if headless {
                std::net::IpAddr::from([0, 0, 0, 0])
            } else {
                std::net::IpAddr::from([127, 0, 0, 1])
            }
        });

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("Tokioランタイムの初期化に失敗しました");

    let app_state = rt
        .block_on(server::start_altair_server(bind_ip, port))
        .expect("Altair_module_system_control のバックエンドサーバー起動に失敗しました");

    if headless {
        println!(
            "Altair_module_system_control running in headless mode on http://127.0.0.1:{}",
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

