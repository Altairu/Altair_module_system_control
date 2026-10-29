/* ==========================================================================
   Altair Web Controller v2 - ゲームコントローラー変数化 ＆ モニター JavaScript
   機能: Web Gamepad API 連携, 入力周期送信 (20Hz), リアルタイムインプットモニター
   ========================================================================== */

document.addEventListener("DOMContentLoaded", () => {
  // コントローラ状態管理
  const state = {
    gamepadIdx: null,
    intervalId: null,
    prevButtons: [],
    axesCount: 4,
    buttonsCount: 16
  };

  const el = {
    indicator: document.getElementById("gamepad-status-indicator"),
    mappingsBody: document.getElementById("gamepad-mappings-body"),
    btnAddMapping: document.getElementById("btn-add-mapping"),
    terminal: document.getElementById("behavior-terminal")
  };

  // 直接マッピング追加ボタンなどは非表示またはラベル変更
  if (el.btnAddMapping) {
    el.btnAddMapping.style.display = "none"; // マッピング不要になったため非表示
  }

  // --- 1. Gamepad API イベントハンドリング ---
  window.addEventListener("gamepadconnected", (e) => {
    console.log("コントローラーが接続されました:", e.gamepad.id);
    state.gamepadIdx = e.gamepad.index;
    
    // UI表示の更新
    const icon = el.indicator.querySelector(".gamepad-icon");
    if (icon) icon.className = "fa-solid fa-gamepad gamepad-icon connected";
    
    const text = el.indicator.querySelector(".ctrl-status-text");
    if (text) text.textContent = `Connected: ${e.gamepad.id.substring(0, 24)}...`;

    appendLog(`[SYSTEM] コントローラーが接続されました: ${e.gamepad.id}`, "system-msg");

    // ダッシュボード表示の更新
    const dashDisconnected = document.getElementById("dashboard-gamepad-disconnected");
    const dashConnected = document.getElementById("dashboard-gamepad-connected");
    if (dashDisconnected) dashDisconnected.style.display = "none";
    if (dashConnected) dashConnected.style.display = "flex";

    // 周期（20Hz = 50ms）で WebSocket 送信＆モニター描画を行うタイマーを開始
    startGamepadPolling();
  });

  window.addEventListener("gamepaddisconnected", (e) => {
    if (state.gamepadIdx === e.gamepad.index) {
      console.log("コントローラーが切断されました。");
      state.gamepadIdx = null;
      
      // UIの初期化
      const icon = el.indicator.querySelector(".gamepad-icon");
      if (icon) icon.className = "fa-solid fa-gamepad gamepad-icon disconnected";
      
      const text = el.indicator.querySelector(".ctrl-status-text");
      if (text) text.textContent = "Not Connected (コントローラー未接続)";
      
      appendLog("[SYSTEM] コントローラーが切断されました。", "warning-msg");

      // ダッシュボード表示の更新
      const dashDisconnected = document.getElementById("dashboard-gamepad-disconnected");
      const dashConnected = document.getElementById("dashboard-gamepad-connected");
      if (dashDisconnected) dashDisconnected.style.display = "block";
      if (dashConnected) dashConnected.style.display = "none";

      // タイマー停止
      stopGamepadPolling();
      renderDisconnectedMonitor();
    }
  });

  // --- 2. リアルタイムモニター表示の描画 ---
  function initMonitorTable() {
    if (!el.mappingsBody) return;
    el.mappingsBody.innerHTML = "";
    
    // アナログスティック軸モニター (4ch分)
    for (let i = 0; i < state.axesCount; i++) {
      let label = "";
      if (i === 0) label = "L-Stick 左右 (X)";
      else if (i === 1) label = "L-Stick 上下 (Y)";
      else if (i === 2) label = "R-Stick 左右 (X)";
      else if (i === 3) label = "R-Stick 上下 (Y)";
      else label = `Axis ${i}`;

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><i class="fa-solid fa-arrows-up-down-left-right"></i> ${label}</td>
        <td><code>self.gamepad.get_axis(${i})</code></td>
        <td colspan="3">
          <div class="progress-bar-container" style="background: #e8eaed; border-radius: 10px; height: 16px; width: 100%; position: relative; overflow: hidden;">
            <div id="monitor-axis-${i}" class="progress-bar" style="background: var(--color-primary); height: 100%; width: 50%; margin-left: 0; transition: width 0.05s ease; border-radius: 10px;"></div>
            <span id="monitor-axis-val-${i}" style="position: absolute; width: 100%; text-align: center; top: 0; font-size: 11px; font-weight: 700; color: #202124; line-height: 16px;">0.00</span>
          </div>
        </td>
      `;
      el.mappingsBody.appendChild(tr);
    }

    // 主要ボタンモニター (全16ch分 - 十字キー含む)
    const btnLabels = [
      "A / ×", "B / ○", "X / □", "Y / △",
      "L1", "R1", "L2", "R2",
      "Select / Share", "Start / Options",
      "L-Stick クリック", "R-Stick クリック",
      "D-Pad ↑", "D-Pad ↓", "D-Pad ←", "D-Pad →"
    ];
    for (let i = 0; i < btnLabels.length; i++) {
      const isDpad = i >= 12;
      const icon = isDpad ? "fa-solid fa-circle-arrow-" + ["up","down","left","right"][i-12] : "fa-solid fa-circle-dot";
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><i class="${icon}"></i> ${btnLabels[i]}</td>
        <td><code>self.gamepad.get_button(${i})</code></td>
        <td colspan="3">
          <span id="monitor-btn-${i}" class="badge badge-secondary">OFF</span>
        </td>
      `;
      el.mappingsBody.appendChild(tr);
    }
  }

  function renderDisconnectedMonitor() {
    if (!el.mappingsBody) return;
    el.mappingsBody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align: center; color: var(--text-muted); padding: 30px 0;">
          <i class="fa-solid fa-gamepad" style="font-size: 32px; margin-bottom: 10px; display: block; color: var(--text-muted);"></i>
          コントローラーが接続されていません。ボタンやスティックの値を検出すると、ここにリアルタイムに値と変数名（Blocklyやコードで参照可能）が表示されます。
        </td>
      </tr>`;
  }

  // --- 3. コントローラー状態のサンプリング ＆ 送信タイマー ---
  function startGamepadPolling() {
    stopGamepadPolling();
    initMonitorTable();

    // ダッシュボード表示を接続状態に更新（念のため）
    const dashDisconnected = document.getElementById("dashboard-gamepad-disconnected");
    const dashConnected = document.getElementById("dashboard-gamepad-connected");
    if (dashDisconnected) dashDisconnected.style.display = "none";
    if (dashConnected) dashConnected.style.display = "flex";

    state.intervalId = setInterval(pollAndSendGamepad, 50); // 20Hz
  }

  function stopGamepadPolling() {
    if (state.intervalId) {
      clearInterval(state.intervalId);
      state.intervalId = null;
    }
  }

  function pollAndSendGamepad() {
    if (state.gamepadIdx === null) return;

    const gamepads = navigator.getGamepads();
    const gp = gamepads[state.gamepadIdx];
    if (!gp) return;

    // デッドバンド (遊び) を適用したスティック値の取得
    const DEADBAND = 0.05;
    const axesData = gp.axes.map(v => {
      let val = v;
      if (Math.abs(val) < DEADBAND) val = 0.0;
      return parseFloat(val.toFixed(3));
    });

    // ボタンの押し下げ状態の取得
    const buttonsData = gp.buttons.map(b => b.pressed);

    // WebSocket経由で操縦PC(ROS2ノード)へ送信
    const mainWs = window.appWs || window.parent.appWs;
    if (mainWs && mainWs.readyState === WebSocket.OPEN) {
      mainWs.send(JSON.stringify({
        type: "gamepad_state",
        axes: axesData,
        buttons: buttonsData
      }));
    }

    // 画面モニターの更新
    updateMonitorUI(axesData, buttonsData);
  }

  // リアルタイムインプットモニターの描画更新
  function updateMonitorUI(axes, buttons) {
    // 1. スティック軸の描画更新
    for (let i = 0; i < state.axesCount; i++) {
      const bar = document.getElementById(`monitor-axis-${i}`);
      const text = document.getElementById(`monitor-axis-val-${i}`);
      if (bar && text && i < axes.length) {
        const val = axes[i];
        // -1.0〜1.0 の値を progress のパーセンテージ幅に変換
        // -1.0 ➔ 0%、0 ➔ 50%、1.0 ➔ 100%
        const percent = ((val + 1.0) / 2.0) * 100;
        bar.style.width = `${percent}%`;
        text.textContent = val.toFixed(2);
        
        // ニュートラル(0)からの離脱によって色を変える
        if (Math.abs(val) > 0.1) {
          bar.style.backgroundColor = "var(--color-primary)";
        } else {
          bar.style.backgroundColor = "#bdc1c6";
        }
      }
    }

    // 2. ボタンの描画更新（全16ボタン: A/B/X/Y/L1/R1/L2/R2/Share/Start/L3/R3/D-Pad4方向）
    for (let i = 0; i < 16; i++) {
      const btnBadge = document.getElementById(`monitor-btn-${i}`);
      if (btnBadge && i < buttons.length) {
        const isPressed = buttons[i];
        if (isPressed) {
          btnBadge.textContent = "ON";
          btnBadge.className = "badge badge-success";
          btnBadge.style.boxShadow = "0 2px 4px rgba(19, 115, 51, 0.3)";
        } else {
          btnBadge.textContent = "OFF";
          btnBadge.className = "badge badge-secondary";
          btnBadge.style.boxShadow = "none";
        }
      }
    }

    // 3. Dashboard用 Gamepad Monitor の描画更新
    if (axes.length >= 4) {
      const lx = axes[0];
      const ly = axes[1];
      const rx = axes[2];
      const ry = axes[3];

      // L-Stickテキストとバー
      const lblLStick = document.getElementById("lbl-dash-lstick");
      if (lblLStick) lblLStick.textContent = `X: ${lx.toFixed(2)} | Y: ${ly.toFixed(2)}`;

      const barLx = document.getElementById("bar-dash-lx");
      if (barLx) {
        const percentLx = ((lx + 1.0) / 2.0) * 100;
        barLx.style.width = `${percentLx}%`;
        barLx.style.backgroundColor = Math.abs(lx) > 0.1 ? "var(--color-primary)" : "#bdc1c6";
      }

      const barLy = document.getElementById("bar-dash-ly");
      if (barLy) {
        const percentLy = ((ly + 1.0) / 2.0) * 100;
        barLy.style.width = `${percentLy}%`;
        barLy.style.backgroundColor = Math.abs(ly) > 0.1 ? "var(--color-primary)" : "#bdc1c6";
      }

      // R-Stickテキストとバー
      const lblRStick = document.getElementById("lbl-dash-rstick");
      if (lblRStick) lblRStick.textContent = `X: ${rx.toFixed(2)} | Y: ${ry.toFixed(2)}`;

      const barRx = document.getElementById("bar-dash-rx");
      if (barRx) {
        const percentRx = ((rx + 1.0) / 2.0) * 100;
        barRx.style.width = `${percentRx}%`;
        barRx.style.backgroundColor = Math.abs(rx) > 0.1 ? "var(--color-primary)" : "#bdc1c6";
      }

      const barRy = document.getElementById("bar-dash-ry");
      if (barRy) {
        const percentRy = ((ry + 1.0) / 2.0) * 100;
        barRy.style.width = `${percentRy}%`;
        barRy.style.backgroundColor = Math.abs(ry) > 0.1 ? "var(--color-primary)" : "#bdc1c6";
      }
    }

    // Dashboard用ボタンの描画更新（A/B/X/Y/L1/R1/L2/R2 + 十字キー4方向）
    for (let i = 0; i < 12; i++) {
      const btnDash = document.getElementById(`btn-dash-${i}`);
      if (btnDash && i < buttons.length) {
        const isPressed = buttons[i];
        if (isPressed) {
          btnDash.className = "badge badge-success";
          btnDash.style.boxShadow = "0 2px 4px rgba(19, 115, 51, 0.3)";
        } else {
          btnDash.className = "badge badge-secondary";
          btnDash.style.boxShadow = "none";
        }
      }
    }
  }

  function appendLog(text, className = "") {
    if (el.terminal) {
      const line = document.createElement("div");
      line.className = `terminal-line ${className}`;
      line.textContent = `[CONTROLLER] ${text}`;
      el.terminal.appendChild(line);
      el.terminal.scrollTop = el.terminal.scrollHeight;
    }
  }

  // 初期化時の描画
  renderDisconnectedMonitor();
});
