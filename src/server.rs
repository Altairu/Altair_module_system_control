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
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::broadcast;
use tower_http::services::ServeDir;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
use crate::behavior_runner::CREATE_NO_WINDOW;

// ビルド時にexeへ埋め込むUIファイル
const INDEX_HTML: &str = include_str!("../index.html");
const STYLES_CSS: &str = include_str!("../css/styles.css");
const APP_JS: &str = include_str!("../js/app.js");
const GAMEPAD_JS: &str = include_str!("../js/gamepad.js");
const BLOCKLY_JS: &str = include_str!("../js/vendor/blockly.min.js");
const BLOCKLY_PYTHON_JS: &str = include_str!("../js/vendor/python_compressed.js");
const BLOCKLY_JA_JS: &str = include_str!("../js/vendor/ja.js");

/// 埋め込みファイルをキャッシュ無効で返す
fn embedded_response(content_type: &'static str, body: &'static str) -> impl IntoResponse {
    (
        [
            (axum::http::header::CONTENT_TYPE, content_type),
            (axum::http::header::CACHE_CONTROL, "no-cache"),
        ],
        body,
    )
}

async fn serve_index_html() -> impl IntoResponse {
    // WebView2が古いjs/cssをキャッシュから使わないよう、中身のハッシュをURLに付けたindex.htmlを返す
    static INDEX_WITH_VERSION: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    let html = INDEX_WITH_VERSION.get_or_init(|| {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        STYLES_CSS.hash(&mut hasher);
        APP_JS.hash(&mut hasher);
        GAMEPAD_JS.hash(&mut hasher);
        let v = format!("{:x}", hasher.finish());
        INDEX_HTML
            .replace("/css/styles.css\"", &format!("/css/styles.css?v={}\"", v))
            .replace("/js/app.js\"", &format!("/js/app.js?v={}\"", v))
            .replace("/js/gamepad.js\"", &format!("/js/gamepad.js?v={}\"", v))
    });
    (
        [
            (axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (axum::http::header::CACHE_CONTROL, "no-cache"),
        ],
        html.as_str(),
    )
}

async fn serve_styles_css() -> impl IntoResponse {
    embedded_response("text/css; charset=utf-8", STYLES_CSS)
}

async fn serve_app_js() -> impl IntoResponse {
    embedded_response("application/javascript; charset=utf-8", APP_JS)
}

async fn serve_gamepad_js() -> impl IntoResponse {
    embedded_response("application/javascript; charset=utf-8", GAMEPAD_JS)
}

async fn serve_blockly_js() -> impl IntoResponse {
    embedded_response("application/javascript; charset=utf-8", BLOCKLY_JS)
}

async fn serve_blockly_python_js() -> impl IntoResponse {
    embedded_response("application/javascript; charset=utf-8", BLOCKLY_PYTHON_JS)
}

async fn serve_blockly_ja_js() -> impl IntoResponse {
    embedded_response("application/javascript; charset=utf-8", BLOCKLY_JA_JS)
}

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
    pub can_log_tx: broadcast::Sender<WsEvent>,
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

    let (ws_tx, _) = broadcast::channel::<WsEvent>(2048);
    let (can_log_tx, _) = broadcast::channel::<WsEvent>(2048);
    let (rx_tx, _) = broadcast::channel::<CanFrameEvent>(2048);

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
        let can_log_tx_clone = can_log_tx.clone();
        tokio::spawn(async move {
            while let Ok(frame) = rx_sub.recv().await {
                if frame.direction == "RX" {
                    mm.handle_can_rx(&frame);
                }

                // 5ms周期のテレメトリ (角度FB -> 速度FB -> ステータス) を間引かずリアルタイム配信
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
                let _ = can_log_tx_clone.send(WsEvent::RawCanFrame { data: log_line });
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

    // ネイティブゲームパッド監視サービスを起動 (50Hz バックグラウンド取得)
    {
        let gp_service = crate::gamepad_service::GamepadService::new();
        gp_service.start(ws_tx.clone());
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
        can_log_tx,
    };

    let app = Router::new()
        .route("/api/ports", get(api_ports))
        .route("/api/connect", post(api_connect_usb))
        .route("/api/eth_can/config", get(api_eth_config))
        .route("/api/eth_can/connect", post(api_eth_connect))
        .route("/api/eth_can/channel", post(api_eth_channel))
        .route("/api/eth_can/disconnect", post(api_eth_disconnect))
        .route("/api/start_control", post(api_start_control))
        .route("/api/behavior/start", post(api_behavior_start))
        .route("/api/behavior/stop", post(api_behavior_stop))
        .route("/api/behavior/save_blockly", post(api_save_blockly))
        .route("/api/behavior/list", get(api_behavior_list))
        .route("/api/behavior/open_folder", post(api_behavior_open_folder))
        .route("/api/behavior/create", post(api_behavior_create))
        .route("/api/behavior/delete", post(api_behavior_delete))
        .route(
            "/api/behavior/code",
            get(api_behavior_get_code).post(api_behavior_save_code),
        )
        .route("/api/behavior/open_vscode", post(api_behavior_open_vscode))
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
        .route("/api/system/restart", post(api_system_restart))
        .route("/api/system/uninstall", post(api_uninstall))
        .route("/api/system/emergency_stop", post(api_system_emergency_stop))
        .route("/api/open_url", post(api_open_url))
        .route("/ws", get(ws_handler))
        // UIファイルはexeに埋め込んで配信する
        // self_updateはexeしか置き換えないため、ディスク上のファイルを配信すると更新後も古い画面のままになる
        .route("/", get(serve_index_html))
        .route("/index.html", get(serve_index_html))
        .route("/css/styles.css", get(serve_styles_css))
        .route("/js/app.js", get(serve_app_js))
        .route("/js/gamepad.js", get(serve_gamepad_js))
        .route("/js/vendor/blockly.min.js", get(serve_blockly_js))
        .route("/js/vendor/python_compressed.js", get(serve_blockly_python_js))
        .route("/js/vendor/ja.js", get(serve_blockly_ja_js))
        .nest_service("/docs", ServeDir::new(project_root.join("docs")))
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
    can_channel: Option<String>,
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

    let (_, _, current_ch) = state.eth_bridge.get_config();
    let ch = req
        .can_channel
        .map(|c| state.eth_bridge.set_can_channel(c))
        .unwrap_or(current_ch);

    let net_cfg = NetworkConfig {
        target_ip: ip.clone(),
        target_port: port,
        can_channel: ch.clone(),
    };
    if let Ok(s) = serde_json::to_string_pretty(&net_cfg) {
        let _ = fs::write(&state.network_config_path, s);
    }

    state.usb_bridge.disconnect();
    *state.active_mode.lock().unwrap() = "eth".to_string();

    let eth = state.eth_bridge.clone();
    let res = tokio::task::spawn_blocking(move || eth.connect(ip, port, Some(ch)))
        .await
        .unwrap_or_else(|e| Err(format!("スレッドエラー: {}", e)));

    match res {
        Ok(msg) => Json(json!({ "success": true, "message": msg })),
        Err(err) => Json(json!({ "success": false, "message": err })),
    }
}

#[derive(Deserialize)]
struct SetEthChannelReq {
    can_channel: String,
}

async fn api_eth_channel(
    State(state): State<AppState>,
    Json(req): Json<SetEthChannelReq>,
) -> impl IntoResponse {
    let ch = state.eth_bridge.set_can_channel(req.can_channel);
    let (ip, port, _) = state.eth_bridge.get_config();
    let net_cfg = NetworkConfig {
        target_ip: ip,
        target_port: port,
        can_channel: ch.clone(),
    };
    if let Ok(s) = serde_json::to_string_pretty(&net_cfg) {
        let _ = fs::write(&state.network_config_path, s);
    }
    let ch_label = match ch.as_str() {
        "can2" => "CAN2",
        "both" => "CAN1 + CAN2",
        _ => "CAN1",
    };
    Json(json!({
        "success": true,
        "can_channel": ch,
        "message": format!("Ethernet-CAN の使用チャンネルを {} に設定しました。", ch_label)
    }))
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
    state.module_manager.resume_control_if_ready();
    match state.behavior_runner.start_behavior(&req.behavior_name) {
        Ok(msg) => Json(json!({ "success": true, "message": msg })),
        Err(err) => Json(json!({ "success": false, "message": err })),
    }
}

async fn api_behavior_stop(State(state): State<AppState>) -> impl IntoResponse {
    let msg = state.behavior_runner.stop_behavior();
    state.module_manager.stop_modules_keep_running();
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

async fn api_behavior_open_folder(State(state): State<AppState>) -> impl IntoResponse {
    let dir = state.behavior_runner.get_behaviors_dir();
    let path_str = dir.to_string_lossy().to_string();

    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("explorer")
            .arg(&path_str)
            .spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open")
            .arg(&path_str)
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open")
            .arg(&path_str)
            .spawn();
    }

    Json(json!({
        "success": true,
        "message": format!("フォルダーを開きました: {}", path_str)
    }))
}

#[derive(Deserialize)]
struct BehaviorNameReq {
    name: String,
}

async fn api_behavior_create(
    State(state): State<AppState>,
    Json(req): Json<BehaviorNameReq>,
) -> impl IntoResponse {
    match state.behavior_runner.create_behavior_file(&req.name) {
        Ok((fname, code)) => (
            StatusCode::OK,
            Json(json!({
                "success": true,
                "name": fname,
                "code": code,
                "message": format!("新規スクリプト '{}' を作成しました。", fname)
            })),
        ),
        Err(err) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "message": err })),
        ),
    }
}

