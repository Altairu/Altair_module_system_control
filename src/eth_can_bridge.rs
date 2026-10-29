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
/// altair_eth_can_bridge の C++ 実装と同一の20B送信 / 60B受信プロトコルおよびタイミング制御を実装
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

        // ワーカーが接続を試行するのを少し待機して結果を返す
        let start = Instant::now();
        while start.elapsed() < Duration::from_millis(1400) {
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
            // 設定フレームはSTM32側の1msタイマーで確実に拾わせるため3回連続でキューに積む
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
            let mut last_rx_publish_time = [Instant::now() - Duration::from_secs(1); 2];

            let mut last_wire_send_time = Instant::now() - Duration::from_secs(1);
            let mut last_real_tx_time = Instant::now() - Duration::from_secs(1);
            let mut last_reconnect_attempt = Instant::now() - Duration::from_secs(2);

            loop {
                let (force_disc, force_reconn, auto_reconn, target_ip, target_port) = {
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
                            let _ = sock.set_nodelay(true);
                            let _ = sock.set_nonblocking(true);
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

                                if buffer_filled == ANALYZER_RX_SIZE {
                                    Self::parse_and_publish_rx(
                                        &rx_buffer,
                                        &mut last_rx_id,
                                        &mut last_rx_data,
                                        &mut last_rx_publish_time,
                                        &rx_tx,
                                    );
                                    buffer_filled = 0;
                                }
                            }
                        }
                        Err(ref e) if e.kind() == ErrorKind::WouldBlock => {}
                        Err(e) => {
                            disconnected_err = Some(format!("TCP受信エラー: {}", e));
                        }
                    }

                    // 2. 送信 / ポーリング処理 (20バイト固定長パケット)
                    if disconnected_err.is_none() {
                        let now = Instant::now();
                        let elapsed_since_wire =
                            now.duration_since(last_wire_send_time).as_secs_f64() * 1000.0;
                        let elapsed_since_real =
                            now.duration_since(last_real_tx_time).as_secs_f64() * 1000.0;

                        if elapsed_since_wire >= 2.0 {
                            let next_item = {
                                let mut g = inner.lock().unwrap();
                                g.tx_queue.pop_front()
                            };

                            if let Some(item) = next_item {
                                if let Err(e) = sock.write_all(&item.payload) {
                                    disconnected_err = Some(format!("TCP送信エラー: {}", e));
                                } else {
                                    last_wire_send_time = now;
                                    last_real_tx_time = now;
                                    let _ = rx_tx.send(CanFrameEvent {
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
                                }
                            } else if elapsed_since_wire >= 5.0 && elapsed_since_real >= 15.0 {
                                let zero_poll = [0u8; ANALYZER_TX_SIZE];
                                if let Err(e) = sock.write_all(&zero_poll) {
                                    disconnected_err =
                                        Some(format!("TCPポーリングエラー: {}", e));
                                } else {
                                    last_wire_send_time = now;
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
        last_rx_id: &mut [u16; 2],
        last_rx_data: &mut [[u8; 8]; 2],
        last_rx_publish_time: &mut [Instant; 2],
        rx_tx: &broadcast::Sender<CanFrameEvent>,
    ) {
        let now = Instant::now();

        for bus_idx in 0..2 {
            let base = bus_idx * 10;
            let raw_id = (((buf[base] as u16) << 8) | (buf[base + 1] as u16)) & 0x7FF;
            if raw_id == 0 {
                continue;
            }

            let mut current_data = [0u8; 8];
            current_data.copy_from_slice(&buf[base + 2..base + 10]);

            let elapsed_ms = now
                .duration_since(last_rx_publish_time[bus_idx])
                .as_secs_f64()
                * 1000.0;
            let is_duplicate =
                raw_id == last_rx_id[bus_idx] && current_data == last_rx_data[bus_idx];

            if !is_duplicate || elapsed_ms >= 9.0 {
                last_rx_id[bus_idx] = raw_id;
                last_rx_data[bus_idx] = current_data;
                last_rx_publish_time[bus_idx] = now;

                let _ = rx_tx.send(CanFrameEvent {
                    direction: "RX".to_string(),
                    channel: if bus_idx == 0 {
                        "can1".to_string()
                    } else {
                        "can2".to_string()
                    },
                    id: raw_id,
                    dlc: 8,
                    data: current_data.to_vec(),
                });
            }
        }
    }
}
