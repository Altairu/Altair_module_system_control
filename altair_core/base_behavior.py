import base64
import json
import os
import socket
import struct
import threading
import time
from urllib.parse import urlparse
import rclpy


class _SimpleWsClient:
    """
    外部ライブラリ不要の標準ライブラリのみによる軽量WebSocketクライアント
    """

    def __init__(self, url, on_message):
        self.url = url
        self.on_message = on_message
        self.sock = None
        self.connected = False
        self._running = True
        self._send_lock = threading.Lock()
        self._rx_buf = bytearray()
        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._thread.start()

    def _read_exact(self, n):
        while len(self._rx_buf) < n:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("WebSocket closed")
            self._rx_buf.extend(chunk)
        out = bytes(self._rx_buf[:n])
        del self._rx_buf[:n]
        return out

    def _connect(self):
        parsed = urlparse(self.url)
        host = parsed.hostname or "127.0.0.1"
        port = parsed.port or 8000
        path = parsed.path or "/ws"

        s = socket.create_connection((host, port), timeout=2.0)
        s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        req = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            f"Upgrade: websocket\r\n"
            f"Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n\r\n"
        )
        s.sendall(req.encode("ascii"))

        header_buf = bytearray()
        while b"\r\n\r\n" not in header_buf:
            chunk = s.recv(1024)
            if not chunk:
                s.close()
                raise ConnectionError("WebSocket handshake failed")
            header_buf.extend(chunk)

        sep_idx = header_buf.index(b"\r\n\r\n") + 4
        self._rx_buf = header_buf[sep_idx:]
        s.settimeout(None)
        self.sock = s
        self.connected = True

    def _run_loop(self):
        while self._running:
            try:
                self._connect()
                while self._running and self.connected:
                    b0, b1 = self._read_exact(2)
                    opcode = b0 & 0x0F
                    masked = (b1 & 0x80) != 0
                    length = b1 & 0x7F
                    if length == 126:
                        length = struct.unpack("!H", self._read_exact(2))[0]
                    elif length == 127:
                        length = struct.unpack("!Q", self._read_exact(8))[0]

                    mask_key = self._read_exact(4) if masked else None
                    payload = self._read_exact(length) if length > 0 else b""
                    if masked and mask_key:
                        payload = bytes(
                            b ^ mask_key[i & 3] for i, b in enumerate(payload)
                        )

                    if opcode == 0x1:  # Text frame
                        text = payload.decode("utf-8", errors="ignore")
                        if self.on_message:
                            self.on_message(text)
                    elif opcode == 0x8:  # Close frame
                        break
                    elif opcode == 0x9:  # Ping -> Pong
                        self._send_frame(0xA, payload)
            except Exception:
                self.connected = False
                if self.sock:
                    try:
                        self.sock.close()
                    except Exception:
                        pass
                    self.sock = None
                time.sleep(0.5)

    def _send_frame(self, opcode, payload_bytes):
        if not self.connected or not self.sock:
            return
        length = len(payload_bytes)
        header = bytearray()
        header.append(0x80 | (opcode & 0x0F))
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", length))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack("!Q", length))

        mask = os.urandom(4)
        header.extend(mask)
        masked_payload = bytes(
            b ^ mask[i & 3] for i, b in enumerate(payload_bytes)
        )
        with self._send_lock:
            try:
                self.sock.sendall(header + masked_payload)
            except Exception:
                self.connected = False

    def send_json(self, obj):
        if not self.connected:
            return
        data = json.dumps(obj).encode("utf-8")
        self._send_frame(0x1, data)

    def close(self):
        self._running = False
        self.connected = False
        if self.sock:
            try:
                self.sock.close()
            except Exception:
                pass
            self.sock = None


class _BehaviorLogger:
    def __init__(self, node_name):
        self.node_name = node_name

    def info(self, msg):
        print(f"[INFO] [{self.node_name}]: {msg}", flush=True)

    def warn(self, msg):
        print(f"[WARN] [{self.node_name}]: {msg}", flush=True)

    def warning(self, msg):
        print(f"[WARN] [{self.node_name}]: {msg}", flush=True)

    def error(self, msg):
        print(f"[ERROR] [{self.node_name}]: {msg}", flush=True)


class MddFeedback:
    """
    MDDフィードバックデータ構造 (altair_interfaces/msg/MddFeedback 互換)
    """

    def __init__(self):
        self.limit_switches = [False, False, False, False]
        self.error_code = 0
        self.system_status = 0
        self.angles = [0.0, 0.0, 0.0, 0.0]
        self.speeds = [0.0, 0.0, 0.0, 0.0]


class GamepadState:
    """
    ゲームコントローラーの各スイッチやスティックの入力を変数として保持するクラス
    """

    def __init__(self):
        self.axes = [0.0] * 8
        self.buttons = [False] * 16

    def get_button(self, index):
        if 0 <= index < len(self.buttons):
            return bool(self.buttons[index])
        return False

    def get_axis(self, index):
        if 0 <= index < len(self.axes):
            return float(self.axes[index])
        return 0.0


class MddClient:
    """
    MDD (モータドライバ) の制御用簡易ラッパークラス
    """

    def __init__(self, behavior, name):
        self.behavior = behavior
        self.name = name
        self.latest_feedback = MddFeedback()
        self._last_send_time = 0.0

    def set_targets(self, targets):
        now = time.monotonic()
        # Blockly の while True ループ内に sleep が無い場合でもCPU100%や通信飽和を防ぐ
        if now - self._last_send_time < 0.002:
            time.sleep(0.002)
            now = time.monotonic()
        self._last_send_time = now

        self.behavior._ws.send_json(
            {
                "type": "mdd_cmd",
                "name": self.name,
                "targets": [float(t) for t in targets]
            }
        )

    def get_feedback(self):
        return self.latest_feedback