async fn api_behavior_delete(
    State(state): State<AppState>,
    Json(req): Json<BehaviorNameReq>,
) -> impl IntoResponse {
    match state.behavior_runner.delete_behavior_file(&req.name) {
        Ok(fname) => (
            StatusCode::OK,
            Json(json!({
                "success": true,
                "name": fname,
                "message": format!("スクリプト '{}' を削除しました。", fname)
            })),
        ),
        Err(err) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "message": err })),
        ),
    }
}

#[derive(Deserialize)]
struct GetBehaviorCodeQuery {
    #[serde(default)]
    name: String,
}

#[derive(Deserialize)]
struct SaveBehaviorCodeReq {
    name: String,
    code: String,
}

#[derive(Deserialize)]
struct OpenVscodeReq {
    name: String,
    #[serde(default)]
    line: Option<usize>,
}

async fn api_behavior_get_code(
    State(state): State<AppState>,
    axum::extract::Query(q): axum::extract::Query<GetBehaviorCodeQuery>,
) -> impl IntoResponse {
    match state.behavior_runner.get_behavior_code(&q.name) {
        Ok(code) => (
            StatusCode::OK,
            Json(json!({ "success": true, "name": q.name, "code": code })),
        ),
        Err(err) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "message": err })),
        ),
    }
}

