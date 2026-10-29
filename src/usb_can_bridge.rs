use std::collections::VecDeque;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::broadcast;

use crate::types::{CanFrameEvent, CanStatusEvent, WsEvent};

struct UsbInner {
    active_port: String,
    is_connected: bool,
    last_error: String,
    tx_queue: VecDeque<(u16, Vec<u8>)>,
    connect_req: Option<String>,
    disconnect_req: bool,
}

/// USB-to-CAN (slcan) シリアル通信ブリッジ
#[derive(Clone)]
pub struct UsbCanBridge {
    inner: Arc<Mutex<UsbInner>>,
    ws_tx: broadcast::Sender<WsEvent>,
    rx_tx: broadcast::Sender<CanFrameEvent>,
}

impl UsbCanBridge {
    pub fn new(
        ws_tx: broadcast::Sender<WsEvent>,
        rx_tx: broadcast::Sender<CanFrameEvent>,
    ) -> Self {
        let bridge = Self {
            inner: Arc::new(Mutex::new(UsbInner {
                active_port: String::new(),
                is_connected: false,
                last_error: String::new(),
                tx_queue: VecDeque::new(),
                connect_req: None,
                disconnect_req: false,
            })),
            ws_tx,
            rx_tx,
        };

        bridge.spawn_worker();
        bridge
    }

    /// PCに接続されているシリアルポート一覧を取得
    pub fn get_available_ports() -> Vec<String> {
        match serialport::available_ports() {
            Ok(ports) => ports.into_iter().map(|p| p.port_name).collect(),
            Err(_) => Vec::new(),
        }
    }

    pub fn get_status(&self) -> CanStatusEvent {
        let g = self.inner.lock().unwrap();
        CanStatusEvent {
            is_connected: g.is_connected,
            active_port: g.active_port.clone(),
            bitrate: 1_000_000,
            error_message: g.last_error.clone(),
            mode: "usb".to_string(),
        }
    }

    pub fn connect(&self, port: String, auto_connect: bool) -> Result<String, String> {
        let target_port = if auto_connect || port.trim().is_empty() {
            let ports = Self::get_available_ports();
            if let Some(first) = ports.into_iter().next() {
                first
            } else {
                return Err("利用可能なシリアルポートが見つかりません。".to_string());
            }
        } else {
            port.trim().to_string()
        };

        {
            let mut g = self.inner.lock().unwrap();
            g.disconnect_req = false;
            g.connect_req = Some(target_port.clone());
            g.last_error.clear();
            g.tx_queue.clear();
        }

        let start = Instant::now();
        while start.elapsed() < Duration::from_millis(1200) {
            std::thread::sleep(Duration::from_millis(25));
            let g = self.inner.lock().unwrap();
            if g.is_connected && g.connect_req.is_none() {
                return Ok(format!(
                    "USB-CAN アダプタ ({}) へ接続しました。",
                    target_port
                ));
            }
            if g.connect_req.is_none() && !g.last_error.is_empty() {
                return Err(g.last_error.clone());
            }
        }

        let g = self.inner.lock().unwrap();
        if g.is_connected {
            Ok(format!(
                "USB-CAN アダプタ ({}) へ接続しました。",
                target_port
            ))
        } else {
            Err(if g.last_error.is_empty() {
                format!("ポート {} のオープンがタイムアウトしました。", target_port)
            } else {
                g.last_error.clone()
            })
        }
    }

    pub fn disconnect(&self) {
        let mut g = self.inner.lock().unwrap();
        g.disconnect_req = true;
        g.connect_req = None;
        g.is_connected = false;
        g.tx_queue.clear();
    }

    pub fn send_can_frame(&self, id: u16, data: &[u8]) {
        let mut g = self.inner.lock().unwrap();
        if !g.is_connected {
            return;
        }
        let standard_id = id & 0x7FF;
        if standard_id == 0 {
            return;
        }
        let dlc = data.len().min(8);
        if g.tx_queue.len() >= 128 {
            g.tx_queue.pop_front();
        }
        g.tx_queue.push_back((standard_id, data[..dlc].to_vec()));
    }

