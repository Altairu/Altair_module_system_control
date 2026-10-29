use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::broadcast;
use tower_http::services::{ServeDir, ServeFile};

use crate::behavior_runner::BehaviorRunner;
use crate::eth_can_bridge::EthCanBridge;
use crate::module_manager::ModuleManager;
use crate::types::{CanFrameEvent, ModulesConfigFile, NetworkConfig, WsEvent};
use crate::updater;
use crate::usb_can_bridge::UsbCanBridge;

#[derive(Clone)]
pub struct AppState {
    pub profiles_dir: PathBuf,
    pub network_config_path: PathBuf,
    pub active_mode: Arc<Mutex<String>>,
    pub eth_bridge: EthCanBridge,
    pub usb_bridge: UsbCanBridge,
    pub module_manager: ModuleManager,
    pub behavior_runner: BehaviorRunner,
    pub ws_tx: broadcast::Sender<WsEvent>,
}

/// 実行ファイルまたはカレントディレクトリからプロジェクトルートを自動検出
pub fn resolve_project_root() -> PathBuf {
    if let Ok(cwd) = std::env::current_dir() {
        if cwd.join("index.html").exists() {
            return cwd;
        }
    }
    if let Ok(exe_path) = std::env::current_exe() {
        let mut dir = exe_path.parent().map(|p| p.to_path_buf());
        while let Some(d) = dir {
            if d.join("index.html").exists() {
                return d;
            }
            dir = d.parent().map(|p| p.to_path_buf());
        }
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

/// HTTP REST API + WebSocket サーバーを起動
pub async fn start_altair_server(port: u16) -> Result<AppState, String> {
    let project_root = resolve_project_root();
    let config_path = project_root.join("config").join("modules_config.json");
    let profiles_dir = project_root.join("profiles");
    let network_config_path = project_root.join("network_config.json");

    let _ = fs::create_dir_all(project_root.join("config"));
    let _ = fs::create_dir_all(&profiles_dir);

    let net_cfg: NetworkConfig = if network_config_path.exists() {
        fs::read_to_string(&network_config_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    } else {
        NetworkConfig::default()
    };

    let (ws_tx, _) = broadcast::channel::<WsEvent>(512);
    let (rx_tx, _) = broadcast::channel::<CanFrameEvent>(1024);

    let active_mode = Arc::new(Mutex::new("eth".to_string()));

    let eth_bridge = EthCanBridge::new(
        net_cfg.target_ip,
        net_cfg.target_port,
        net_cfg.can_channel,
        ws_tx.clone(),
        rx_tx.clone(),
    );
    let usb_bridge = UsbCanBridge::new(ws_tx.clone(), rx_tx.clone());

    let eth_for_send = eth_bridge.clone();
    let usb_for_send = usb_bridge.clone();
    let mode_for_send = active_mode.clone();

    let send_can_fn = Arc::new(move |id: u16, data: &[u8], channel: &str| {
        let mode = mode_for_send.lock().unwrap().clone();
        if mode == "usb" {
            usb_for_send.send_can_frame(id, data);
        } else {
            eth_for_send.send_can_frame(id, data, channel);
        }
    });

    let module_manager = ModuleManager::new(config_path.clone(), send_can_fn, ws_tx.clone());
    let behavior_runner = BehaviorRunner::new(
        project_root.clone(),
        config_path.clone(),
        port,
        ws_tx.clone(),
    );

    // CAN RX/TX イベント購読タスク (ModuleManager への通知 + WebUI CANログ配信)
    {
        let mut rx_sub = rx_tx.subscribe();
        let mm = module_manager.clone();
        let ws_tx_clone = ws_tx.clone();
        tokio::spawn(async move {
            let mut last_log_time = Instant::now() - Duration::from_secs(1);
            while let Ok(frame) = rx_sub.recv().await {
                if frame.direction == "RX" {
                    mm.handle_can_rx(&frame);
                }

                let is_config = frame.id >= 0x200 && (frame.id & 0xFF) < 0x20;
                if is_config || last_log_time.elapsed() >= Duration::from_millis(40) {
                    last_log_time = Instant::now();
                    let data_hex: Vec<String> = frame
                        .data
                        .iter()
                        .map(|b| format!("{:02X}", b))
                        .collect();
                    let log_line = format!(
                        "[{}] ({}) ID: 0x{:03X} [{}] {}",
                        frame.direction,
                        frame.channel,
                        frame.id,
                        frame.dlc,
                        data_hex.join(" ")
                    );
                    let _ = ws_tx_clone.send(WsEvent::RawCanFrame { data: log_line });
                }
            }
        });
    }

    // 1Hz ステータス定期配信タスク
    {
        let eth_b = eth_bridge.clone();
        let usb_b = usb_bridge.clone();
        let mode_c = active_mode.clone();
        let br = behavior_runner.clone();
        let ws_tx_clone = ws_tx.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(1));
            loop {
                interval.tick().await;
                let mode = mode_c.lock().unwrap().clone();
                let can_st = if mode == "usb" {
                    usb_b.get_status()
                } else {
                    eth_b.get_status()
                };
                let _ = ws_tx_clone.send(WsEvent::CanStatus { data: can_st });
                let _ = ws_tx_clone.send(WsEvent::BehaviorStatus {
                    data: br.get_status_string(),
                });
            }
        });
    }

    // 起動時にバックグラウンドで GitHub Releases の新バージョン有無をチェック
    {
        let ws_tx_clone = ws_tx.clone();
        tokio::task::spawn_blocking(move || {
            let res = updater::check_github_update();
            if res.update_available {
                let _ = ws_tx_clone.send(WsEvent::BehaviorLog {
                    data: format!("[UPDATE] {}", res.message),
                });
            }
        });
    }

    let state = AppState {
        profiles_dir,
        network_config_path,
        active_mode,
        eth_bridge,
        usb_bridge,
        module_manager,
        behavior_runner,
        ws_tx,
    };

    let app = Router::new()
        .route("/api/ports", get(api_ports))
        .route("/api/connect", post(api_connect_usb))
        .route("/api/eth_can/config", get(api_eth_config))
        .route("/api/eth_can/connect", post(api_eth_connect))
        .route("/api/eth_can/disconnect", post(api_eth_disconnect))
        .route("/api/start_control", post(api_start_control))
        .route("/api/behavior/start", post(api_behavior_start))
        .route("/api/behavior/stop", post(api_behavior_stop))
        .route("/api/behavior/save_blockly", post(api_save_blockly))
        .route("/api/behavior/list", get(api_behavior_list))
        .route(
            "/api/behavior/get_blockly_workspace",
            get(api_get_blockly_workspace),
        )
        .route("/api/profiles", get(api_profiles_list))
        .route("/api/profiles/load", post(api_profiles_load))
        .route("/api/profiles/save", post(api_profiles_save))
        .route("/api/profiles/delete", post(api_profiles_delete))
        .route("/api/config", get(api_get_config))
        .route("/api/config/update", post(api_update_config))
        .route("/api/update/check", get(api_update_check))
        .route("/api/update/apply", post(api_update_apply))
        .route("/ws", get(ws_handler))
        .nest_service("/css", ServeDir::new(project_root.join("css")))
        .nest_service("/js", ServeDir::new(project_root.join("js")))
        .nest_service("/docs", ServeDir::new(project_root.join("docs")))
        .route_service("/", ServeFile::new(project_root.join("index.html")))
        .with_state(state.clone());

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("ポート {} のバインドに失敗しました: {}", port, e))?;

    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    Ok(state)
}