async fn api_behavior_save_code(
    State(state): State<AppState>,
    Json(req): Json<SaveBehaviorCodeReq>,
) -> impl IntoResponse {
    match state.behavior_runner.save_behavior_code(&req.name, &req.code) {
        Ok(_) => (
            StatusCode::OK,
            Json(json!({
                "success": true,
                "message": format!("スクリプト '{}' を保存しました。", req.name)
            })),
        ),
        Err(err) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "message": err })),
        ),
    }
}

async fn api_behavior_open_vscode(
    State(state): State<AppState>,
    Json(req): Json<OpenVscodeReq>,
) -> impl IntoResponse {
    let script_path = state.behavior_runner.get_behaviors_dir().join(&req.name);
    let target = if let Some(line) = req.line {
        format!("{}:{}", script_path.to_string_lossy(), line)
    } else {
        script_path.to_string_lossy().to_string()
    };

    let mut cmd = Command::new("cmd");
    cmd.args(&["/c", "code", "-g", &target]);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    match cmd.spawn() {
        Ok(_) => Json(json!({
            "success": true,
            "message": format!("VSCodeで開きました: {}", target)
        })),
        Err(e) => Json(json!({
            "success": false,
            "message": format!("VSCodeの起動に失敗しました: {}", e)
        })),
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
    if safe_name.is_empty() || safe_name.contains("..") {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "detail": "不正なプロファイル名です。" })),
        );
    }
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
    if safe_name.is_empty() || safe_name.contains("..") {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "detail": "不正なプロファイル名です。" })),
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
    if safe_name.is_empty() || safe_name.contains("..") {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "detail": "不正なプロファイル名です。" })),
        );
    }
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