    fn spawn_worker(&self) {
        let inner = self.inner.clone();
        let ws_tx = self.ws_tx.clone();
        let rx_tx = self.rx_tx.clone();

        std::thread::spawn(move || {
            let mut port_opt: Option<Box<dyn serialport::SerialPort>> = None;
            let mut rx_line_buf = String::new();

            loop {
                let (disc_req, conn_req) = {
                    let mut g = inner.lock().unwrap();
                    let d = g.disconnect_req;
                    let c = g.connect_req.take();
                    if d {
                        g.disconnect_req = false;
                    }
                    (d, c)
                };

                if disc_req {
                    if let Some(mut p) = port_opt.take() {
                        let _ = p.write_all(b"C\r");
                    }
                    rx_line_buf.clear();
                    let status = {
                        let mut g = inner.lock().unwrap();
                        g.is_connected = false;
                        CanStatusEvent {
                            is_connected: false,
                            active_port: String::new(),
                            bitrate: 1_000_000,
                            error_message: String::new(),
                            mode: "usb".to_string(),
                        }
                    };
                    let _ = ws_tx.send(WsEvent::CanStatus { data: status });
                }

                if let Some(port_name) = conn_req {
                    if let Some(mut p) = port_opt.take() {
                        let _ = p.write_all(b"C\r");
                    }
                    rx_line_buf.clear();

                    match serialport::new(&port_name, 115_200)
                        .timeout(Duration::from_millis(2))
                        .open()
                    {
                        Ok(mut p) => {
                            // slcan 1Mbps (S8) 設定とチャンネルオープン (O)
                            let _ = p.write_all(b"C\rS8\rO\r");
                            port_opt = Some(p);
                            let status = {
                                let mut g = inner.lock().unwrap();
                                g.is_connected = true;
                                g.active_port = port_name;
                                g.last_error.clear();
                                CanStatusEvent {
                                    is_connected: true,
                                    active_port: g.active_port.clone(),
                                    bitrate: 1_000_000,
                                    error_message: String::new(),
                                    mode: "usb".to_string(),
                                }
                            };
                            let _ = ws_tx.send(WsEvent::CanStatus { data: status });
                        }
                        Err(e) => {
                            let mut g = inner.lock().unwrap();
                            g.is_connected = false;
                            g.last_error = format!("シリアルポート接続エラー: {}", e);
                        }
                    }
                }

                let mut io_err: Option<String> = None;

                if let Some(p) = port_opt.as_mut() {
                    // 送信処理
                    loop {
                        let next_tx = {
                            let mut g = inner.lock().unwrap();
                            g.tx_queue.pop_front()
                        };
                        if let Some((can_id, data)) = next_tx {
                            let dlc = data.len().min(8);
                            let mut cmd = format!("t{:03X}{:X}", can_id, dlc);
                            for b in &data[..dlc] {
                                cmd.push_str(&format!("{:02X}", b));
                            }
                            cmd.push('\r');
                            if let Err(e) = p.write_all(cmd.as_bytes()) {
                                io_err = Some(format!("slcan送信エラー: {}", e));
                                break;
                            } else {
                                let _ = rx_tx.send(CanFrameEvent {
                                    direction: "TX".to_string(),
                                    channel: "usb".to_string(),
                                    id: can_id,
                                    dlc: dlc as u8,
                                    data,
                                });
                            }
                        } else {
                            break;
                        }
                    }

                    // 受信処理
                    let mut buf = [0u8; 256];
                    match p.read(&mut buf) {
                        Ok(n) if n > 0 => {
                            for &b in &buf[..n] {
                                if b == b'\r' || b == b'\n' {
                                    if !rx_line_buf.is_empty() {
                                        Self::parse_slcan_line(&rx_line_buf, &rx_tx);
                                        rx_line_buf.clear();
                                    }
                                } else if rx_line_buf.len() < 64 {
                                    rx_line_buf.push(b as char);
                                } else {
                                    rx_line_buf.clear();
                                }
                            }
                        }
                        Ok(_) => {}
                        Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                        Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                        Err(e) => {
                            io_err = Some(format!("slcan受信エラー: {}", e));
                        }
                    }
                }

                if let Some(err) = io_err {
                    port_opt = None;
                    let status = {
                        let mut g = inner.lock().unwrap();
                        g.is_connected = false;
                        g.last_error = err;
                        CanStatusEvent {
                            is_connected: false,
                            active_port: g.active_port.clone(),
                            bitrate: 1_000_000,
                            error_message: g.last_error.clone(),
                            mode: "usb".to_string(),
                        }
                    };
                    let _ = ws_tx.send(WsEvent::CanStatus { data: status });
                }

                std::thread::sleep(Duration::from_millis(1));
            }
        });
    }

    fn parse_slcan_line(line: &str, rx_tx: &broadcast::Sender<CanFrameEvent>) {
        // 標準フレーム: tIIILDD...
        let bytes = line.as_bytes();
        if bytes.len() < 5 || bytes[0] != b't' {
            return;
        }
        let Ok(can_id) = u16::from_str_radix(&line[1..4], 16) else {
            return;
        };
        let Ok(dlc) = usize::from_str_radix(&line[4..5], 16) else {
            return;
        };
        let dlc = dlc.min(8);
        if line.len() < 5 + dlc * 2 {
            return;
        }
        let mut data = Vec::with_capacity(dlc);
        for i in 0..dlc {
            let start = 5 + i * 2;
            if let Ok(val) = u8::from_str_radix(&line[start..start + 2], 16) {
                data.push(val);
            } else {
                return;
            }
        }

        let _ = rx_tx.send(CanFrameEvent {
            direction: "RX".to_string(),
            channel: "usb".to_string(),
            id: can_id,
            dlc: dlc as u8,
            data,
        });
    }
}