async fn api_ports() -> impl IntoResponse {
    let ports = UsbCanBridge::get_available_ports();
    Json(json!({ "ports": ports }))
}

#[derive(Deserialize)]
struct ConnectUsbReq {
    #[serde(default)]
    port: String,
    #[serde(default)]
    auto_connect: bool,
}

async fn api_connect_usb(
    State(state): State<AppState>,
    Json(req): Json<ConnectUsbReq>,
) -> impl IntoResponse {
    if req.port.trim().is_empty() && !req.auto_connect {
        state.usb_bridge.disconnect();
        return Json(json!({
            "success": true,
            "message": "USB-CAN を切断しました。"
        }));
    }

    state.eth_bridge.disconnect();
    *state.active_mode.lock().unwrap() = "usb".to_string();

    let port = req.port.clone();
    let auto = req.auto_connect;
    let usb = state.usb_bridge.clone();

    let res = tokio::task::spawn_blocking(move || usb.connect(port, auto))
        .await
        .unwrap_or_else(|e| Err(format!("スレッドエラー: {}", e)));

    match res {
        Ok(msg) => Json(json!({ "success": true, "message": msg })),
        Err(err) => Json(json!({ "success": false, "message": err })),
    }
}

async fn api_eth_config(State(state): State<AppState>) -> impl IntoResponse {
    let (ip, port, ch) = state.eth_bridge.get_config();
    Json(json!({
        "target_ip": ip,
        "target_port": port,
        "can_channel": ch
    }))
}

