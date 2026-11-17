import base64
import json
import math
import os
import socket
import struct
import sys
import threading
import time
from urllib.parse import urlparse
import rclpy

# Windows環境下でのスリープおよびタイマー分解能を1msに高精度化
if sys.platform == "win32":
    try:
        import ctypes
        ctypes.windll.winmm.timeBeginPeriod(1)
    except Exception:
        pass


class _SimpleWsClient:
    """
    外部ライブラリ不要の標準ライブラリのみによる軽量WebSocketクライアント
    """

    def __init__(self, url, on_message, on_connect=None):
        self.url = url
        self.on_message = on_message
        self.on_connect = on_connect
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
        if parsed.query:
            path = f"{path}?{parsed.query}"

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
                if self.on_connect:
                    try:
                        self.on_connect()
                    except Exception:
                        pass
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
                        # Python Behaviorでは不要な raw_can_frame ログを早期破棄してパース負荷と遅延を排除
                        if b'"raw_can_frame"' in payload:
                            continue
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


class RobomasFeedback:
    """
    RoboMaster モーター フィードバックデータ構造 (altair_interfaces/msg/RobomasFeedback 互換)
    """

    def __init__(self):
        self.raw_angle = 0
        self.single_angle_deg = 0.0
        self.angle_deg = 0.0
        self.speed_rpm = 0
        self.torque_current = 0
        self.current_a = 0.0
        self.temperature = 0
        self.output_cmd = 0
        self.target = 0.0
        self.control_mode = "current"


class GamepadState:
    """
    ゲームコントローラーの各スイッチやスティックの入力を変数として保持するクラス
    """

    # 入力更新がこの秒数途絶えたらニュートラル値を返す (ネイティブ入力のキープアライブは 50ms 周期)
    STALE_TIMEOUT = 0.5

    def __init__(self):
        self.axes = [0.0] * 8
        self.buttons = [False] * 16
        self.last_updated = 0.0

    def get_button(self, index):
        # コントローラー切断や通信途絶時に最後の押下状態が残り続けないようにする
        if not self.is_connected(self.STALE_TIMEOUT):
            return False
        buttons = self.buttons
        if 0 <= index < len(buttons):
            return bool(buttons[index])
        return False

    def get_axis(self, index):
        # 途絶時に最後のスティック値が残るとロボットが走り続けるため 0.0 を返す
        if not self.is_connected(self.STALE_TIMEOUT):
            return 0.0
        axes = self.axes
        if 0 <= index < len(axes):
            return float(axes[index])
        return 0.0

    def is_connected(self, timeout=1.0):
        return (time.monotonic() - self.last_updated) < timeout


