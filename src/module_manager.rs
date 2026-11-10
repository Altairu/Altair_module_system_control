use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::broadcast;

use crate::types::{CanFrameEvent, MddFeedbackData, ModulesConfigFile, MotorParam, WsEvent};

#[cfg(target_os = "windows")]
#[link(name = "winmm")]
extern "system" {
    fn timeBeginPeriod(uPeriod: u32) -> u32;
}

fn encode_int16_le(val: f64) -> [u8; 2] {
    let clamped = val.round().clamp(-32768.0, 32767.0) as i16;
    clamped.to_le_bytes()
}

fn decode_int16_le(lo: u8, hi: u8) -> i16 {
    i16::from_le_bytes([lo, hi])
}

pub fn parse_hex_id(s: &str) -> Option<u16> {
    let trimmed = s.trim();
    let hex_part = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
        .unwrap_or(trimmed);
    u16::from_str_radix(hex_part, 16).ok()
}

struct ManagerInner {
    config: ModulesConfigFile,
    mdd_targets: HashMap<String, [f64; 4]>,
    servo_angles: HashMap<String, [u8; 6]>,
    solenoid_valves: HashMap<String, [bool; 12]>,
    mdd_feedback_cache: HashMap<u16, MddFeedbackData>,
    mdd_param_sent_at: HashMap<u16, Instant>,
    mdd_param_confirmed: HashMap<u16, bool>,
    mdd_zero_status_count: HashMap<u16, u32>,
    send_session_id: u64,
    is_running: bool,
    is_sending_params: bool,
}

/// Altair Module Manager
/// altair_framework の module_manager.py と同一の100Hz制御ループ・パラメータ送信・テレメトリ解析を提供
#[derive(Clone)]
pub struct ModuleManager {
    config_path: PathBuf,
    inner: Arc<Mutex<ManagerInner>>,
    send_can_fn: Arc<dyn Fn(u16, &[u8], &str) + Send + Sync>,
    ws_tx: broadcast::Sender<WsEvent>,
}

impl ModuleManager {
    pub fn new(
        config_path: PathBuf,
        send_can_fn: Arc<dyn Fn(u16, &[u8], &str) + Send + Sync>,
        ws_tx: broadcast::Sender<WsEvent>,
    ) -> Self {
        let mgr = Self {
            config_path,
            inner: Arc::new(Mutex::new(ManagerInner {
                config: ModulesConfigFile::default(),
                mdd_targets: HashMap::new(),
                servo_angles: HashMap::new(),
                solenoid_valves: HashMap::new(),
                mdd_feedback_cache: HashMap::new(),
                mdd_param_sent_at: HashMap::new(),
                mdd_param_confirmed: HashMap::new(),
                mdd_zero_status_count: HashMap::new(),
                send_session_id: 0,
                is_running: false,
                is_sending_params: false,
            })),
            send_can_fn,
            ws_tx,
        };

        mgr.load_config_and_initialize();
        mgr.spawn_control_loop();
        mgr
    }