#[derive(Deserialize)]
struct ConnectEthReq {
    target_ip: Option<String>,
    target_port: Option<u16>,
}

async fn api_eth_connect(
    State(state): State<AppState>,
    Json(req): Json<ConnectEthReq>,
) -> impl IntoResponse {
    let ip = req
        .target_ip
        .unwrap_or_else(|| "192.168.2.123".to_string())
        .trim()
        .to_string();
    let port = req.target_port.unwrap_or(5000);

    let (_, _, ch) = state.eth_bridge.get_config();
    let net_cfg = NetworkConfig {
        target_ip: ip.clone(),
        target_port: port,
        can_channel: ch,
    };
    if let Ok(s) = serde_json::to_string_pretty(&net_cfg) {
        let _ = fs::write(&state.network_config_path, s);
    }

    state.usb_bridge.disconnect();
    *state.active_mode.lock().unwrap() = "eth".to_string();

    let eth = state.eth_bridge.clone();
    let res = tokio::task::spawn_blocking(move || eth.connect(ip, port))
        .await
        .unwrap_or_else(|e| Err(format!("スレッドエラー: {}", e)));

    match res {
        Ok(msg) => Json(json!({ "success": true, "message": msg })),
        Err(err) => Json(json!({ "success": false, "message": err })),
    }
}

async fn api_eth_disconnect(State(state): State<AppState>) -> impl IntoResponse {
    state.eth_bridge.disconnect();
    Json(json!({
        "success": true,
        "message": "Ethernet-CAN の接続を切断しました。"
    }))
}

async fn api_start_control(State(state): State<AppState>) -> impl IntoResponse {
    match state.module_manager.start_control().await {
        Ok(msg) => Json(json!({ "success": true, "message": msg })),
        Err(err) => Json(json!({ "success": false, "message": err })),
    }
}

#[derive(Deserialize)]
struct BehaviorStartReq {
    behavior_name: String,
}

async fn api_behavior_start(
    State(state): State<AppState>,
    Json(req): Json<BehaviorStartReq>,
) -> impl IntoResponse {
    match state.behavior_runner.start_behavior(&req.behavior_name) {
        Ok(msg) => Json(json!({ "success": true, "message": msg })),
        Err(err) => Json(json!({ "success": false, "message": err })),
    }
}

async fn api_behavior_stop(State(state): State<AppState>) -> impl IntoResponse {
    let msg = state.behavior_runner.stop_behavior();
    state.module_manager.emergency_stop_all();
    Json(json!({ "success": true, "message": msg }))
}

#[derive(Deserialize)]
struct SaveBlocklyReq {
    #[serde(default)]
    code: String,
    #[serde(default)]
    xml: String,
}

async fn api_save_blockly(
    State(state): State<AppState>,
    Json(req): Json<SaveBlocklyReq>,
) -> impl IntoResponse {
    match state.behavior_runner.save_blockly(&req.code, &req.xml) {
        Ok(msg) => (
            StatusCode::OK,
            Json(json!({ "success": true, "message": msg })),
        ),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "message": err })),
        ),
    }
}