class ServoClient:
    """
    Servo (6ch サーボモジュール) の制御用簡易ラッパークラス
    """

    def __init__(self, behavior, name):
        self.behavior = behavior
        self.name = name
        self._last_send_time = 0.0

    def set_angles(self, angles):
        now = time.monotonic()
        if now - self._last_send_time < 0.002:
            time.sleep(0.002)
            now = time.monotonic()
        self._last_send_time = now

        self.behavior._ws.send_json(
            {
                "type": "servo_cmd",
                "name": self.name,
                "angles": [int(a) for a in angles]
            }
        )


class SolenoidClient:
    """
    Solenoid Valve (12ch 電磁弁) の制御用簡易ラッパークラス
    """

    def __init__(self, behavior, name):
        self.behavior = behavior
        self.name = name
        self.valves_state = [False] * 12
        self._last_send_time = 0.0

    def set_valves(self, valves):
        now = time.monotonic()
        if now - self._last_send_time < 0.002:
            time.sleep(0.002)
            now = time.monotonic()
        self._last_send_time = now

        self.valves_state = [bool(v) for v in valves]
        self.behavior._ws.send_json(
            {
                "type": "solenoid_cmd",
                "name": self.name,
                "valves": self.valves_state
            }
        )

    def set_valve(self, channel, state):
        if 1 <= channel <= 12:
            self.valves_state[channel - 1] = bool(state)
            self.set_valves(self.valves_state)


class AltairBehavior:
    """
    すべてのユーザー動作プログラム（Behavior）のベースクラス (ROS2不要スタンドアロン対応版)
    altair_framework の AltairBehavior と完全互換のAPIを提供します。
    """

    def __init__(self, node_name="user_behavior_node"):
        self.node_name = node_name
        self._logger = _BehaviorLogger(node_name)
        self._module_clients = {}

        self.config = self._load_config()
        self.gamepad = GamepadState()

        ws_url = os.getenv("ALTAIR_WS_URL", "ws://127.0.0.1:8000/ws")
        self._ws = _SimpleWsClient(ws_url, self._on_ws_message)

        # WebSocket接続完了を少し待つ (最大0.3秒)
        for _ in range(30):
            if self._ws.connected:
                break
            time.sleep(0.01)

        self.on_init()
        self.get_logger().info(f"動作プログラム {node_name} が初期化されました。")

    def get_logger(self):
        return self._logger

    def _on_ws_message(self, text):
        try:
            msg = json.loads(text)
            mtype = msg.get("type")
            if mtype == "gamepad_state":
                self.gamepad.axes = msg.get("axes", [])
                self.gamepad.buttons = msg.get("buttons", [])
            elif mtype == "mdd_feedback":
                name = msg.get("name")
                data = msg.get("data", {})
                client = self._module_clients.get(name)
                if isinstance(client, MddClient):
                    fb = MddFeedback()
                    fb.limit_switches = [
                        bool(x)
                        for x in data.get(
                            "limit_switches", [False, False, False, False]
                        )
                    ]
                    fb.error_code = int(data.get("error_code", 0))
                    fb.system_status = int(data.get("system_status", 0))
                    fb.angles = [
                        float(x)
                        for x in data.get("angles", [0.0, 0.0, 0.0, 0.0])
                    ]
                    fb.speeds = [
                        float(x)
                        for x in data.get("speeds", [0.0, 0.0, 0.0, 0.0])
                    ]
                    client.latest_feedback = fb
        except Exception:
            pass

    def _load_config(self):
        env_path = os.getenv("ALTAIR_MODULES_CONFIG")
        this_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        paths = [
            env_path,
            os.path.join(this_dir, "config", "modules_config.json"),
            "config/modules_config.json",
            "modules_config.json"
        ]
        for p in paths:
            if p and os.path.exists(p):
                try:
                    with open(p, "r", encoding="utf-8") as f:
                        return json.load(f)
                except Exception:
                    pass
        return {"modules": []}

    def get_module(self, name):
        if name in self._module_clients:
            return self._module_clients[name]

        mtype = None
        for module in self.config.get("modules", []):
            if module.get("name") == name:
                mtype = module.get("type")
                break

        if not mtype:
            self.get_logger().error(
                f"設定ファイル内にモジュール名 '{name}' が見つかりませんでした。"
            )
            raise ValueError(f"Module '{name}' not found in configuration.")

        if mtype == "mdd":
            client = MddClient(self, name)
        elif mtype == "servo":
            client = ServoClient(self, name)
        elif mtype == "solenoid":
            client = SolenoidClient(self, name)
        else:
            self.get_logger().error(f"未知のモジュールタイプ: '{mtype}'")
            raise ValueError(f"Unknown module type '{mtype}'")

        self._module_clients[name] = client
        return client

    def on_init(self):
        pass

    def loop(self):
        pass

    def run(self, rate_hz=500.0):
        period = 1.0 / max(1.0, float(rate_hz))
        try:
            self.get_logger().info(
                f"周期実行ループを開始します (周波数: {rate_hz} Hz)..."
            )
            while rclpy.ok():
                t0 = time.monotonic()
                self.loop()
                elapsed = time.monotonic() - t0
                if elapsed < period:
                    time.sleep(period - elapsed)
        except KeyboardInterrupt:
            pass
        finally:
            self.destroy_node()

    def destroy_node(self):
        if self._ws:
            self._ws.close()