async fn api_update_apply(State(state): State<AppState>) -> impl IntoResponse {
    let _ = state.ws_tx.send(WsEvent::BehaviorLog {
        data: "[UPDATE] 最新リリースのダウンロードおよび適用を開始しました...".to_string(),
    });

    let res = tokio::task::spawn_blocking(updater::apply_github_update)
        .await
        .unwrap_or_else(|e| Err(format!("スレッドエラー: {}", e)));

    match res {
        Ok(info) => {
            let _ = state.ws_tx.send(WsEvent::BehaviorLog {
                data: format!("[UPDATE] {}", info.message),
            });
            Json(json!({
                "success": true,
                "updated": info.updated,
                "version": info.version,
                "message": info.message
            }))
        }
        Err(err) => {
            let _ = state.ws_tx.send(WsEvent::BehaviorLog {
                data: format!("[ERROR] アップデート失敗: {}", err),
            });
            Json(json!({
                "success": false,
                "updated": false,
                "version": "",
                "message": err
            }))
        }
    }
}

/// 実行中のアプリケーションプロセスを再起動する
fn restart_current_process() -> Result<(), String> {
    let current_exe = std::env::current_exe()
        .map_err(|e| format!("実行中プロセスのパス取得に失敗しました: {}", e))?;
    let args: Vec<String> = std::env::args().skip(1).collect();

    #[cfg(target_os = "windows")]
    {
        let exe_path = current_exe.to_string_lossy().to_string();
        let arg_str = if args.is_empty() {
            String::new()
        } else {
            let escaped_args: Vec<String> = args
                .iter()
                .map(|a| format!("'{}'", a.replace('\'', "''")))
                .collect();
            format!(" -ArgumentList {}", escaped_args.join(","))
        };
        // PowerShellのシングルクォートでパスを囲み、cmd.exe由来のバックスラッシュ誤認識やstartコマンドのエラーを完全に防ぐ
        let ps_script = format!(
            "Start-Sleep -Milliseconds 800; Start-Process -FilePath '{}'{}",
            exe_path.replace('\'', "''"),
            arg_str
        );

        let mut cmd = Command::new("powershell");
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            &ps_script,
        ]);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.spawn()
            .map_err(|e| format!("再起動プロセスの起動に失敗しました: {}", e))?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        let mut cmd = Command::new(&current_exe);
        cmd.args(&args);
        cmd.spawn()
            .map_err(|e| format!("再起動プロセスの起動に失敗しました: {}", e))?;
    }

    tokio::spawn(async {
        tokio::time::sleep(Duration::from_millis(500)).await;
        std::process::exit(0);
    });

    Ok(())
}

async fn api_system_restart() -> impl IntoResponse {
    match restart_current_process() {
        Ok(_) => (
            StatusCode::OK,
            Json(json!({
                "success": true,
                "message": "再起動を開始しました。"
            })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({
                "success": false,
                "message": e
            })),
        ),
    }
}

