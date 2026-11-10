use gilrs::{Axis, Button, Event, EventType, Gilrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::broadcast;

use crate::types::WsEvent;

#[cfg(target_os = "windows")]
#[link(name = "winmm")]
extern "system" {
    fn timeBeginPeriod(uPeriod: u32) -> u32;
}

/// ネイティブ取得したゲームパッド入力であることを示す source 値
pub const GAMEPAD_SOURCE_NATIVE: &str = "native";

/// バックグラウンドでネイティブゲームパッド (XInput / DirectInput) を監視・配信するサービス
pub struct GamepadService {
    is_running: Arc<AtomicBool>,
}

impl GamepadService {
    pub fn new() -> Self {
        Self {
            is_running: Arc::new(AtomicBool::new(false)),
        }
    }

    /// イベント駆動 (無入力時は最大10ms間隔) の監視スレッドを起動
    pub fn start(&self, ws_tx: broadcast::Sender<WsEvent>) {
        if self.is_running.swap(true, Ordering::SeqCst) {
            return; // 既に実行中
        }

        let is_running = self.is_running.clone();

        std::thread::spawn(move || {
            #[cfg(target_os = "windows")]
            unsafe {
                timeBeginPeriod(1);
            }

            let mut gilrs = match Gilrs::new() {
                Ok(g) => g,
                Err(e) => {
                    eprintln!("[WARN] ネイティブゲームパッド初期化に失敗しました: {}", e);
                    is_running.store(false, Ordering::SeqCst);
                    return;
                }
            };

            let mut last_connected_id = None;
            let mut last_axes: Vec<f64> = Vec::new();
            let mut last_buttons: Vec<bool> = Vec::new();
            let mut last_sent_time = Instant::now() - Duration::from_secs(1);

            while is_running.load(Ordering::Relaxed) {
                // 1. 新しいイベント（接続、切断、ボタンなど）を処理
                // 以前は 10ms 固定スリープでポーリングしていたため、入力から検出まで最大 10ms 余計に遅れていた。
                // 最初の1件はブロッキング待ちにして入力イベント到着と同時に起床し、残りはノンブロッキングで吸い出す
                let mut lost_active = false;
                let mut pending = gilrs.next_event_blocking(Some(Duration::from_millis(10)));
                while let Some(Event { id, event, .. }) = pending {
                    match event {
                        EventType::Connected => {
                            let name = gilrs.gamepad(id).name().to_string();
                            println!("[SYSTEM] ネイティブゲームパッド接続を検知: {} (ID: {:?})", name, id);
                            last_connected_id = Some(id);
                        }
                        EventType::Disconnected => {
                            println!("[WARN] ネイティブゲームパッド切断を検知 (ID: {:?})", id);
                            if last_connected_id == Some(id) {
                                last_connected_id = None;
                                lost_active = true;
                            }
                        }
                        _ => {}
                    }
                    pending = gilrs.next_event();
                }
                gilrs.inc();

                // 使用中のゲームパッドが切断された場合、最後の入力値が残ったままロボットが走り続けないよう
                // ニュートラル状態を1回配信してから次の候補を探す
                if lost_active {
                    let axes = vec![0.0; 6];
                    let buttons = vec![false; 16];
                    last_axes = axes.clone();
                    last_buttons = buttons.clone();
                    last_sent_time = Instant::now();
                    let _ = ws_tx.send(WsEvent::GamepadInput {
                        buttons,
                        axes,
                        source: Some(GAMEPAD_SOURCE_NATIVE.to_string()),
                    });
                }

                // 2. 有効なゲームパッドを探索（最後に接続されたもの、または現在アクティブなもの）
                let active_gamepad = last_connected_id
                    .and_then(|id| {
                        let gp = gilrs.gamepad(id);
                        if gp.is_connected() {
                            Some(gp)
                        } else {
                            None
                        }
                    })
                    .or_else(|| {
                        gilrs.gamepads().find(|(_, gp)| gp.is_connected()).map(|(id, gp)| {
                            last_connected_id = Some(id);
                            gp
                        })
                    });

                if let Some(gp) = active_gamepad {
                    // スティック軸 (axes): Web Gamepad API 標準規格に準拠
                    // axis 0: 左スティック X (-1.0=左, +1.0=右)
                    // axis 1: 左スティック Y (-1.0=上, +1.0=下) ※gilrsの上=正を反転してWeb規格に整合
                    // axis 2: 右スティック X (-1.0=左, +1.0=右)
                    // axis 3: 右スティック Y (-1.0=上, +1.0=下) ※反転
                    // axis 4: 左トリガー L2 (0.0 〜 1.0)
                    // axis 5: 右トリガー R2 (0.0 〜 1.0)
                    let lx = Self::apply_deadzone(gp.value(Axis::LeftStickX) as f64);
                    let ly = -Self::apply_deadzone(gp.value(Axis::LeftStickY) as f64);
                    let rx = Self::apply_deadzone(gp.value(Axis::RightStickX) as f64);
                    let ry = -Self::apply_deadzone(gp.value(Axis::RightStickY) as f64);
                    let l2_axis = gp.value(Axis::LeftZ) as f64;
                    let r2_axis = gp.value(Axis::RightZ) as f64;

                    let axes = vec![lx, ly, rx, ry, l2_axis, r2_axis];

                    // ボタン状態 (buttons: 16要素のbool配列)
                    let mut buttons = vec![false; 16];
                    buttons[0] = gp.is_pressed(Button::South); // A / ✕
                    buttons[1] = gp.is_pressed(Button::East);  // B / ◯
                    buttons[2] = gp.is_pressed(Button::West);  // X / □
                    buttons[3] = gp.is_pressed(Button::North); // Y / △
                    buttons[4] = gp.is_pressed(Button::LeftTrigger);  // L1
                    buttons[5] = gp.is_pressed(Button::RightTrigger); // R1
                    buttons[6] = gp.is_pressed(Button::LeftTrigger2) || l2_axis > 0.5;  // L2
                    buttons[7] = gp.is_pressed(Button::RightTrigger2) || r2_axis > 0.5; // R2
                    buttons[8] = gp.is_pressed(Button::Select); // Share / Back
                    buttons[9] = gp.is_pressed(Button::Start);  // Options / Start
                    buttons[10] = gp.is_pressed(Button::LeftThumb);  // Lスティック押し込み
                    buttons[11] = gp.is_pressed(Button::RightThumb); // Rスティック押し込み
                    buttons[12] = gp.is_pressed(Button::DPadUp);
                    buttons[13] = gp.is_pressed(Button::DPadDown);
                    buttons[14] = gp.is_pressed(Button::DPadLeft);
                    buttons[15] = gp.is_pressed(Button::DPadRight);

                    // 入力値に変化があった場合、または20Hz(50ms)キープアライブ時に送信
                    let changed = axes != last_axes || buttons != last_buttons;
                    let keepalive = last_sent_time.elapsed() >= Duration::from_millis(50);

                    if changed || keepalive {
                        last_axes = axes.clone();
                        last_buttons = buttons.clone();
                        last_sent_time = Instant::now();

                        // WebSocket 経由で Python Behavior および WebUI モニターへ直接ブロードキャスト
                        // source を付けることで WebUI 側がブラウザ自身の送信のエコーと区別できる
                        let _ = ws_tx.send(WsEvent::GamepadInput {
                            buttons,
                            axes,
                            source: Some(GAMEPAD_SOURCE_NATIVE.to_string()),
                        });
                    }
                }
                // 待機は先頭の next_event_blocking が担うため、ここでの固定スリープは不要
            }
        });
    }

    fn apply_deadzone(val: f64) -> f64 {
        if val.abs() < 0.05 {
            0.0
        } else {
            (val * 1000.0).round() / 1000.0
        }
    }
}

