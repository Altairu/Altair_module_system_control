use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;

use crate::types::WsEvent;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

struct RunnerInner {
    child: Option<Child>,
    active_script: String,
    status: String,
}

/// Python 動作プログラム (Behavior) サブプロセス実行管理
#[derive(Clone)]
pub struct BehaviorRunner {
    project_root: PathBuf,
    behaviors_dir: PathBuf,
    config_path: PathBuf,
    server_port: u16,
    inner: Arc<Mutex<RunnerInner>>,
    ws_tx: broadcast::Sender<WsEvent>,
}

impl BehaviorRunner {
    pub fn new(
        project_root: PathBuf,
        config_path: PathBuf,
        server_port: u16,
        ws_tx: broadcast::Sender<WsEvent>,
    ) -> Self {
        let behaviors_dir = project_root.join("user_behaviors");
        let _ = fs::create_dir_all(&behaviors_dir);

        Self {
            project_root,
            behaviors_dir,
            config_path,
            server_port,
            inner: Arc::new(Mutex::new(RunnerInner {
                child: None,
                active_script: String::new(),
                status: "IDLE".to_string(),
            })),
            ws_tx,
        }
    }

    pub fn get_status_string(&self) -> String {
        let mut g = self.inner.lock().unwrap();
        if let Some(child) = g.child.as_mut() {
            if let Ok(Some(_)) = child.try_wait() {
                g.child = None;
                g.active_script.clear();
                g.status = "IDLE".to_string();
            }
        }
        g.status.clone()
    }

    pub fn list_behaviors(&self) -> Result<Vec<String>, String> {
        let entries = fs::read_dir(&self.behaviors_dir)
            .map_err(|e| format!("user_behaviors 読み込み失敗: {}", e))?;
        let mut list = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(".py") && !name.starts_with("__") {
                list.push(name);
            }
        }
        list.sort();
        Ok(list)
    }

    pub fn save_blockly(&self, code: &str, xml: &str) -> Result<String, String> {
        let _ = fs::create_dir_all(&self.behaviors_dir);
        let py_path = self.behaviors_dir.join("blockly_behavior.py");
        let xml_path = self.behaviors_dir.join("blockly_workspace.xml");
        fs::write(&py_path, code).map_err(|e| format!("Pythonコード保存失敗: {}", e))?;
        if !xml.is_empty() {
            fs::write(&xml_path, xml).map_err(|e| format!("XML保存失敗: {}", e))?;
        }
        Ok("Blocklyのプログラムを保存しました。".to_string())
    }

    pub fn get_blockly_workspace(&self) -> String {
        let xml_path = self.behaviors_dir.join("blockly_workspace.xml");
        fs::read_to_string(&xml_path).unwrap_or_default()
    }

    pub fn start_behavior(&self, script_name: &str) -> Result<String, String> {
        self.stop_behavior();

        let safe_name = PathBuf::from(script_name)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();

        if safe_name.is_empty() {
            return Err("スクリプト名が指定されていません。".to_string());
        }

        let script_path = self.behaviors_dir.join(&safe_name);
        if !script_path.exists() {
            return Err(format!("スクリプトが見つかりません: {}", safe_name));
        }

        let mut cmd = Command::new("python");
        cmd.arg("-u")
            .arg(&script_path)
            .current_dir(&self.project_root)
            .env("PYTHONUNBUFFERED", "1")
            .env("PYTHONIOENCODING", "utf-8")
            .env("PYTHONPATH", &self.project_root)
            .env("ALTAIR_CONFIG_PATH", &self.config_path)
            .env(
                "ALTAIR_WS_URL",
                format!("ws://127.0.0.1:{}/ws", self.server_port),
            )
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Pythonプロセスの起動に失敗しました: {}", e))?;

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        {
            let mut g = self.inner.lock().unwrap();
            g.active_script = safe_name.clone();
            g.status = format!("RUNNING: {}", safe_name);
            g.child = Some(child);
        }

        let _ = self.ws_tx.send(WsEvent::BehaviorStatus {
            data: format!("RUNNING: {}", safe_name),
        });

        if let Some(out) = stdout {
            let ws_tx = self.ws_tx.clone();
            let inner = self.inner.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(out);
                for line in reader.lines().map_while(Result::ok) {
                    let trimmed = line.trim();
                    if !trimmed.is_empty() {
                        let _ = ws_tx.send(WsEvent::BehaviorLog {
                            data: trimmed.to_string(),
                        });
                    }
                }
                let mut g = inner.lock().unwrap();
                if let Some(ch) = g.child.as_mut() {
                    if let Ok(Some(status)) = ch.try_wait() {
                        let code = status.code().unwrap_or(0);
                        g.child = None;
                        g.active_script.clear();
                        g.status = "IDLE".to_string();
                        let _ = ws_tx.send(WsEvent::BehaviorLog {
                            data: format!("[SYSTEM] スクリプトが終了しました (code={})", code),
                        });
                        let _ = ws_tx.send(WsEvent::BehaviorStatus {
                            data: "IDLE".to_string(),
                        });
                    }
                }
            });
        }

        if let Some(err) = stderr {
            let ws_tx = self.ws_tx.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(err);
                for line in reader.lines().map_while(Result::ok) {
                    let trimmed = line.trim();
                    if !trimmed.is_empty() {
                        let _ = ws_tx.send(WsEvent::BehaviorLog {
                            data: format!("[ERR] {}", trimmed),
                        });
                    }
                }
            });
        }

        Ok(format!(
            "動作スクリプト {} を正常に起動しました。",
            safe_name
        ))
    }

    pub fn stop_behavior(&self) -> String {
        let mut g = self.inner.lock().unwrap();
        if let Some(mut child) = g.child.take() {
            let _ = child.kill();
            let _ = child.wait();
            g.active_script.clear();
            g.status = "IDLE".to_string();
            let _ = self.ws_tx.send(WsEvent::BehaviorStatus {
                data: "IDLE".to_string(),
            });
            "動作スクリプトを正常に停止しました。".to_string()
        } else {
            g.status = "IDLE".to_string();
            "実行中のスクリプトはありません。".to_string()
        }
    }
}

