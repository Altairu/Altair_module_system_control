use std::collections::VecDeque;
use std::io::{ErrorKind, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::broadcast;

use crate::types::{CanFrameEvent, CanStatusEvent, WsEvent};

const ANALYZER_RX_SIZE: usize = 60;
const ANALYZER_TX_SIZE: usize = 20;

#[derive(Clone)]
struct TxQueueItem {
    can_id: u16,
    send_to_can2: bool,
    is_config_frame: bool,
    payload: [u8; ANALYZER_TX_SIZE],
    dlc: u8,
    raw_data: Vec<u8>,
}

struct EthInner {
    target_ip: String,
    target_port: u16,
    can_channel: String,
    is_connected: bool,
    auto_reconnect: bool,
    last_error: String,
    tx_queue: VecDeque<TxQueueItem>,
    force_reconnect: bool,
    force_disconnect: bool,
}

/// Ethernet-CAN (LANtoCAN: STM32 + W5500) Analyzer Mode ブリッジ
/// altair_framework の altair_eth_can_bridge (C++) 実装と同一の送受信プロトコルおよびタイミング制御を実装
#[derive(Clone)]
pub struct EthCanBridge {
    inner: Arc<Mutex<EthInner>>,
    ws_tx: broadcast::Sender<WsEvent>,
    rx_tx: broadcast::Sender<CanFrameEvent>,
}

impl EthCanBridge {
    pub fn new(
        target_ip: String,
        target_port: u16,
        can_channel: String,
        ws_tx: broadcast::Sender<WsEvent>,
        rx_tx: broadcast::Sender<CanFrameEvent>,
    ) -> Self {
        let bridge = Self {
            inner: Arc::new(Mutex::new(EthInner {
                target_ip,
                target_port,
                can_channel,
                is_connected: false,
                auto_reconnect: true,
                last_error: String::new(),
                tx_queue: VecDeque::new(),
                force_reconnect: false,
                force_disconnect: false,
            })),
            ws_tx,
            rx_tx,
        };

        bridge.spawn_worker();
        bridge
    }

    /// 設定フレーム (0x200..0x203, 0x210) かどうかを判定
    pub fn is_config_can_id(can_id: u16) -> bool {
        let sub_id = can_id & 0x0FF;
        can_id >= 0x200 && sub_id < 0x20
    }

    /// 現在の接続ステータスを取得
    pub fn get_status(&self) -> CanStatusEvent {
        let guard = self.inner.lock().unwrap();
        CanStatusEvent {
            is_connected: guard.is_connected,
            active_port: format!("{}:{}", guard.target_ip, guard.target_port),
            bitrate: 1_000_000,
            error_message: guard.last_error.clone(),
            mode: "eth".to_string(),
        }
    }

    /// 現在のターゲットIPとポートを取得
    pub fn get_config(&self) -> (String, u16, String) {
        let guard = self.inner.lock().unwrap();
        (
            guard.target_ip.clone(),
            guard.target_port,
            guard.can_channel.clone(),
        )
    }

    /// 接続要求
    pub fn connect(&self, ip: String, port: u16) -> Result<String, String> {
        {
            let mut guard = self.inner.lock().unwrap();
            guard.target_ip = ip.clone();
            guard.target_port = port;
            guard.auto_reconnect = true;
            guard.force_disconnect = false;
            guard.force_reconnect = true;
            guard.tx_queue.clear();
        }

        // ワーカーが接続を試行するのを待機して結果を返す
        let start = Instant::now();
        while start.elapsed() < Duration::from_millis(2200) {
            std::thread::sleep(Duration::from_millis(25));
            let guard = self.inner.lock().unwrap();
            if guard.is_connected && !guard.force_reconnect {
                return Ok(format!(
                    "Ethernet-CAN 基板 ({}:{}) へ接続しました。",
                    ip, port
                ));
            }
            if !guard.force_reconnect && !guard.last_error.is_empty() {
                return Err(guard.last_error.clone());
            }
        }

        let guard = self.inner.lock().unwrap();
        if guard.is_connected {
            Ok(format!(
                "Ethernet-CAN 基板 ({}:{}) へ接続しました。",
                ip, port
            ))
        } else {
            Err(if guard.last_error.is_empty() {
                format!("接続タイムアウト ({}:{})", ip, port)
            } else {
                guard.last_error.clone()
            })
        }
    }

    /// 手動切断要求
    pub fn disconnect(&self) {
        let mut guard = self.inner.lock().unwrap();
        guard.auto_reconnect = false;
        guard.force_disconnect = true;
        guard.is_connected = false;
        guard.last_error.clear();
        guard.tx_queue.clear();
    }

    /// CANフレームを送信キューへ登録
    pub fn send_can_frame(&self, id: u16, data: &[u8], channel: &str) {
        let mut guard = self.inner.lock().unwrap();
        if !guard.is_connected {
            return;
        }

        let standard_id = id & 0x7FF;
        if standard_id == 0 {
            return;
        }

        let dlc = data.len().min(8);
        let send_to_can2 = if guard.can_channel == "can2" {
            true
        } else {
            guard.can_channel == "both" && channel == "can2"
        };

        let mut payload = [0u8; ANALYZER_TX_SIZE];
        let base_offset = if send_to_can2 { 10 } else { 0 };
        payload[base_offset] = ((standard_id >> 8) & 0xFF) as u8;
        payload[base_offset + 1] = (standard_id & 0xFF) as u8;
        for i in 0..dlc {
            payload[base_offset + 2 + i] = data[i];
        }

        let is_config_frame = Self::is_config_can_id(standard_id);
        let item = TxQueueItem {
            can_id: standard_id,
            send_to_can2,
            is_config_frame,
            payload,
            dlc: dlc as u8,
            raw_data: data[..dlc].to_vec(),
        };

        if is_config_frame {
            // 設定フレーム (0x200..0x203, 0x210) はSTM32側の1msタイマーで確実に拾わせるため3回連続でキューに積む
            for _ in 0..3 {
                guard.tx_queue.push_back(item.clone());
            }
        } else {
            // 周期制御フレームは同一CAN IDの未送信フレームがあれば最新値で上書きして遅延蓄積を防ぐ
            for existing in guard.tx_queue.iter_mut() {
                if !existing.is_config_frame
                    && existing.can_id == item.can_id
                    && existing.send_to_can2 == item.send_to_can2
                {
                    existing.payload = item.payload;
                    existing.dlc = item.dlc;
                    existing.raw_data = item.raw_data;
                    return;
                }
            }

            if guard.tx_queue.len() >= 64 {
                if let Some(pos) = guard.tx_queue.iter().position(|it| !it.is_config_frame) {
                    guard.tx_queue.remove(pos);
                }
            }
            guard.tx_queue.push_back(item);
        }
    }

    fn spawn_worker(&self) {
        let inner = self.inner.clone();
        let ws_tx = self.ws_tx.clone();
        let rx_tx = self.rx_tx.clone();

        std::thread::spawn(move || {
            let mut stream_opt: Option<TcpStream> = None;
            let mut rx_buffer = [0u8; ANALYZER_RX_SIZE];
            let mut buffer_filled = 0usize;

            let mut last_rx_id = [0u16; 2];
            let mut last_rx_data = [[0u8; 8]; 2];
            let mut last_rx_publish_time0 = Instant::now() - Duration::from_millis(100);
            let mut last_rx_publish_time1 = Instant::now() - Duration::from_millis(100);

            let mut last_wire_send_time = Instant::now() - Duration::from_millis(100);
            let mut last_real_tx_time = Instant::now() - Duration::from_millis(100);
            let mut last_reconnect_attempt = Instant::now() - Duration::from_secs(2);

            loop {
                let (force_disc, force_reconn, auto_reconn, target_ip, target_port, can_channel) = {
                    let mut g = inner.lock().unwrap();
                    let fd = g.force_disconnect;
                    let fr = g.force_reconnect;
                    if fd {
                        g.force_disconnect = false;
                    }
                    (
                        fd,
                        fr,
                        g.auto_reconnect,
                        g.target_ip.clone(),
                        g.target_port,
                        g.can_channel.clone(),
                    )
                };

                if force_disc {
                    stream_opt = None;
                    buffer_filled = 0;
                    let status = {
                        let mut g = inner.lock().unwrap();
                        g.is_connected = false;
                        CanStatusEvent {
                            is_connected: false,
                            active_port: format!("{}:{}", g.target_ip, g.target_port),
                            bitrate: 1_000_000,
                            error_message: String::new(),
                            mode: "eth".to_string(),
                        }
                    };
                    let _ = ws_tx.send(WsEvent::CanStatus { data: status });
                }

                // 再接続または自動接続処理
                if force_reconn
                    || (stream_opt.is_none()
                        && auto_reconn
                        && last_reconnect_attempt.elapsed() >= Duration::from_millis(1500))
                {
                    last_reconnect_attempt = Instant::now();
                    stream_opt = None;
                    buffer_filled = 0;
                    last_rx_id = [0, 0];

                    let addr_str = format!("{}:{}", target_ip, target_port);
                    let connect_res = addr_str
                        .parse::<SocketAddr>()
                        .map_err(|e| format!("IPアドレス形式エラー: {}", e))
                        .and_then(|addr| {
                            TcpStream::connect_timeout(&addr, Duration::from_millis(1000))
                                .map_err(|e| format!("接続エラー: {}", e))
                        });

                    match connect_res {
                        Ok(sock) => {
                            // C++ altair_eth_can_bridge と同一のソケット属性を設定
                            // TCP_NODELAY 有効化、送受信タイムアウト設定 (ノンブロッキングにはしない)
                            let _ = sock.set_nodelay(true);
                            let _ = sock.set_read_timeout(Some(Duration::from_millis(2)));
                            let _ = sock.set_write_timeout(Some(Duration::from_millis(1000)));

                            stream_opt = Some(sock);
                            let status = {
                                let mut g = inner.lock().unwrap();
                                g.is_connected = true;
                                g.force_reconnect = false;
                                g.last_error.clear();
                                CanStatusEvent {
                                    is_connected: true,
                                    active_port: format!("{}:{}", g.target_ip, g.target_port),
                                    bitrate: 1_000_000,
                                    error_message: String::new(),
                                    mode: "eth".to_string(),
                                }
                            };
                            let _ = ws_tx.send(WsEvent::CanStatus { data: status });
                        }
                        Err(err_msg) => {
                            let mut g = inner.lock().unwrap();
                            g.is_connected = false;
                            if force_reconn {
                                g.force_reconnect = false;
                                g.last_error = err_msg;
                            }
                        }
                    }
                }

                // 送受信処理
                let mut disconnected_err: Option<String> = None;

                if let Some(sock) = stream_opt.as_mut() {
                    // 1. 受信処理 (60バイト固定長パケット)
                    let mut temp_buf = [0u8; 512];
                    match sock.read(&mut temp_buf) {
                        Ok(0) => {
                            disconnected_err = Some("TCP接続が切断されました".to_string());
                        }
                        Ok(n) => {
                            let mut offset = 0;
                            while offset < n {
                                let copy_len =
                                    (ANALYZER_RX_SIZE - buffer_filled).min(n - offset);
                                rx_buffer[buffer_filled..buffer_filled + copy_len]
                                    .copy_from_slice(&temp_buf[offset..offset + copy_len]);
                                buffer_filled += copy_len;
                                offset += copy_len;

                                if buffer_filled >= ANALYZER_RX_SIZE {
                                    buffer_filled = 0;
                                    Self::parse_and_publish_rx(
                                        &rx_buffer,
                                        &can_channel,
                                        &mut last_rx_id,
                                        &mut last_rx_data,
                                        &mut last_rx_publish_time0,
                                        &mut last_rx_publish_time1,
                                        &rx_tx,
                                    );
                                }
                            }
                        }
                        Err(ref e)
                            if e.kind() == ErrorKind::TimedOut
                                || e.kind() == ErrorKind::WouldBlock
                                || e.kind() == ErrorKind::Interrupted =>
                        {
                            // タイムアウトまたは待機継続 (正常動作)
                        }
                        Err(e) => {
                            disconnected_err = Some(format!("TCP受信エラー: {}", e));
                        }
                    }

                    // 2. 送信 / ポーリング処理 (20バイト固定長パケット)
                    // STM32の interrupt() タイマー (1ms) に配慮し、最低2.0msの間隔を空ける
                    if disconnected_err.is_none() {
                        let now = Instant::now();
                        let since_last_send_ms =
                            now.duration_since(last_wire_send_time).as_secs_f64() * 1000.0;

                        if since_last_send_ms >= 2.0 {
                            let next_item = {
                                let mut g = inner.lock().unwrap();
                                g.tx_queue.pop_front()
                            };

                            let mut tx_payload = [0u8; ANALYZER_TX_SIZE];
                            let mut has_real_tx = false;
                            let mut should_send_wire = false;
                            let mut event_to_send: Option<CanFrameEvent> = None;

                            if let Some(item) = next_item {
                                tx_payload.copy_from_slice(&item.payload);
                                has_real_tx = true;
                                should_send_wire = true;
                                event_to_send = Some(CanFrameEvent {
                                    direction: "TX".to_string(),
                                    channel: if item.send_to_can2 {
                                        "can2".to_string()
                                    } else {
                                        "can1".to_string()
                                    },
                                    id: item.can_id,
                                    dlc: item.dlc,
                                    data: item.raw_data,
                                });
                            } else {
                                let since_real_tx_ms =
                                    now.duration_since(last_real_tx_time).as_secs_f64() * 1000.0;
                                // 実フレーム送信直後はSTM32の eth_recv_data をゼロで上書きしないよう poll を抑制し、
                                // アイドル時は 5.0ms 周期で 20B ゼロパケットを送信して CAN RX を継続させる
                                if since_last_send_ms >= 5.0 && since_real_tx_ms >= 15.0 {
                                    tx_payload = [0u8; ANALYZER_TX_SIZE];
                                    should_send_wire = true;
                                }
                            }

                            if should_send_wire {
                                if let Err(e) = sock.write_all(&tx_payload) {
                                    disconnected_err = Some(format!("TCP送信エラー: {}", e));
                                } else {
                                    let _ = sock.flush();
                                    last_wire_send_time = now;
                                    if has_real_tx {
                                        last_real_tx_time = now;
                                    }
                                    if let Some(ev) = event_to_send {
                                        let _ = rx_tx.send(ev);
                                    }
                                }
                            }
                        }
                    }
                }

                if let Some(err) = disconnected_err {
                    stream_opt = None;
                    buffer_filled = 0;
                    let status = {
                        let mut g = inner.lock().unwrap();
                        g.is_connected = false;
                        g.last_error = err;
                        CanStatusEvent {
                            is_connected: false,
                            active_port: format!("{}:{}", g.target_ip, g.target_port),
                            bitrate: 1_000_000,
                            error_message: g.last_error.clone(),
                            mode: "eth".to_string(),
                        }
                    };
                    let _ = ws_tx.send(WsEvent::CanStatus { data: status });
                }

                std::thread::sleep(Duration::from_millis(1));
            }
        });
    }

    fn parse_and_publish_rx(
        buf: &[u8; ANALYZER_RX_SIZE],
        can_channel: &str,
        last_rx_id: &mut [u16; 2],
        last_rx_data: &mut [[u8; 8]; 2],
        last_rx_publish_time0: &mut Instant,
        last_rx_publish_time1: &mut Instant,
        rx_tx: &broadcast::Sender<CanFrameEvent>,
    ) {
        let now = Instant::now();

        // 1. CAN1 受信フレームの復元 (オフセット 0..9)
        if can_channel == "can1" || can_channel == "both" {
            let can1_id = (((buf[0] as u16) << 8) | (buf[1] as u16)) & 0x7FF;
            if can1_id != 0 {
                let mut current_data = [0u8; 8];
                current_data.copy_from_slice(&buf[2..10]);

                let changed = (can1_id != last_rx_id[0]) || (current_data != last_rx_data[0]);
                let elapsed_ms = now.duration_since(*last_rx_publish_time0).as_secs_f64() * 1000.0;

                // 内容変化時または最大10ms周期でパブリッシュ
                if changed || elapsed_ms >= 9.0 {
                    last_rx_id[0] = can1_id;
                    last_rx_data[0] = current_data;
                    *last_rx_publish_time0 = now;

                    let _ = rx_tx.send(CanFrameEvent {
                        direction: "RX".to_string(),
                        channel: "can1".to_string(),
                        id: can1_id,
                        dlc: 8,
                        data: current_data.to_vec(),
                    });
                }
            }
        }

        // 2. CAN2 受信フレームの復元 (オフセット 10..19)
        if can_channel == "can2" || can_channel == "both" {
            let can2_id = (((buf[10] as u16) << 8) | (buf[11] as u16)) & 0x7FF;
            if can2_id != 0 {
                let mut current_data = [0u8; 8];
                current_data.copy_from_slice(&buf[12..20]);

                let changed = (can2_id != last_rx_id[1]) || (current_data != last_rx_data[1]);
                let elapsed_ms = now.duration_since(*last_rx_publish_time1).as_secs_f64() * 1000.0;

                if changed || elapsed_ms >= 9.0 {
                    last_rx_id[1] = can2_id;
                    last_rx_data[1] = current_data;
                    *last_rx_publish_time1 = now;

                    let _ = rx_tx.send(CanFrameEvent {
                        direction: "RX".to_string(),
                        channel: "can2".to_string(),
                        id: can2_id,
                        dlc: 8,
                        data: current_data.to_vec(),
                    });
                }
            }
        }
    }
}
