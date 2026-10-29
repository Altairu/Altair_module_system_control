use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// モータ1軸分のPID・モード・車輪径・回転方向パラメータ
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MotorParam {
    #[serde(default = "default_p")]
    pub p: f64,
    #[serde(default)]
    pub i: f64,
    #[serde(default)]
    pub d: f64,
    #[serde(default = "default_diameter")]
    pub diameter: f64,
    #[serde(default = "default_direction")]
    pub direction: i32,
    #[serde(default)]
    pub mode: u8,
}

fn default_p() -> f64 {
    10.0
}
fn default_diameter() -> f64 {
    100.0
}
fn default_direction() -> i32 {
    1
}

impl Default for MotorParam {
    fn default() -> Self {
        Self {
            p: 10.0,
            i: 0.0,
            d: 0.0,
            diameter: 100.0,
            direction: 1,
            mode: 0,
        }
    }
}

/// モジュール1台の設定データ
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModuleConfig {
    pub name: String,
    #[serde(rename = "type")]
    pub module_type: String,
    pub base_id: String,
    #[serde(default)]
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameters: Option<HashMap<String, MotorParam>>,
}

/// 全体モジュール構成ファイル (modules_config.json / profiles/*.json)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModulesConfigFile {
    #[serde(default)]
    pub modules: Vec<ModuleConfig>,
}

/// Ethernet-CAN ネットワーク設定 (network_config.json)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkConfig {
    pub target_ip: String,
    pub target_port: u16,
    #[serde(default = "default_can_channel")]
    pub can_channel: String,
}

fn default_can_channel() -> String {
    "can1".to_string()
}

impl Default for NetworkConfig {
    fn default() -> Self {
        Self {
            target_ip: "192.168.2.123".to_string(),
            target_port: 5000,
            can_channel: "can1".to_string(),
        }
    }
}

/// MDDテレメトリ・フィードバックデータ
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MddFeedbackData {
    pub limit_switches: [bool; 4],
    pub error_code: u8,
    pub system_status: u8,
    pub angles: [f64; 4],
    pub speeds: [f64; 4],
}

impl Default for MddFeedbackData {
    fn default() -> Self {
        Self {
            limit_switches: [false; 4],
            error_code: 0,
            system_status: 0,
            angles: [0.0; 4],
            speeds: [0.0; 4],
        }
    }
}

/// CAN接続ステータス通知データ
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CanStatusEvent {
    pub is_connected: bool,
    pub active_port: String,
    pub bitrate: u32,
    pub error_message: String,
    pub mode: String,
}

/// 内部CANフレーム送受信イベント
#[derive(Debug, Clone)]
pub struct CanFrameEvent {
    pub direction: String,
    pub channel: String,
    pub id: u16,
    pub dlc: u8,
    pub data: Vec<u8>,
}

/// WebSocket ブロードキャスト用イベント
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum WsEvent {
    #[serde(rename = "can_status")]
    CanStatus { data: CanStatusEvent },
    #[serde(rename = "behavior_status")]
    BehaviorStatus { data: String },
    #[serde(rename = "behavior_log")]
    BehaviorLog { data: String },
    #[serde(rename = "mdd_feedback")]
    MddFeedback { name: String, data: MddFeedbackData },
    #[serde(rename = "raw_can_frame")]
    RawCanFrame { data: String },
    #[serde(rename = "gamepad_input")]
    GamepadInput {
        buttons: Vec<bool>,
        axes: Vec<f64>,
    },
}