async fn api_behavior_list(State(state): State<AppState>) -> impl IntoResponse {
    match state.behavior_runner.list_behaviors() {
        Ok(list) => Json(json!({ "success": true, "behaviors": list })),
        Err(err) => Json(json!({ "success": false, "behaviors": [], "error": err })),
    }
}

async fn api_get_blockly_workspace(State(state): State<AppState>) -> impl IntoResponse {
    let xml = state.behavior_runner.get_blockly_workspace();
    Json(json!({ "success": true, "xml": xml }))
}

async fn api_profiles_list(State(state): State<AppState>) -> impl IntoResponse {
    let mut profiles = Vec::new();
    if let Ok(entries) = fs::read_dir(&state.profiles_dir) {
        for entry in entries.flatten() {
            let fname = entry.file_name().to_string_lossy().to_string();
            if let Some(stem) = fname.strip_suffix(".json") {
                profiles.push(stem.to_string());
            }
        }
    }
    profiles.sort();
    Json(json!({ "profiles": profiles }))
}

async fn api_profiles_load(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let name = params.get("name").cloned().unwrap_or_default();
    let safe_name = PathBuf::from(&name)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let src = state.profiles_dir.join(format!("{}.json", safe_name));
    if !src.exists() {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "success": false, "detail": "プロファイルが見つかりません。" })),
        );
    }

    match fs::read_to_string(&src)
        .map_err(|e| e.to_string())
        .and_then(|s| serde_json::from_str::<ModulesConfigFile>(&s).map_err(|e| e.to_string()))
        .and_then(|cfg| state.module_manager.update_config(cfg))
    {
        Ok(_) => (
            StatusCode::OK,
            Json(json!({
                "success": true,
                "message": format!("プロファイル '{}' を正常に適用しました。", safe_name)
            })),
        ),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "detail": err })),
        ),
    }
}

async fn api_profiles_save(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let name = params.get("name").cloned().unwrap_or_default();
    let safe_name = PathBuf::from(&name)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    if safe_name.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "detail": "プロファイル名が空です。" })),
        );
    }

    let dst = state.profiles_dir.join(format!("{}.json", safe_name));
    let cfg = state.module_manager.get_config();
    match serde_json::to_string_pretty(&cfg)
        .map_err(|e| e.to_string())
        .and_then(|s| fs::write(&dst, s).map_err(|e| e.to_string()))
    {
        Ok(_) => (
            StatusCode::OK,
            Json(json!({
                "success": true,
                "message": format!("プロファイル '{}' を保存しました。", safe_name)
            })),
        ),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "detail": err })),
        ),
    }
}

async fn api_profiles_delete(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let name = params.get("name").cloned().unwrap_or_default();
    let safe_name = PathBuf::from(&name)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let target = state.profiles_dir.join(format!("{}.json", safe_name));
    if !target.exists() {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "success": false, "detail": "削除対象のプロファイルが見つかりません。" })),
        );
    }
    match fs::remove_file(&target) {
        Ok(_) => (
            StatusCode::OK,
            Json(json!({
                "success": true,
                "message": format!("プロファイル '{}' を削除しました。", safe_name)
            })),
        ),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "detail": err.to_string() })),
        ),
    }
}

async fn api_get_config(State(state): State<AppState>) -> impl IntoResponse {
    Json(state.module_manager.get_config())
}

async fn api_update_config(
    State(state): State<AppState>,
    Json(cfg): Json<ModulesConfigFile>,
) -> impl IntoResponse {
    match state.module_manager.update_config(cfg) {
        Ok(_) => (
            StatusCode::OK,
            Json(json!({ "success": true, "message": "設定を更新しました。" })),
        ),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "message": err })),
        ),
    }
}

async fn api_update_check() -> impl IntoResponse {
    let res = tokio::task::spawn_blocking(updater::check_github_update)
        .await
        .unwrap_or_else(|e| updater::UpdateCheckResult {
            current_version: env!("CARGO_PKG_VERSION").to_string(),
            latest_version: env!("CARGO_PKG_VERSION").to_string(),
            update_available: false,
            release_notes: String::new(),
            message: format!("チェック失敗: {}", e),
        });
    Json(res)
}