async fn api_system_emergency_stop(State(state): State<AppState>) -> impl IntoResponse {
    let _ = state.behavior_runner.stop_behavior();
    state.module_manager.emergency_stop_all();
    Json(json!({
        "success": true,
        "message": "全モータおよびプログラムを非常停止しました。"
    }))
}

async fn api_uninstall() -> impl IntoResponse {
    let root = resolve_project_root();
    let uninstaller = root.join("unins000.exe");
    if uninstaller.exists() {
        let spawn_res = std::process::Command::new(&uninstaller).spawn();
        match spawn_res {
            Ok(_) => (
                StatusCode::OK,
                Json(json!({
                    "success": true,
                    "message": "アンインストーラーを起動しました。画面の指示に従って操作してください。"
                })),
            ),
            Err(e) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({
                    "success": false,
                    "message": format!("アンインストーラーの起動に失敗しました: {}", e)
                })),
            ),
        }
    } else {
        (
            StatusCode::NOT_FOUND,
            Json(json!({
                "success": false,
                "message": "インストーラー形式でインストールされた環境 (unins000.exe) が見つかりませんでした。Windowsの「設定」>「インストールされているアプリ」を確認してください。"
            })),
        )
    }
}

#[derive(Deserialize)]
struct OpenUrlReq {
    url: String,
}

async fn api_open_url(Json(req): Json<OpenUrlReq>) -> impl IntoResponse {
    let url = req.url.trim().to_string();
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Json(json!({ "success": false, "message": "無効なURLです。" }));
    }

    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open").arg(&url).spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(&url).spawn();
    }

    Json(json!({ "success": true }))
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(params): Query<HashMap<String, String>>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    let filter = params.get("filter").cloned().unwrap_or_default();
    ws.on_upgrade(move |socket| handle_ws_client(socket, state, filter))
}

async fn handle_ws_client(socket: WebSocket, state: AppState, filter: String) {
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
        let is_behavior = filter == "behavior";
        let mut last_mdd_feedback_sent = tokio::time::Instant::now();

        if is_behavior {
            // Python Behavior クライアント: 生CANログは購読せず、制御/ゲームパッド/フィードバックのみを超低遅延で配信
            loop {
                let ev = match rx.recv().await {
                    Ok(ev) => ev,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                };
                match &ev {
                    WsEvent::RawCanFrame { .. } => continue,
                    WsEvent::MddFeedback { .. } => {
                        // Python Behavior への MddFeedback 送信を最大 20Hz (50ms) にスロットリング
                        if last_mdd_feedback_sent.elapsed() < Duration::from_millis(50) {
                            continue;
                        }
                        last_mdd_feedback_sent = tokio::time::Instant::now();
                    }
                    _ => {}
                }
                if let Ok(txt) = serde_json::to_string(&ev) {
                    if sender.send(Message::Text(txt)).await.is_err() {
                        break;
                    }
                }
            }
        } else {
            // WebUI クライアント: 制御イベントと生CANログの両方を配信
            let mut can_rx = state.can_log_tx.subscribe();
            loop {
                tokio::select! {
                    res = rx.recv() => {
                        let ev = match res {
                            Ok(ev) => ev,
                            Err(broadcast::error::RecvError::Lagged(_)) => continue,
                            Err(broadcast::error::RecvError::Closed) => break,
                        };
                        if let Ok(txt) = serde_json::to_string(&ev) {
                            if sender.send(Message::Text(txt)).await.is_err() {
                                break;
                            }
                        }
                    }
                    res = can_rx.recv() => {
                        let ev = match res {
                            Ok(ev) => ev,
                            Err(broadcast::error::RecvError::Lagged(_)) => continue,
                            Err(broadcast::error::RecvError::Closed) => break,
                        };
                        if let Ok(txt) = serde_json::to_string(&ev) {
                            if sender.send(Message::Text(txt)).await.is_err() {
                                break;
                            }
                        }
                    }
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
                    "gamepad_input" | "gamepad_state" => {
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