class MddClient:
    """
    MDD (モータドライバ) の制御用簡易ラッパークラス
    """

    def __init__(self, behavior, name):
        self.behavior = behavior
        self.name = name
        self.latest_feedback = MddFeedback()
        self._last_send_time = 0.0
        self._last_targets = None

    def set_targets(self, targets):
        # NaN / inf は json.dumps で "NaN" などの非標準JSONになり、サーバー側でパースに失敗して
        # コマンドが黙って捨てられる (= 直前の目標値で走り続ける)。安全側の 0.0 に置き換える
        float_targets = []
        for t in targets:
            v = float(t)
            float_targets.append(v if math.isfinite(v) else 0.0)
        now = time.monotonic()

        # ループ周期を最大200Hz (5ms) に安定制御し、メインスレッドのGIL独占とビジーループを完全に排除
        elapsed = now - self._last_send_time
        if elapsed < 0.005:
            time.sleep(0.005 - elapsed)
            now = time.monotonic()

        self._last_send_time = now
        self._last_targets = float_targets

        self.behavior._ws.send_json(
            {
                "type": "mdd_cmd",
                "name": self.name,
                "targets": float_targets
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
        elapsed = now - self._last_send_time
        if elapsed < 0.005:
            time.sleep(0.005 - elapsed)
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
        elapsed = now - self._last_send_time
        if elapsed < 0.005:
            time.sleep(0.005 - elapsed)
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


class RobomasClient:
    """
    RoboMaster モーター (M3508 / M2006 / GM6020) 制御用クライアントクラス
    """

    def __init__(self, behavior, name):
        self.behavior = behavior
        self.name = name
        self.latest_feedback = RobomasFeedback()
        self._last_send_time = 0.0

    def set_target(self, target, mode=None):
        val = float(target)
        if not math.isfinite(val):
            val = 0.0
        now = time.monotonic()
        elapsed = now - self._last_send_time
        if elapsed < 0.005:
            time.sleep(0.005 - elapsed)
            now = time.monotonic()
        self._last_send_time = now

        payload = {
            "type": "robomas_cmd",
            "name": self.name,
            "target": val,
        }
        if mode:
            payload["mode"] = str(mode)
        self.behavior._ws.send_json(payload)

    def set_current(self, current_cmd):
        """電流指令値を設定します (-16384〜16384)"""
        self.set_target(current_cmd, mode="current")

    def set_voltage(self, voltage_cmd):
        """電圧指令値を設定します (-30000〜30000, GM6020用)"""
        self.set_target(voltage_cmd, mode="voltage")

    def set_speed(self, rpm):
        """速度PIDの目標回転数 [rpm] を設定します"""
        self.set_target(rpm, mode="speed_pid")

    def set_position(self, deg):
        """位置PIDの目標角度 [deg] を設定します"""
        self.set_target(deg, mode="position_pid")

    def reset_zero(self):
        """多回転累積角度の現在位置を 0° にリセットします"""
        self.behavior._ws.send_json(
            {"type": "robomas_reset_zero", "name": self.name}
        )

    def stop(self):
        """出力をゼロにして停止します"""
        self.set_target(0.0, mode="current")

    def get_feedback(self):
        return self.latest_feedback


class RawCanClient:
    """
    任意の CAN ID に対する汎用バイト列送受信クライアント (Windows / ROS2 共通API)
    """

    _DTYPE_SPECS = {
        "uint8": ("<B", 1, 0, 255),
        "int8": ("<b", 1, -128, 127),
        "uint16_le": ("<H", 2, 0, 65535),
        "int16_le": ("<h", 2, -32768, 32767),
        "uint16_be": (">H", 2, 0, 65535),
        "int16_be": (">h", 2, -32768, 32767),
        "uint32_le": ("<I", 4, 0, 4294967295),
        "int32_le": ("<i", 4, -2147483648, 2147483647),
        "uint32_be": (">I", 4, 0, 4294967295),
        "int32_be": (">i", 4, -2147483648, 2147483647),
        "float32_le": ("<f", 4, None, None),
        "float32_be": (">f", 4, None, None),
    }

    def __init__(self, behavior):
        self.behavior = behavior
        self._lock = threading.Lock()
        self._rx_frames = {}
        self._subscribed_ids = set()
        self._warned_keys = set()
        self._last_send_times = {}

    def _warn_once(self, key, msg):
        with self._lock:
            if key in self._warned_keys:
                return
            self._warned_keys.add(key)
        self.behavior.get_logger().warn(msg)

    def _parse_can_id(self, can_id):
        try:
            if isinstance(can_id, bool):
                raise ValueError("bool is not valid CAN ID")
            if isinstance(can_id, int):
                sid = int(can_id)
            elif isinstance(can_id, float):
                if not math.isfinite(can_id) or not can_id.is_integer():
                    raise ValueError("non-integer float CAN ID")
                sid = int(can_id)
            else:
                s = str(can_id).strip()
                sid = int(s, 0)
            if 1 <= sid <= 0x7FF:
                return sid
        except Exception:
            pass
        self._warn_once(
            f"bad_id_{can_id}",
            f"無効な CAN ID '{can_id}' が指定されました (0x001〜0x7FF の標準IDを指定してください)。",
        )
        return None

    def _normalize_channel(self, channel):
        ch = str(channel or "default").strip().lower()
        if ch in ("can1", "can2", "both"):
            return ch
        return "default"

    def _update_rx_frame(self, can_id, data_bytes):
        sid = int(can_id) & 0x7FF
        if sid == 0:
            return
        with self._lock:
            self._rx_frames[sid] = bytes(data_bytes)[:8]

    def _resubscribe_all(self):
        with self._lock:
            ids = list(self._subscribed_ids)
        for sid in ids:
            self.behavior._ws.send_json({"type": "subscribe_can_id", "id": sid})

    def _ensure_subscribed(self, sid):
        need_sub = False
        with self._lock:
            if sid not in self._subscribed_ids:
                self._subscribed_ids.add(sid)
                need_sub = True
        if need_sub:
            self.behavior._ws.send_json({"type": "subscribe_can_id", "id": sid})
            # 初回購読時はキャッシュまたは直近フレームの到着を最大20ms待機
            for _ in range(4):
                with self._lock:
                    if sid in self._rx_frames:
                        break
                time.sleep(0.005)

    def has_frame(self, can_id):
        sid = self._parse_can_id(can_id)
        if sid is None:
            return False
        self._ensure_subscribed(sid)
        with self._lock:
            return sid in self._rx_frames

    def read_bytes(self, can_id):
        sid = self._parse_can_id(can_id)
        if sid is None:
            return []
        self._ensure_subscribed(sid)
        with self._lock:
            raw = self._rx_frames.get(sid)
        return list(raw) if raw is not None else []

    def read_byte(self, can_id, offset=0, default=0):
        return int(self.read_value(can_id, offset=offset, dtype="uint8", scale=1.0, default=default))

    def read_bit(self, can_id, offset=0, bit_idx=0):
        try:
            off = int(offset)
            bit = int(bit_idx)
        except Exception:
            return False
        if not (0 <= off < 8 and 0 <= bit < 8):
            return False
        sid = self._parse_can_id(can_id)
        if sid is None:
            return False
        self._ensure_subscribed(sid)
        with self._lock:
            raw = self._rx_frames.get(sid)
        if raw is None or len(raw) <= off:
            return False
        return bool((raw[off] >> bit) & 1)

    def read_value(self, can_id, offset=0, dtype="uint8", scale=1.0, default=0.0):
        sid = self._parse_can_id(can_id)
        if sid is None:
            return default
        spec = self._DTYPE_SPECS.get(str(dtype).strip().lower())
        if spec is None:
            self._warn_once(f"bad_dtype_{dtype}", f"未知のデータ型 '{dtype}' が指定されました。")
            return default
        fmt, size, _, _ = spec
        try:
            off = int(offset)
            sc = float(scale)
        except Exception:
            return default
        if off < 0 or off + size > 8:
            self._warn_once(
                f"bad_range_{off}_{size}",
                f"バイト位置の範囲外です (offset={off}, size={size} は 0〜7 バイトに収まる必要があります)。",
            )
            return default

        self._ensure_subscribed(sid)
        with self._lock:
            raw = self._rx_frames.get(sid)
        if raw is None or len(raw) < off + size:
            return default
        try:
            val = struct.unpack_from(fmt, raw, off)[0] * sc
            if not math.isfinite(val):
                return default
            return val
        except Exception:
            return default

    def send_bytes(self, can_id, data, channel="default"):
        sid = self._parse_can_id(can_id)
        if sid is None:
            return
        if isinstance(data, bool) or isinstance(data, (str, dict)):
            self._warn_once(
                "bad_tx_data_type",
                "send_bytes の data にはバイト配列 (list/tuple/bytes) を指定してください。",
            )
            return
        if isinstance(data, (int, float)):
            seq = [data]
        elif isinstance(data, (list, tuple, bytes, bytearray)):
            seq = list(data)
        else:
            self._warn_once(
                "bad_tx_data_type",
                "send_bytes の data にはバイト配列 (list/tuple/bytes) を指定してください。",
            )
            return
        payload = []
        for item in seq[:8]:
            try:
                if isinstance(item, bool):
                    v = int(item)
                else:
                    f = float(item)
                    if not math.isfinite(f):
                        v = 0
                    else:
                        v = int(round(f))
            except Exception:
                v = 0
            payload.append(max(0, min(255, v)))

        ch = self._normalize_channel(channel)
        rate_key = (sid, ch)
        sleep_sec = 0.0
        now = time.monotonic()
        with self._lock:
            next_allowed = self._last_send_times.get(rate_key, 0.0) + 0.0005
            if now < next_allowed:
                sleep_sec = next_allowed - now
                self._last_send_times[rate_key] = next_allowed
            else:
                self._last_send_times[rate_key] = now
        if sleep_sec > 0.0:
            time.sleep(sleep_sec)

        self.behavior._ws.send_json(
            {
                "type": "raw_can_tx",
                "id": sid,
                "data": payload,
                "channel": ch,
            }
        )

    def send_value(self, can_id, value, offset=0, dtype="int16_le", dlc=8, channel="default"):
        sid = self._parse_can_id(can_id)
        if sid is None:
            return
        spec = self._DTYPE_SPECS.get(str(dtype).strip().lower())
        if spec is None:
            self._warn_once(f"bad_dtype_{dtype}", f"未知のデータ型 '{dtype}' が指定されました。")
            return
        fmt, size, min_v, max_v = spec
        try:
            off = int(offset)
            req_dlc = int(dlc)
            fval = float(value)
        except Exception:
            return
        if off < 0 or off + size > 8:
            self._warn_once(
                f"bad_range_{off}_{size}",
                f"バイト位置の範囲外です (offset={off}, size={size} は 0〜7 バイトに収まる必要があります)。",
            )
            return
        if not math.isfinite(fval):
            fval = 0.0

        eff_dlc = max(off + size, min(8, req_dlc))
        buf = bytearray(eff_dlc)
        if min_v is not None and max_v is not None:
            ival = int(round(fval))
            ival = max(min_v, min(max_v, ival))
            struct.pack_into(fmt, buf, off, ival)
        else:
            struct.pack_into(fmt, buf, off, fval)

        self.send_bytes(sid, list(buf), channel=channel)


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
        self.can = RawCanClient(self)

        ws_url = os.getenv("ALTAIR_WS_URL", "ws://127.0.0.1:8000/ws?filter=behavior")
        self._ws = _SimpleWsClient(
            ws_url, self._on_ws_message, on_connect=self.can._resubscribe_all
        )

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
            if mtype in ("gamepad_state", "gamepad_input"):
                self.gamepad.axes = msg.get("axes", [])
                self.gamepad.buttons = msg.get("buttons", [])
                self.gamepad.last_updated = time.monotonic()
                if hasattr(self, "_gamepad_callback"):
                    try:
                        self._gamepad_callback(msg)
                    except Exception:
                        pass
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
            elif mtype == "robomas_feedback":
                name = msg.get("name")
                data = msg.get("data", {})
                client = self._module_clients.get(name)
                if isinstance(client, RobomasClient):
                    fb = RobomasFeedback()
                    fb.raw_angle = int(data.get("raw_angle", 0))
                    fb.single_angle_deg = float(data.get("single_angle_deg", 0.0))
                    fb.angle_deg = float(data.get("angle_deg", 0.0))
                    fb.speed_rpm = int(data.get("speed_rpm", 0))
                    fb.torque_current = int(data.get("torque_current", 0))
                    fb.current_a = float(data.get("current_a", 0.0))
                    fb.temperature = int(data.get("temperature", 0))
                    fb.output_cmd = int(data.get("output_cmd", 0))
                    fb.target = float(data.get("target", 0.0))
                    fb.control_mode = str(data.get("control_mode", "current"))
                    client.latest_feedback = fb
            elif mtype == "can_rx_frame":
                can_id = msg.get("id", 0)
                data = msg.get("data", [])
                self.can._update_rx_frame(can_id, bytes(int(x) & 0xFF for x in data))
        except Exception:
            pass

    def _load_config(self):
        env_path = os.getenv("ALTAIR_CONFIG_PATH") or os.getenv("ALTAIR_MODULES_CONFIG")
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
        elif mtype == "robomas":
            client = RobomasClient(self, name)
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

    def request_start_control(self, timeout_sec=2.0):
        """
        Webサーバーの /api/start_control にパラメータ一括送信と制御開始を要求します。
        """
        import urllib.request
        try:
            req = urllib.request.Request(
                "http://127.0.0.1:8000/api/start_control",
                data=b"{}",
                headers={"Content-Type": "application/json"},
                method="POST"
            )
            with urllib.request.urlopen(req, timeout=timeout_sec) as res:
                data = json.loads(res.read().decode("utf-8"))
                if data.get("success"):
                    self.get_logger().info(f"制御開始要求に成功しました: {data.get('message', '')}")
                    return True
                else:
                    self.get_logger().warn(f"制御開始要求が拒否されました: {data.get('message', '')}")
                    return False
        except Exception as e:
            self.get_logger().warn(f"制御開始要求の送信に失敗しました: {e}")
            return False

    def destroy_node(self):
        if self._ws:
            self._ws.close()