async fn api_update_apply() -> impl IntoResponse {
    let res = tokio::task::spawn_blocking(updater::apply_github_update)
        .await
        .unwrap_or_else(|e| Err(format!("スレッドエラー: {}", e)));

    match res {
        Ok(msg) => Json(json!({ "success": true, "message": msg })),
        Err(err) => Json(json!({ "success": false, "message": err })),
    }
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws_client(socket, state))
}

async fn handle_ws_client(socket: WebSocket, state: AppState) {
    let (mut sender, mut receiver) = socket.split();
    let mut rx = state.ws_tx.subscribe();

    // 初回接続時に現在のCANステータスとBehaviorステータスを送信
    {
        let mode = state.active_mode.lock().unwrap().clone();
        let can_st = if mode == "usb" {
            state.usb_bridge.get_status()
        } else {
            state.eth_bridge.get_status()
        };
        if let Ok(txt) = serde_json::to_string(&WsEvent::CanStatus { data: can_st }) {
            let _ = sender.send(Message::Text(txt)).await;
        }
        if let Ok(txt) = serde_json::to_string(&WsEvent::BehaviorStatus {
            data: state.behavior_runner.get_status_string(),
        }) {
            let _ = sender.send(Message::Text(txt)).await;
        }
    }

    let send_task = tokio::spawn(async move {
        while let Ok(ev) = rx.recv().await {
            if let Ok(txt) = serde_json::to_string(&ev) {
                if sender.send(Message::Text(txt)).await.is_err() {
                    break;
                }
            }
        }
    });

    let mm = state.module_manager.clone();
    let ws_tx = state.ws_tx.clone();

    while let Some(Ok(msg)) = receiver.next().await {
        if let Message::Text(text) = msg {
            if let Ok(val) = serde_json::from_str::<Value>(&text) {
                let msg_type = val.get("type").and_then(|v| v.as_str()).unwrap_or("");
                match msg_type {
                    "mdd_cmd" => {
                        let name = val.get("name").and_then(|v| v.as_str()).unwrap_or("");
                        if let Some(arr) = val.get("targets").and_then(|v| v.as_array()) {
                            let targets: Vec<f64> =
                                arr.iter().map(|x| x.as_f64().unwrap_or(0.0)).collect();
                            mm.set_mdd_command(name, &targets);
                        }
                    }
                    "servo_cmd" => {
                        let name = val.get("name").and_then(|v| v.as_str()).unwrap_or("");
                        if let Some(arr) = val.get("angles").and_then(|v| v.as_array()) {
                            let angles: Vec<f64> =
                                arr.iter().map(|x| x.as_f64().unwrap_or(90.0)).collect();
                            mm.set_servo_command(name, &angles);
                        }
                    }
                    "solenoid_cmd" => {
                        let name = val.get("name").and_then(|v| v.as_str()).unwrap_or("");
                        if let Some(arr) = val.get("valves").and_then(|v| v.as_array()) {
                            let valves: Vec<bool> =
                                arr.iter().map(|x| x.as_bool().unwrap_or(false)).collect();
                            mm.set_solenoid_command(name, &valves);
                        }
                    }
                    "gamepad_input" => {
                        let buttons: Vec<bool> = val
                            .get("buttons")
                            .and_then(|v| v.as_array())
                            .map(|a| a.iter().map(|x| x.as_bool().unwrap_or(false)).collect())
                            .unwrap_or_default();
                        let axes: Vec<f64> = val
                            .get("axes")
                            .and_then(|v| v.as_array())
                            .map(|a| a.iter().map(|x| x.as_f64().unwrap_or(0.0)).collect())
                            .unwrap_or_default();

                        // Python Behavior などの他クライアントへゲームパッド入力を転送
                        let _ = ws_tx.send(WsEvent::GamepadInput { buttons, axes });
                    }
                    _ => {}
                }
            }
        }
    }

    send_task.abort();
}

