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

/// RoboMaster モーター1台分の設定パラメータ
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RobomasParam {
    /// モーター型番 ("m3508", "m2006", "gm6020")
    #[serde(default = "default_robomas_model")]
    pub motor_model: String,
    /// 制御モード ("current", "voltage", "speed_pid", "position_pid")
    #[serde(default = "default_robomas_mode")]
    pub control_mode: String,
    /// 速度PIDゲイン
    #[serde(default = "default_rm_vel_kp")]
    pub vel_kp: f64,
    #[serde(default)]
    pub vel_ki: f64,
    #[serde(default)]
    pub vel_kd: f64,
    /// 位置PIDゲイン (カスケード外ループ: 角度誤差[deg] -> 目標速度[rpm])
    #[serde(default = "default_rm_pos_kp")]
    pub pos_kp: f64,
    #[serde(default)]
    pub pos_ki: f64,
    #[serde(default)]
    pub pos_kd: f64,
    /// 位置PID時の最大速度制限 [rpm]
    #[serde(default = "default_rm_max_speed")]
    pub max_speed_rpm: f64,
    /// 最大出力指令値 (M3508/M2006: 最大16384, GM6020電圧: 最大30000)
    #[serde(default = "default_rm_max_output")]
    pub max_output: f64,
    /// 回転方向 (1 または -1)
    #[serde(default = "default_direction")]
    pub direction: i32,
}

fn default_robomas_model() -> String {
    "m3508".to_string()
}
fn default_robomas_mode() -> String {
    "current".to_string()
}
fn default_rm_vel_kp() -> f64 {
    20.0
}
fn default_rm_pos_kp() -> f64 {
    3.0
}
fn default_rm_max_speed() -> f64 {
    300.0
}
fn default_rm_max_output() -> f64 {
    10000.0
}

impl Default for RobomasParam {
    fn default() -> Self {
        Self {
            motor_model: default_robomas_model(),
            control_mode: default_robomas_mode(),
            vel_kp: default_rm_vel_kp(),
            vel_ki: 0.0,
            vel_kd: 0.0,
            pos_kp: default_rm_pos_kp(),
            pos_ki: 0.0,
            pos_kd: 0.0,
            max_speed_rpm: default_rm_max_speed(),
            max_output: default_rm_max_output(),
            direction: 1,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub can_channel: Option<String>,
    #[serde(default)]
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameters: Option<HashMap<String, MotorParam>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub robomas: Option<RobomasParam>,
}

fn default_control_rate_hz() -> u32 {
    100
}

/// 全体モジュール構成ファイル (modules_config.json / profiles/*.json)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModulesConfigFile {
    #[serde(default = "default_control_rate_hz")]
    pub control_rate_hz: u32,
    #[serde(default)]
    pub modules: Vec<ModuleConfig>,
}

impl Default for ModulesConfigFile {
    fn default() -> Self {
        Self {
            control_rate_hz: 100,
            modules: Vec::new(),
        }
    }
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
    #[serde(default)]
    pub targets: [f64; 4],
}

impl Default for MddFeedbackData {
    fn default() -> Self {
        Self {
            limit_switches: [false; 4],
            error_code: 0,
            system_status: 0,
            angles: [0.0; 4],
            speeds: [0.0; 4],
            targets: [0.0; 4],
        }
    }
}

/// RoboMaster モーター テレメトリ・フィードバックデータ
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RobomasFeedbackData {
    pub raw_angle: u16,
    pub single_angle_deg: f64,
    pub angle_deg: f64,
    pub speed_rpm: i16,
    pub torque_current: i16,
    pub current_a: f64,
    pub temperature: u8,
    pub output_cmd: i16,
    pub target: f64,
    pub control_mode: String,
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
    #[serde(rename = "robomas_feedback")]
    RobomasFeedback {
        name: String,
        data: RobomasFeedbackData,
    },
    #[serde(rename = "raw_can_frame")]
    RawCanFrame { data: String },
    #[serde(rename = "gamepad_input")]
    GamepadInput {
        buttons: Vec<bool>,
        axes: Vec<f64>,
        /// 入力元 ("native" = Rust の gilrs, "browser" = WebUI の Gamepad API)
        #[serde(skip_serializing_if = "Option::is_none")]
        source: Option<String>,
    },
}

