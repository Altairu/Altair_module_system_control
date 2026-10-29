use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::broadcast;

use crate::types::{CanFrameEvent, MddFeedbackData, ModulesConfigFile, MotorParam, WsEvent};

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
    is_running: bool,
    is_sending_params: bool,
    control_start_time: Instant,
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
                is_running: false,
                is_sending_params: false,
                control_start_time: Instant::now() - Duration::from_secs(10),
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
        self.inner
            .lock()
            .unwrap()
            .mdd_targets
            .insert(name.to_string(), arr);
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

    /// パラメータ一括送信 ＆ 制御実行モード遷移 (Send Params & Start)
    pub async fn start_control(&self) -> Result<String, String> {
        let modules = {
            let mut g = self.inner.lock().unwrap();
            g.is_sending_params = true;
            g.config.modules.clone()
        };

        for m in modules {
            if m.module_type != "mdd" {
                continue;
            }
            let Some(base_id) = parse_hex_id(&m.base_id) else {
                continue;
            };
            let params = m.parameters.unwrap_or_default();

            // 1. M1〜M4のPIDゲインおよび車輪径の送信 (Base ID + 0x00 .. 0x03)
            for idx in 0..4u16 {
                let key = format!("m{}", idx + 1);
                let mp = params.get(&key).cloned().unwrap_or_else(MotorParam::default);

                let dir_val: f64 = if mp.direction >= 0 { 1.0 } else { -1.0 };

                // P, I, D は 1000倍、Diameter は 10倍して int16_t リトルエンディアンにパック
                let p_int = (mp.p * 1000.0 * dir_val).trunc();
                let i_int = (mp.i * 1000.0 * dir_val).trunc();
                let d_int = (mp.d * 1000.0 * dir_val).trunc();
                let dia_int = (mp.diameter * 10.0).trunc();

                let mut payload = [0u8; 8];
                payload[0..2].copy_from_slice(&encode_int16_le(p_int));
                payload[2..4].copy_from_slice(&encode_int16_le(i_int));
                payload[4..6].copy_from_slice(&encode_int16_le(d_int));
                payload[6..8].copy_from_slice(&encode_int16_le(dia_int));

                (self.send_can_fn)(base_id + idx, &payload, "can1");
                tokio::time::sleep(Duration::from_millis(25)).await;
            }

            // 2. 4chの制御モード一括送信とシステム起動トリガ (Base ID + 0x10 = 0x210)
            let mut mode_payload = [0u8; 4];
            for idx in 0..4usize {
                let key = format!("m{}", idx + 1);
                let mp = params.get(&key).cloned().unwrap_or_else(MotorParam::default);
                mode_payload[idx] = mp.mode;
            }
            (self.send_can_fn)(base_id + 0x10, &mode_payload, "can1");
            tokio::time::sleep(Duration::from_millis(25)).await;
        }

        let feedback_notifications = {
            let mut g = self.inner.lock().unwrap();
            g.control_start_time = Instant::now();
            g.is_running = true;
            g.is_sending_params = false;

            let mods = g.config.modules.clone();
            let mut list = Vec::new();
            for m in &mods {
                if m.module_type == "mdd" {
                    if let Some(base_id) = parse_hex_id(&m.base_id) {
                        if let Some(cache) = g.mdd_feedback_cache.get_mut(&base_id) {
                            cache.system_status = 1;
                            list.push((m.name.clone(), cache.clone()));
                        }
                    }
                }
            }
            list
        };

        for (name, data) in feedback_notifications {
            let _ = self.ws_tx.send(WsEvent::MddFeedback { name, data });
        }

        Ok("パラメータが正常に送信され、制御システムが実行状態に遷移しました。".to_string())
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
                    let in_grace = g.control_start_time.elapsed() < Duration::from_millis(1200);
                    let is_running = g.is_running;

                    let mut reset_detected = false;
                    if let Some(cache) = g.mdd_feedback_cache.get_mut(&base_id) {
                        cache.limit_switches = [
                            data[0] != 0,
                            data[1] != 0,
                            data[2] != 0,
                            data[3] != 0,
                        ];
                        cache.error_code = data[4];
                        if data[5] == 0 && is_running && in_grace {
                            cache.system_status = 1;
                        } else {
                            cache.system_status = data[5];
                        }
                        if data[5] == 0 && is_running && !in_grace {
                            reset_detected = true;
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
                            events_to_send.push(WsEvent::BehaviorLog {
                                data: format!(
                                    "[WARN] マイコン '{}' の待機状態へのリセットを検知したため、PC側の制御フラグを安全にリセットしました。",
                                    m.name
                                ),
                            });
                        }
                    }

                    if let (Some(cache), Some(m)) = (
                        g.mdd_feedback_cache.get(&base_id).cloned(),
                        g.config
                            .modules
                            .iter()
                            .find(|m| parse_hex_id(&m.base_id) == Some(base_id)),
                    ) {
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
                    if let (Some(cache), Some(m)) = (
                        g.mdd_feedback_cache.get(&base_id).cloned(),
                        g.config
                            .modules
                            .iter()
                            .find(|m| parse_hex_id(&m.base_id) == Some(base_id)),
                    ) {
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
                    if let (Some(cache), Some(m)) = (
                        g.mdd_feedback_cache.get(&base_id).cloned(),
                        g.config
                            .modules
                            .iter()
                            .find(|m| parse_hex_id(&m.base_id) == Some(base_id)),
                    ) {
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

        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(10));

            let frames_to_send = {
                let g = inner.lock().unwrap();
                if g.is_sending_params {
                    continue;
                }

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
                            let targets = g.mdd_targets.get(&m.name).copied().unwrap_or([0.0; 4]);
                            let mut payload = Vec::with_capacity(8);
                            for t in targets {
                                let scaled = (t * 10.0).trunc();
                                payload.extend_from_slice(&encode_int16_le(scaled));
                            }
                            frames.push((base_id + 0x20, payload));
                        }
                        "servo" => {
                            let angles = g.servo_angles.get(&m.name).copied().unwrap_or([90; 6]);
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
                frames
            };

            for (id, payload) in frames_to_send {
                (send_can_fn)(id, &payload, "can1");
            }
        });
    }
}