    pub fn load_config_and_initialize(&self) {
        let loaded_cfg: ModulesConfigFile = if self.config_path.exists() {
            fs::read_to_string(&self.config_path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        } else {
            if let Some(parent) = self.config_path.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let def = ModulesConfigFile::default();
            if let Ok(json) = serde_json::to_string_pretty(&def) {
                let _ = fs::write(&self.config_path, json);
            }
            def
        };

        let mut g = self.inner.lock().unwrap();
        g.config = loaded_cfg;
        g.mdd_feedback_cache.clear();
        let is_running = g.is_running;

        let modules = g.config.modules.clone();
        for m in modules {
            let Some(base_id) = parse_hex_id(&m.base_id) else {
                continue;
            };
            match m.module_type.as_str() {
                "mdd" => {
                    g.mdd_targets.entry(m.name.clone()).or_insert([0.0; 4]);
                    g.mdd_feedback_cache.insert(
                        base_id,
                        MddFeedbackData {
                            system_status: if is_running { 1 } else { 0 },
                            ..Default::default()
                        },
                    );
                }
                "servo" => {
                    g.servo_angles.entry(m.name.clone()).or_insert([90; 6]);
                }
                "solenoid" => {
                    g.solenoid_valves
                        .entry(m.name.clone())
                        .or_insert([false; 12]);
                }
                _ => {}
            }
        }
    }

    pub fn get_config(&self) -> ModulesConfigFile {
        self.inner.lock().unwrap().config.clone()
    }

    pub fn update_config(&self, new_cfg: ModulesConfigFile) -> Result<(), String> {
        if let Some(parent) = self.config_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let json = serde_json::to_string_pretty(&new_cfg)
            .map_err(|e| format!("JSONシリアライズ失敗: {}", e))?;
        fs::write(&self.config_path, json)
            .map_err(|e| format!("設定ファイル書き込み失敗: {}", e))?;
        self.load_config_and_initialize();
        Ok(())
    }

    pub fn set_mdd_command(&self, name: &str, targets: &[f64]) {
        let mut arr = [0.0; 4];
        for i in 0..4 {
            arr[i] = targets.get(i).copied().unwrap_or(0.0);
        }

        let frame_opt = {
            let mut g = self.inner.lock().unwrap();
            g.mdd_targets.insert(name.to_string(), arr);

            if g.is_running && !g.is_sending_params {
                if let Some(m) = g.config.modules.iter().find(|m| m.name == name && m.module_type == "mdd") {
                    if let Some(base_id) = parse_hex_id(&m.base_id) {
                        let mut payload = Vec::with_capacity(8);
                        for t in arr {
                            let scaled = (t * 10.0).trunc();
                            payload.extend_from_slice(&encode_int16_le(scaled));
                        }
                        Some((base_id + 0x20, payload))
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            }
        };

        // コマンド受信時に即時CAN送信を行うことで、定期ループ（10ms）待ちの遅延を完全に排除
        if let Some((can_id, payload)) = frame_opt {
            (self.send_can_fn)(can_id, &payload, "can1");
        }
    }

    pub fn set_servo_command(&self, name: &str, angles: &[f64]) {
        let mut arr = [90u8; 6];
        for i in 0..6 {
            let v = angles.get(i).copied().unwrap_or(90.0).round().clamp(0.0, 180.0) as u8;
            arr[i] = v;
        }
        self.inner
            .lock()
            .unwrap()
            .servo_angles
            .insert(name.to_string(), arr);
    }

    pub fn set_solenoid_command(&self, name: &str, valves: &[bool]) {
        let mut arr = [false; 12];
        for i in 0..12 {
            arr[i] = valves.get(i).copied().unwrap_or(false);
        }
        self.inner
            .lock()
            .unwrap()
            .solenoid_valves
            .insert(name.to_string(), arr);
    }

    pub fn emergency_stop_all(&self) {
        let modules = {
            let mut g = self.inner.lock().unwrap();
            g.is_sending_params = false;
            g.is_running = false;
            g.send_session_id = g.send_session_id.wrapping_add(1);
            let mods = g.config.modules.clone();
            for m in &mods {
                if m.module_type == "mdd" {
                    g.mdd_targets.insert(m.name.clone(), [0.0; 4]);
                } else if m.module_type == "solenoid" {
                    g.solenoid_valves.insert(m.name.clone(), [false; 12]);
                }
            }
            mods
        };

        for m in modules {
            let Some(base_id) = parse_hex_id(&m.base_id) else {
                continue;
            };
            if m.module_type == "mdd" {
                (self.send_can_fn)(base_id + 0x20, &[0u8; 8], "can1");
            } else if m.module_type == "solenoid" {
                (self.send_can_fn)(base_id, &[0u8, 0u8], "can1");
            }
        }
    }

    /// 動作プログラム停止時用: 全モータの目標値をゼロクリアして停止フレームを即時送信するが、
    /// 制御実行状態 (is_running) は維持してキープアライブを継続し、再起動時に即座に動作できるようにする
    pub fn stop_modules_keep_running(&self) {
        let modules = {
            let mut g = self.inner.lock().unwrap();
            let mods = g.config.modules.clone();
            for m in &mods {
                if m.module_type == "mdd" {
                    g.mdd_targets.insert(m.name.clone(), [0.0; 4]);
                } else if m.module_type == "solenoid" {
                    g.solenoid_valves.insert(m.name.clone(), [false; 12]);
                }
            }
            mods
        };

        for m in modules {
            let Some(base_id) = parse_hex_id(&m.base_id) else {
                continue;
            };
            if m.module_type == "mdd" {
                (self.send_can_fn)(base_id + 0x20, &[0u8; 8], "can1");
            } else if m.module_type == "solenoid" {
                (self.send_can_fn)(base_id, &[0u8, 0u8], "can1");
            }
        }
    }

    /// 動作プログラム起動時用: 制御実行状態を有効化 (パラメータ送信中以外)
    pub fn resume_control_if_ready(&self) {
        let mut g = self.inner.lock().unwrap();
        if !g.is_sending_params {
            g.is_running = true;
        }
    }

    /// 既に制御実行状態 (system_status == 1) または起動トリガ送信済みのMDDへ生存維持用の目標値フレームを送出
    fn send_keepalive_to_confirmed_mdds(&self) {
        let frames: Vec<(u16, [u8; 8])> = {
            let g = self.inner.lock().unwrap();
            let mut list = Vec::new();
            for m in &g.config.modules {
                if m.module_type != "mdd" {
                    continue;
                }
                let Some(base_id) = parse_hex_id(&m.base_id) else {
                    continue;
                };
                let confirmed = g.mdd_param_confirmed.get(&base_id).copied().unwrap_or(false);
                let sent_trigger = g.mdd_param_sent_at.contains_key(&base_id);
                let status_one = g
                    .mdd_feedback_cache
                    .get(&base_id)
                    .map(|c| c.system_status == 1)
                    .unwrap_or(false);
                if confirmed || sent_trigger || status_one {
                    let targets = g.mdd_targets.get(&m.name).copied().unwrap_or([0.0; 4]);
                    let mut payload = [0u8; 8];
                    for (i, t) in targets.iter().enumerate() {
                        let scaled = (t * 10.0).trunc();
                        payload[i * 2..i * 2 + 2].copy_from_slice(&encode_int16_le(scaled));
                    }
                    list.push((base_id + 0x20, payload));
                }
            }
            list
        };
        for (can_id, payload) in frames {
            (self.send_can_fn)(can_id, &payload, "can1");
        }
    }

    /// パラメータ一括送信 ＆ 全マイコンからの完了応答を確認するまで継続送信 (Send Params & Start)
    pub async fn start_control(&self) -> Result<String, String> {
        let (session_id, has_mdd) = {
            let mut g = self.inner.lock().unwrap();
            g.send_session_id = g.send_session_id.wrapping_add(1);
            let sid = g.send_session_id;
            g.is_sending_params = true;
            g.is_running = false;
            g.mdd_param_sent_at.clear();
            g.mdd_param_confirmed.clear();

            let mut any_mdd = false;
            let mods = g.config.modules.clone();
            for m in &mods {
                if m.module_type == "mdd" {
                    if let Some(base_id) = parse_hex_id(&m.base_id) {
                        any_mdd = true;
                        g.mdd_param_confirmed.insert(base_id, false);
                    }
                }
            }
            (sid, any_mdd)
        };

        if !has_mdd {
            let mut g = self.inner.lock().unwrap();
            if g.send_session_id == session_id {
                g.is_sending_params = false;
                g.is_running = true;
            }
            return Ok("パラメータが正常に送信され、制御システムが実行状態に遷移しました。".to_string());
        }

        let mut round = 0usize;
        let mut last_log_time = Instant::now() - Duration::from_secs(10);

        loop {
            round += 1;

            let mdd_modules = {
                let g = self.inner.lock().unwrap();
                if !g.is_sending_params || g.send_session_id != session_id {
                    return Err("パラメータ送信が中断されました。".to_string());
                }
                g.config
                    .modules
                    .iter()
                    .filter(|m| m.module_type == "mdd")
                    .cloned()
                    .collect::<Vec<_>>()
            };

            if mdd_modules.is_empty() {
                break;
            }

            // 未完了のMDDモジュールに対してパラメータを送信
            for m in &mdd_modules {
                let Some(base_id) = parse_hex_id(&m.base_id) else {
                    continue;
                };

                let is_confirmed = {
                    let g = self.inner.lock().unwrap();
                    if !g.is_sending_params || g.send_session_id != session_id {
                        return Err("パラメータ送信が中断されました。".to_string());
                    }
                    g.mdd_param_confirmed.get(&base_id).copied().unwrap_or(false)
                };

                // 完了応答(system_status == 1)を受信済みのマイコンには生存維持フレームを送りスキップ
                if is_confirmed {
                    self.send_keepalive_to_confirmed_mdds();
                    continue;
                }

                let params = m.parameters.clone().unwrap_or_default();

                // 1. M1〜M4のPIDゲインおよび車輪径の送信 (Base ID + 0x00 .. 0x03)
                for idx in 0..4u16 {
                    let key = format!("m{}", idx + 1);
                    let mp = params.get(&key).cloned().unwrap_or_else(MotorParam::default);

                    let dir_sign: f64 = if mp.direction >= 0 { 1.0 } else { -1.0 };

                    // altair_framework および MDD ファームウェア仕様に準拠:
                    // P, I, D は 1000倍、車輪径(mm)は符号で回転方向(Fwd:+ / Rev:-)を表現して int16_t リトルエンディアンにパック
                    let p_int = (mp.p * 1000.0).round();
                    let i_int = (mp.i * 1000.0).round();
                    let d_int = (mp.d * 1000.0).round();
                    let dia_int = (mp.diameter.abs() * dir_sign).round();

                    let mut payload = [0u8; 8];
                    payload[0..2].copy_from_slice(&encode_int16_le(p_int));
                    payload[2..4].copy_from_slice(&encode_int16_le(i_int));
                    payload[4..6].copy_from_slice(&encode_int16_le(d_int));
                    payload[6..8].copy_from_slice(&encode_int16_le(dia_int));

                    (self.send_can_fn)(base_id + idx, &payload, "can1");
                    // 3連送(約5ms) + STM32側15ms保持ウィンドウ + ポーリング余裕を確保するため35ms待機
                    tokio::time::sleep(Duration::from_millis(35)).await;
                }

                // 2. 4chの制御モード一括送信とシステム起動トリガ (Base ID + 0x10)
                let mut mode_payload = [0u8; 4];
                for idx in 0..4usize {
                    let key = format!("m{}", idx + 1);
                    let mp = params.get(&key).cloned().unwrap_or_else(MotorParam::default);
                    mode_payload[idx] = mp.mode;
                }

                // 起動トリガ送信時刻を先に記録し、直後に返る status == 1 返信を確実に捕捉できるようにする
                {
                    let mut g = self.inner.lock().unwrap();
                    g.mdd_param_sent_at.insert(base_id, Instant::now());
                }

                (self.send_can_fn)(base_id + 0x10, &mode_payload, "can1");
                tokio::time::sleep(Duration::from_millis(40)).await;

                // 起動直後のマイコンおよび他マイコンが 500ms CANタイムアウト(Err:0x01)にならないよう目標値フレームを送出
                self.send_keepalive_to_confirmed_mdds();
                tokio::time::sleep(Duration::from_millis(15)).await;
            }

            // マイコンからのステータス返信 (Base ID + 0x30, data[5] == 1) を待機・確認
            let wait_start = Instant::now();
            let mut all_confirmed = false;
            while wait_start.elapsed() < Duration::from_millis(240) {
                self.send_keepalive_to_confirmed_mdds();
                tokio::time::sleep(Duration::from_millis(20)).await;

                let (done, aborted) = {
                    let g = self.inner.lock().unwrap();
                    if !g.is_sending_params || g.send_session_id != session_id {
                        (false, true)
                    } else {
                        let all_ok = mdd_modules.iter().all(|m| {
                            parse_hex_id(&m.base_id)
                                .and_then(|bid| g.mdd_param_confirmed.get(&bid).copied())
                                .unwrap_or(false)
                        });
                        (all_ok, false)
                    }
                };

                if aborted {
                    return Err("パラメータ送信が中断されました。".to_string());
                }
                if done {
                    all_confirmed = true;
                    break;
                }
            }

            if all_confirmed {
                break;
            }

            // まだ応答がないマイコンがある場合は進捗をログ出力して再送信を継続
            if round == 1 || last_log_time.elapsed() >= Duration::from_millis(1500) {
                last_log_time = Instant::now();
                let (confirmed_names, pending_names) = {
                    let g = self.inner.lock().unwrap();
                    let mut ok_list = Vec::new();
                    let mut ng_list = Vec::new();
                    for m in &mdd_modules {
                        if let Some(bid) = parse_hex_id(&m.base_id) {
                            if g.mdd_param_confirmed.get(&bid).copied().unwrap_or(false) {
                                ok_list.push(m.name.clone());
                            } else {
                                ng_list.push(m.name.clone());
                            }
                        }
                    }
                    (ok_list, ng_list)
                };
                let ok_str = if confirmed_names.is_empty() {
                    "なし".to_string()
                } else {
                    confirmed_names.join(", ")
                };
                let ng_str = pending_names.join(", ");
                let _ = self.ws_tx.send(WsEvent::BehaviorLog {
                    data: format!(
                        "[SYSTEM] パラメータ送信・応答待機中... (完了: {} / 応答待ち: {})",
                        ok_str, ng_str
                    ),
                });
            }
        }

        let confirmed_names = {
            let mut g = self.inner.lock().unwrap();
            if g.send_session_id != session_id {
                return Err("パラメータ送信が中断されました。".to_string());
            }
            g.is_running = true;
            g.is_sending_params = false;

            g.config
                .modules
                .iter()
                .filter(|m| m.module_type == "mdd")
                .map(|m| m.name.clone())
                .collect::<Vec<_>>()
        };

        Ok(format!(
            "全マイコン ({}) からの設定完了応答を確認し、制御実行状態になりました。",
            confirmed_names.join(", ")
        ))
    }

    pub fn handle_can_rx(&self, frame: &CanFrameEvent) {
        if frame.direction != "RX" {
            return;
        }
        let can_id = frame.id;
        let data = &frame.data;

        let mut events_to_send = Vec::new();

        {
            let mut g = self.inner.lock().unwrap();
            let base_ids: Vec<u16> = g.mdd_feedback_cache.keys().copied().collect();

            for base_id in base_ids {
                if can_id == base_id + 0x30 {
                    if data.len() < 6 {
                        continue;
                    }
                    let status_byte = data[5];
                    let error_code = data[4];
                    let is_running = g.is_running;
                    let is_sending = g.is_sending_params;

                    let mut reset_detected = false;
                    if let Some(cache) = g.mdd_feedback_cache.get_mut(&base_id) {
                        cache.limit_switches = [
                            data[0] != 0,
                            data[1] != 0,
                            data[2] != 0,
                            data[3] != 0,
                        ];
                        cache.error_code = error_code;
                        cache.system_status = status_byte;
                    }

                    if status_byte == 1 {
                        g.mdd_zero_status_count.insert(base_id, 0);
                        // パラメータ送信トリガ以降の status == 1 応答をもって設定完了と判定
                        if g.mdd_param_sent_at.contains_key(&base_id) || is_sending {
                            g.mdd_param_confirmed.insert(base_id, true);
                        }
                    } else {
                        // 待機状態 (status == 0)
                        let zero_cnt = g.mdd_zero_status_count.entry(base_id).or_insert(0);
                        *zero_cnt += 1;
                        let count = *zero_cnt;

                        // パラメータ送信中にインフライトで届いた古い status == 0 フレームで
                        // mdd_param_sent_at を消去してしまうと以降の status == 1 を認識できなくなるため保持する
                        if is_sending {
                            if let Some(&sent_at) = g.mdd_param_sent_at.get(&base_id) {
                                if sent_at.elapsed() >= Duration::from_millis(300) {
                                    g.mdd_param_confirmed.insert(base_id, false);
                                }
                            }
                        } else {
                            // パラメータ送信直後の過渡期（1.5秒以内）はリセット誤判定を抑制
                            let sent_at = g.mdd_param_sent_at.get(&base_id).copied();
                            let in_grace_period = sent_at
                                .map(|t| t.elapsed() < Duration::from_millis(1500))
                                .unwrap_or(false);

                            // 単発ノイズによる誤検知を防ぐため、10回連続(約100ms)かつ猶予期間外のみリセットと判定
                            if !in_grace_period && count >= 10 {
                                let was_confirmed =
                                    g.mdd_param_confirmed.insert(base_id, false).unwrap_or(false);
                                if is_running && was_confirmed {
                                    reset_detected = true;
                                }
                            }
                        }
                    }

                    if reset_detected {
                        g.is_running = false;
                        if let Some(m) = g
                            .config
                            .modules
                            .iter()
                            .find(|m| parse_hex_id(&m.base_id) == Some(base_id))
                        {
                            let err_desc = match error_code {
                                0x00 => "正常待機 (0x00)",
                                0x01 => "初期化タイムアウト (0x01: INIT_TIMEOUT)",
                                0x02 => "CAN受信途絶タイムアウト (0x02: CAN_RX_TIMEOUT)",
                                0x04 => "CAN送信失敗 (0x04: CAN_TX_FAIL)",
                                other => &format!("エラーコード (0x{:02X})", other),
                            };
                            events_to_send.push(WsEvent::BehaviorLog {
                                data: format!(
                                    "[WARN] マイコン '{}' の待機状態へのリセットを検知しました (エラー要因: {})。PC側の制御フラグを安全にリセットしました。",
                                    m.name, err_desc
                                ),
                            });
                        }
                    }

                    if let (Some(mut cache), Some(m)) = (
                        g.mdd_feedback_cache.get(&base_id).cloned(),
                        g.config
                            .modules
                            .iter()
                            .find(|m| parse_hex_id(&m.base_id) == Some(base_id)),
                    ) {
                        cache.targets = g.mdd_targets.get(&m.name).copied().unwrap_or([0.0; 4]);
                        events_to_send.push(WsEvent::MddFeedback {
                            name: m.name.clone(),
                            data: cache,
                        });
                    }
                } else if can_id == base_id + 0x40 {
                    if data.len() < 8 {
                        continue;
                    }
                    if let Some(cache) = g.mdd_feedback_cache.get_mut(&base_id) {
                        cache.angles = [
                            decode_int16_le(data[0], data[1]) as f64 / 10.0,
                            decode_int16_le(data[2], data[3]) as f64 / 10.0,
                            decode_int16_le(data[4], data[5]) as f64 / 10.0,
                            decode_int16_le(data[6], data[7]) as f64 / 10.0,
                        ];
                    }
                    if let (Some(mut cache), Some(m)) = (
                        g.mdd_feedback_cache.get(&base_id).cloned(),
                        g.config
                            .modules
                            .iter()
                            .find(|m| parse_hex_id(&m.base_id) == Some(base_id)),
                    ) {
                        cache.targets = g.mdd_targets.get(&m.name).copied().unwrap_or([0.0; 4]);
                        events_to_send.push(WsEvent::MddFeedback {
                            name: m.name.clone(),
                            data: cache,
                        });
                    }
                } else if can_id == base_id + 0x50 {
                    if data.len() < 8 {
                        continue;
                    }
                    if let Some(cache) = g.mdd_feedback_cache.get_mut(&base_id) {
                        cache.speeds = [
                            decode_int16_le(data[0], data[1]) as f64 / 100.0,
                            decode_int16_le(data[2], data[3]) as f64 / 100.0,
                            decode_int16_le(data[4], data[5]) as f64 / 100.0,
                            decode_int16_le(data[6], data[7]) as f64 / 100.0,
                        ];
                    }
                    if let (Some(mut cache), Some(m)) = (
                        g.mdd_feedback_cache.get(&base_id).cloned(),
                        g.config
                            .modules
                            .iter()
                            .find(|m| parse_hex_id(&m.base_id) == Some(base_id)),
                    ) {
                        cache.targets = g.mdd_targets.get(&m.name).copied().unwrap_or([0.0; 4]);
                        events_to_send.push(WsEvent::MddFeedback {
                            name: m.name.clone(),
                            data: cache,
                        });
                    }
                }
            }
        }

        for ev in events_to_send {
            let _ = self.ws_tx.send(ev);
        }
    }

    fn spawn_control_loop(&self) {
        let inner = self.inner.clone();
        let send_can_fn = self.send_can_fn.clone();

        std::thread::spawn(move || {
            #[cfg(target_os = "windows")]
            unsafe {
                timeBeginPeriod(1);
            }

            loop {
                let loop_start = Instant::now();

                let (frames_to_send, rate_hz) = {
                    let g = inner.lock().unwrap();
                    let hz = if g.config.control_rate_hz > 0 {
                        g.config.control_rate_hz
                    } else {
                        100
                    };

                    if g.is_sending_params {
                        (Vec::new(), hz)
                    } else {
                        let mut frames: Vec<(u16, Vec<u8>)> = Vec::new();
                        for m in &g.config.modules {
                            let Some(base_id) = parse_hex_id(&m.base_id) else {
                                continue;
                            };
                            match m.module_type.as_str() {
                                "mdd" => {
                                    if !g.is_running {
                                        continue;
                                    }
                                    let targets =
                                        g.mdd_targets.get(&m.name).copied().unwrap_or([0.0; 4]);
                                    let mut payload = Vec::with_capacity(8);
                                    for t in targets {
                                        let scaled = (t * 10.0).trunc();
                                        payload.extend_from_slice(&encode_int16_le(scaled));
                                    }
                                    frames.push((base_id + 0x20, payload));
                                }
                                "servo" => {
                                    let angles =
                                        g.servo_angles.get(&m.name).copied().unwrap_or([90; 6]);
                                    frames.push((base_id, angles.to_vec()));
                                }
                                "solenoid" => {
                                    let valves = g
                                        .solenoid_valves
                                        .get(&m.name)
                                        .copied()
                                        .unwrap_or([false; 12]);
                                    let mut byte0 = 0u8;
                                    let mut byte1 = 0u8;
                                    for i in 0..12 {
                                        if valves[i] {
                                            if i < 8 {
                                                byte0 |= 1 << i;
                                            } else {
                                                byte1 |= 1 << (i - 8);
                                            }
                                        }
                                    }
                                    frames.push((base_id, vec![byte0, byte1]));
                                }
                                _ => {}
                            }
                        }
                        (frames, hz)
                    }
                };

                for (id, payload) in frames_to_send {
                    (send_can_fn)(id, &payload, "can1");
                }

                let target_period =
                    Duration::from_micros((1_000_000.0 / rate_hz as f64).round() as u64);
                let elapsed = loop_start.elapsed();
                if elapsed < target_period {
                    let sleep_dur = target_period - elapsed;
                    if sleep_dur >= Duration::from_millis(1) {
                        std::thread::sleep(sleep_dur);
                    } else {
                        std::thread::yield_now();
                    }
                }
            }
        });
    }
}

