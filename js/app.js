/* ==========================================================================
   Altair_module_system_control - フロントエンド メイン JavaScript
   機能: ビュー切り替え, REST API通信, WebSocket双方向通信, 動的カード描画, プロファイル管理
   ========================================================================== */

document.addEventListener("DOMContentLoaded", () => {
  // アプリケーションの状態管理
  const state = {
    ws: null,
    wsUrl: `ws://${window.location.host || (window.location.hostname + ":8000")}/ws`,
    config: { modules: [] },
    ports: [],
    profiles: [],
    canConnected: false,
    behaviorStatus: "IDLE",
    controlMode: "SETUP", // SETUP (送信待ち), SENDING (送信・応答待機中), CONTROL (制御中)
    isSendingParams: false,
    mddStatuses: {}, // 各MDDモジュールのマイコン側システム状態 (0=待機中, 1=制御実行中)
    moduleSendToggles: {}, // 各モジュールへのUI指令値の送信ON/OFFトグル状態
    gamepadMappings: [], // コントローラーのマッピングデータ
  };

  // --- 1. DOM要素の取得 ---
  const el = {
    menuItems: document.querySelectorAll(".menu-item"),
    views: document.querySelectorAll(".content-view"),
    pageTitle: document.getElementById("page-title"),

    // 接続関連
    canStatusIndicator: document.getElementById("can-status-indicator"),
    groupConnectionSlcan: document.getElementById("group-connection-slcan"),
    slcanConnectionStatus: document.getElementById("slcan-connection-status"),
    tabModeEth: document.getElementById("tab-mode-eth"),
    tabModeUsb: document.getElementById("tab-mode-usb"),
    panelConnEth: document.getElementById("panel-conn-eth"),
    panelConnUsb: document.getElementById("panel-conn-usb"),
    txtEthIp: document.getElementById("txt-eth-ip"),
    txtEthPort: document.getElementById("txt-eth-port"),
    selEthCanChannel: document.getElementById("sel-eth-can-channel"),
    btnConnectEth: document.getElementById("btn-connect-eth"),
    btnDisconnectEth: document.getElementById("btn-disconnect-eth"),
    chkAutoConnect: document.getElementById("chk-auto-connect"),
    selCanPort: document.getElementById("sel-can-port"),
    btnRefreshPorts: document.getElementById("btn-refresh-ports"),
    btnConnectCan: document.getElementById("btn-connect-can"),
    btnDisconnectCan: document.getElementById("btn-disconnect-can"),
    btnEmergencyStop: document.getElementById("btn-emergency-stop"),

    // パラメータ・モジュール管理
    btnSendParams: document.getElementById("btn-send-params"),
    lblControlModeStatus: document.getElementById("control-mode-status"),
    modulesContainer: document.getElementById("modules-container"),
    btnAddModuleModal: document.getElementById("btn-add-module-modal"),

    // プロファイル管理
    profileListUl: document.getElementById("profile-list-ul"),
    txtNewProfileName: document.getElementById("txt-new-profile-name"),
    btnSaveProfile: document.getElementById("btn-save-profile"),
    fileImportProfile: document.getElementById("file-import-profile"),
    btnExportProfile: document.getElementById("btn-export-profile"),

    // 動作プログラム(Behavior)関連
    selBehaviorScript: document.getElementById("sel-behavior-script"),
    btnStartBehavior: document.getElementById("btn-start-behavior"),
    btnStopBehavior: document.getElementById("btn-stop-behavior"),
    lblBehaviorStatus: document.getElementById("lbl-behavior-status"),
    behaviorTerminal: document.getElementById("behavior-terminal"),
    btnClearConsole: document.getElementById("btn-clear-console"),

    // システムログ関連
    canLogsTerminal: document.getElementById("can-logs-terminal"),
    canLogsTxTerminal: document.getElementById("can-logs-tx-terminal"),
    canLogsRxTerminal: document.getElementById("can-logs-rx-terminal"),
    canStreamContainer: document.getElementById("can-stream-container"),
    canStreamPanelTx: document.getElementById("can-stream-panel-tx"),
    canStreamPanelRx: document.getElementById("can-stream-panel-rx"),
    canStreamPanelAll: document.getElementById("can-stream-panel-all"),
    canSummaryTbody: document.getElementById("can-summary-tbody"),
    canStatTxCount: document.getElementById("can-stat-tx-count"),
    canStatRxCount: document.getElementById("can-stat-rx-count"),
    canStatIdCount: document.getElementById("can-stat-id-count"),
    canFilterDirGroup: document.getElementById("can-filter-dir-group"),
    canFilterIdSelect: document.getElementById("can-filter-id-select"),
    canFilterSearch: document.getElementById("can-filter-search"),
    canViewModeGroup: document.getElementById("can-view-mode-group"),
    btnPauseCanLogs: document.getElementById("btn-pause-can-logs"),
    btnClearCanLogs: document.getElementById("btn-clear-can-logs"),
    btnResetIdFilter: document.getElementById("btn-reset-id-filter"),

    // モジュール追加モーダル
    modal: document.getElementById("add-module-modal"),
    btnCloseModal: document.getElementById("btn-close-modal"),
    btnCancelModal: document.getElementById("btn-cancel-modal"),
    btnSaveModule: document.getElementById("btn-save-module"),
    modalModuleType: document.getElementById("modal-module-type"),
    modalModuleName: document.getElementById("modal-module-name"),
    modalModuleId: document.getElementById("modal-module-id"),
    modalModuleDesc: document.getElementById("modal-module-desc"),
  };

  // Blocklyワークスペース参照（タブ表示時の再レイアウトに使用）
  let blocklyWorkspace = null;

  // --- 2. ビュー（画面）切り替えロジック ---
  el.menuItems.forEach(item => {
    item.addEventListener("click", (e) => {
      e.preventDefault();
      const targetId = item.getAttribute("data-target");

      // メニューの活性状態をトグル
      el.menuItems.forEach(i => i.classList.remove("active"));
      item.classList.add("active");

      // ビューの表示をトグル
      el.views.forEach(view => {
        if (view.id === targetId) {
          view.classList.add("active");
          el.pageTitle.textContent = item.textContent.trim();
        } else {
          view.classList.remove("active");
        }
      });

      // 非表示タブで初期化されたBlocklyを表示時に再レイアウトする
      if (targetId === "view-automation" && blocklyWorkspace && typeof Blockly !== "undefined") {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            Blockly.svgResize(blocklyWorkspace);
          });
        });
      }

      // CANログ画面を開いた際に最新の履歴・集計を即座に描画する
      if (targetId === "view-logs") {
        canLogState.pendingStreamEntries = [];
        if (el.canStatTxCount) el.canStatTxCount.textContent = canLogState.txTotal;
        if (el.canStatRxCount) el.canStatRxCount.textContent = canLogState.rxTotal;
        if (el.canStatIdCount) el.canStatIdCount.textContent = canLogState.knownIds.size;
        renderCanSummaryTable();
        rebuildCanStreamTerminals();
      }

      // テレメトリ画面を開いた際にモジュール選択肢を更新
      if (targetId === "view-telemetry") {
        updateScopeModuleSelect();
      }
    });
  });

  // --- 3. WebSocket 接続管理 ＆ メッセージング ---
  function connectWebSocket() {
    console.log("WebSocket接続を開始します: ", state.wsUrl);
    state.ws = new WebSocket(state.wsUrl);

    state.ws.onopen = () => {
      console.log("WebSocket接続が確立されました。");
      window.appWs = state.ws; // コントローラー（gamepad.js）との連携用にグローバルに共有
    };

    state.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleWsMessage(msg);
      } catch (err) {
        console.error("受信データのパースに失敗しました:", err);
      }
    };

    state.ws.onclose = () => {
      console.warn("WebSocket接続が切断されました。2秒後に再接続を試みます...");
      setTimeout(connectWebSocket, 2000);
    };

    state.ws.onerror = (err) => {
      console.error("WebSocketエラーが発生しました:", err);
    };
  }

  // 受信メッセージのディスパッチ
  function handleWsMessage(msg) {
    const type = msg.type;
    const data = msg.data;

    switch (type) {
      case "can_status":
        updateCanStatusUI(data);
        break;

      case "behavior_status":
        updateBehaviorStatusUI(data);
        break;

      case "behavior_log":
        appendTerminalLog(el.behaviorTerminal, data);
        break;

      case "mdd_feedback":
        updateMddCardFeedback(msg.name, data);
        break;

      case "gamepad_input":
        window.backendGamepadLastReceived = Date.now();
        if (typeof window.updateGamepadMonitorFromBackend === "function") {
          window.updateGamepadMonitorFromBackend(msg.axes, msg.buttons);
        }
        break;

      case "raw_can_frame": // システム全体のCANログ用
        appendCanLog(data);
        break;
    }
  }

  // --- 4. 接続状態UIの更新 ---
  function updateCanStatusUI(data) {
    state.canConnected = data.is_connected;
    const dot = el.canStatusIndicator.querySelector(".status-dot");
    const text = el.canStatusIndicator.querySelector(".status-text");

    if (data.is_connected) {
      dot.className = data.error_message ? "status-dot warning" : "status-dot connected";
      text.textContent = `CAN: Connected (${data.active_port})`;
      if (el.btnConnectCan) el.btnConnectCan.disabled = true;
      if (el.btnDisconnectCan) el.btnDisconnectCan.disabled = false;
      if (el.btnConnectEth) el.btnConnectEth.disabled = true;
      if (el.btnDisconnectEth) el.btnDisconnectEth.disabled = false;

      // slcan接続グループのUI更新
      if (el.slcanConnectionStatus) {
        if (data.error_message) {
          el.slcanConnectionStatus.innerHTML = `状態: <span class="badge badge-warning" style="padding: 4px 8px; font-size: 11px;">${data.error_message}</span>`;
        } else {
          el.slcanConnectionStatus.innerHTML = `状態: <span class="badge badge-success" style="padding: 4px 8px; font-size: 11px;">接続完了 (${data.active_port})</span>`;
        }
      }
      if (el.groupConnectionSlcan) {
        el.groupConnectionSlcan.style.borderColor = data.error_message ? "var(--color-warning)" : "var(--success-color)";
        el.groupConnectionSlcan.style.boxShadow = "0 0 10px rgba(19, 115, 51, 0.1)";
      }
      if (data.error_message && data.error_message !== state.lastCanError) {
        state.lastCanError = data.error_message;
        appendTerminalLog(el.behaviorTerminal, `[CAN WARNING] ${data.error_message}`, "error-msg");
      } else if (!data.error_message) {
        state.lastCanError = "";
      }
    } else {
      dot.className = "status-dot disconnected";
      text.textContent = "CAN: Disconnected";
      if (el.btnConnectCan) el.btnConnectCan.disabled = false;
      if (el.btnDisconnectCan) el.btnDisconnectCan.disabled = true;
      if (el.btnConnectEth) el.btnConnectEth.disabled = false;
      if (el.btnDisconnectEth) el.btnDisconnectEth.disabled = true;

      // slcan接続グループのUI更新
      if (el.slcanConnectionStatus) {
        el.slcanConnectionStatus.innerHTML = `状態: <span class="badge badge-danger" style="padding: 4px 8px; font-size: 11px;">未接続</span>`;
      }
      if (el.groupConnectionSlcan) {
        el.groupConnectionSlcan.style.borderColor = "var(--border-light)";
        el.groupConnectionSlcan.style.boxShadow = "none";
      }

      if (data.error_message && data.error_message !== state.lastCanError) {
        state.lastCanError = data.error_message;
        appendTerminalLog(el.behaviorTerminal, `[CAN ERROR] ${data.error_message}`, "error-msg");
      } else if (!data.error_message) {
        state.lastCanError = "";
      }
    }
  }

  // --- 5. 動作プログラム状態UIの更新 ---
  function updateBehaviorStatusUI(status) {
    state.behaviorStatus = status;
    el.lblBehaviorStatus.textContent = status;

    // バッジ色の変更
    if (status.includes("RUNNING")) {
      el.lblBehaviorStatus.className = "badge badge-success";
      el.btnStartBehavior.disabled = true;
      el.btnStopBehavior.disabled = false;
    } else if (status === "IDLE") {
      el.lblBehaviorStatus.className = "badge badge-secondary";
      el.btnStartBehavior.disabled = false;
      el.btnStopBehavior.disabled = true;
    } else {
      el.lblBehaviorStatus.className = "badge badge-warning";
      el.btnStartBehavior.disabled = false;
      el.btnStopBehavior.disabled = true;
    }
  }

  // --- 6. コンソール ＆ CANアナライザ ロギングヘルパー ---
  const canLogState = {
    paused: false,
    filterDir: "ALL",     // ALL | TX | RX
    filterId: "ALL",      // ALL | 0x200 等 | モジュール名
    searchQuery: "",
    viewMode: "split",    // split | combined | table-only
    txTotal: 0,
    rxTotal: 0,
    summaryMap: new Map(), // key: `${dir}_${idHex}`
    knownIds: new Set(),
    knownIdsDirty: false,
    history: [],           // 直近フレーム履歴 (最大400件)
    pendingStreamEntries: [], // 次回描画フレームで追加する行キュー
    rafScheduled: false,
  };

  function formatTimeWithMs(now) {
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    const ms = String(now.getMilliseconds()).padStart(3, "0");
    return `${hh}:${mm}:${ss}.${ms}`;
  }

  function readInt16LE(bytes, offset) {
    if (bytes.length < offset + 2) return 0;
    const val = (bytes[offset] & 0xFF) | ((bytes[offset + 1] & 0xFF) << 8);
    return val >= 0x8000 ? val - 0x10000 : val;
  }

  function resolveCanFrameInfo(idNum, bytes) {
    const modules = state.config?.modules || [];
    for (const m of modules) {
      const baseId = parseInt(m.base_id, 16);
      if (isNaN(baseId)) continue;

      if (m.type === "mdd") {
        if (idNum >= baseId && idNum <= baseId + 3) {
          const ch = idNum - baseId + 1;
          let decoded = "";
          if (bytes.length >= 8) {
            const p = (readInt16LE(bytes, 0) / 1000).toFixed(2);
            const i = (readInt16LE(bytes, 2) / 1000).toFixed(2);
            const d = (readInt16LE(bytes, 4) / 1000).toFixed(2);
            const diaRaw = readInt16LE(bytes, 6);
            const dirStr = diaRaw < 0 ? "Rev(-)" : "Fwd(+)";
            decoded = `P:${p} I:${i} D:${d} 径:${Math.abs(diaRaw)}mm ${dirStr}`;
          }
          return { moduleName: m.name, label: `${m.name} / PID設定(M${ch})`, decoded };
        }
        if (idNum === baseId + 0x10) {
          const modeNames = ["Speed", "Angle", "Pos"];
          const modes = bytes.slice(0, 4).map((b, idx) => `M${idx + 1}:${modeNames[b] || b}`).join(" ");
          return { moduleName: m.name, label: `${m.name} / モード・起動`, decoded: modes };
        }
        if (idNum === baseId + 0x20) {
          let decoded = "";
          if (bytes.length >= 8) {
            const vals = [0, 1, 2, 3].map(idx => `M${idx + 1}:${(readInt16LE(bytes, idx * 2) / 10).toFixed(1)}`);
            decoded = vals.join(" ");
          }
          return { moduleName: m.name, label: `${m.name} / 目標値指令`, decoded };
        }
        if (idNum === baseId + 0x30) {
          let decoded = "";
          if (bytes.length >= 6) {
            const st = bytes[5] === 1 ? "制御中(1)" : "待機中(0)";
            const err = `0x${bytes[4].toString(16).padStart(2, "0").toUpperCase()}`;
            const sw = `${bytes[0] ? 1 : 0}${bytes[1] ? 1 : 0}${bytes[2] ? 1 : 0}${bytes[3] ? 1 : 0}`;
            decoded = `状態:${st} Err:${err} SW:${sw}`;
          }
          return { moduleName: m.name, label: `${m.name} / ステータス返信`, decoded };
        }
        if (idNum === baseId + 0x40) {
          let decoded = "";
          if (bytes.length >= 8) {
            const angs = [0, 1, 2, 3].map(idx => `M${idx + 1}:${(readInt16LE(bytes, idx * 2) / 10).toFixed(1)}°`);
            decoded = angs.join(" ");
          }
          return { moduleName: m.name, label: `${m.name} / 現在角度FB`, decoded };
        }
        if (idNum === baseId + 0x50) {
          let decoded = "";
          if (bytes.length >= 8) {
            const spds = [0, 1, 2, 3].map(idx => `M${idx + 1}:${(readInt16LE(bytes, idx * 2) / 100).toFixed(2)}`);
            decoded = `${spds.join(" ")} rps`;
          }
          return { moduleName: m.name, label: `${m.name} / 現在速度FB`, decoded };
        }
      } else if (m.type === "servo" && idNum === baseId) {
        const angs = bytes.slice(0, 6).map((b, idx) => `S${idx + 1}:${b}°`).join(" ");
        return { moduleName: m.name, label: `${m.name} / サーボ指令`, decoded: angs };
      } else if (m.type === "solenoid" && idNum === baseId) {
        const bits = (bytes[0] || 0) | ((bytes[1] || 0) << 8);
        const onList = [];
        for (let i = 0; i < 12; i++) {
          if (bits & (1 << i)) onList.push(`V${i + 1}`);
        }
        return {
          moduleName: m.name,
          label: `${m.name} / 電磁弁指令`,
          decoded: onList.length > 0 ? `ON: ${onList.join(",")}` : "すべてOFF",
        };
      }
    }

    return { moduleName: "", label: "未登録ID", decoded: "" };
  }

  function parseRawCanLogLine(text) {
    const m = text.match(/^\[(TX|RX)\]\s*\(([^)]+)\)\s*ID:\s*(0x[0-9A-Fa-f]+)\s*\[(\d+)\]\s*(.*)$/);
    if (!m) return null;
    const dir = m[1];
    const channel = m[2];
    const idNum = parseInt(m[3], 16);
    const idHex = `0x${idNum.toString(16).toUpperCase().padStart(3, "0")}`;
    const dlc = parseInt(m[4], 10);
    const hexTokens = m[5].trim() ? m[5].trim().split(/\s+/) : [];
    const bytes = hexTokens.map(h => parseInt(h, 16) || 0);
    const timeStr = formatTimeWithMs(new Date());
    const info = resolveCanFrameInfo(idNum, bytes);

    return {
      dir,
      channel,
      idHex,
      idNum,
      dlc,
      hexTokens,
      bytes,
      timeStr,
      moduleName: info.moduleName,
      label: info.label,
      decoded: info.decoded,
    };
  }

  function matchesCanFilter(entry) {
    if (canLogState.filterDir !== "ALL" && entry.dir !== canLogState.filterDir) {
      return false;
    }
    if (canLogState.filterId !== "ALL") {
      if (canLogState.filterId.startsWith("MOD:")) {
        const targetMod = canLogState.filterId.slice(4);
        if (entry.moduleName !== targetMod) return false;
      } else if (entry.idHex !== canLogState.filterId) {
        return false;
      }
    }
    if (canLogState.searchQuery) {
      const q = canLogState.searchQuery.toLowerCase();
      const hay = `${entry.idHex} ${entry.label} ${entry.decoded} ${entry.hexTokens.join(" ")}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  function updateCanFilterSelectOptions() {
    if (!el.canFilterIdSelect) return;
    const currentVal = el.canFilterIdSelect.value;
    const modules = state.config?.modules || [];

    let html = '<option value="ALL">すべてのID / モジュール</option>';
    if (modules.length > 0) {
      html += '<optgroup label="モジュール別">';
      modules.forEach(m => {
        html += `<option value="MOD:${m.name}">${m.name} (${m.base_id})</option>`;
      });
      html += "</optgroup>";
    }

    const sortedIds = Array.from(canLogState.knownIds).sort((a, b) => parseInt(a, 16) - parseInt(b, 16));
    if (sortedIds.length > 0) {
      html += '<optgroup label="CAN ID別">';
      sortedIds.forEach(idHex => {
        const info = resolveCanFrameInfo(parseInt(idHex, 16), []);
        const suffix = info.label && info.label !== "未登録ID" ? ` - ${info.label}` : "";
        html += `<option value="${idHex}">${idHex}${suffix}</option>`;
      });
      html += "</optgroup>";
    }

    el.canFilterIdSelect.innerHTML = html;
    if ([...el.canFilterIdSelect.options].some(o => o.value === currentVal)) {
      el.canFilterIdSelect.value = currentVal;
    } else {
      el.canFilterIdSelect.value = "ALL";
    }
  }

  function renderCanStreamRow(entry) {
    const div = document.createElement("div");
    div.className = "can-log-row";
    const dirClass = entry.dir === "TX" ? "can-log-dir-tx" : "can-log-dir-rx";
    const hexStr = entry.hexTokens.join(" ");
    const decStr = entry.decoded ? ` | ${entry.decoded}` : "";
    div.innerHTML = `
      <span class="can-log-time">[${entry.timeStr}]</span>
      <span class="${dirClass}">${entry.dir}</span>
      <span class="can-log-id">${entry.idHex}</span>
      <span class="can-log-label" title="${entry.label}">${entry.label}</span>
      <span class="can-log-data">[${entry.dlc}] ${hexStr}${decStr}</span>
    `;
    return div;
  }

  function appendStreamBatchToTerminal(terminal, entries) {
    if (!terminal || entries.length === 0) return;
    const frag = document.createDocumentFragment();
    const slice = entries.length > 200 ? entries.slice(-200) : entries;
    for (const entry of slice) {
      frag.appendChild(renderCanStreamRow(entry));
    }
    terminal.appendChild(frag);
    while (terminal.childElementCount > 200) {
      terminal.removeChild(terminal.firstChild);
    }
    terminal.scrollTop = terminal.scrollHeight;
  }

  function rebuildCanStreamTerminals() {
    if (el.canLogsTerminal) el.canLogsTerminal.innerHTML = "";
    if (el.canLogsTxTerminal) el.canLogsTxTerminal.innerHTML = "";
    if (el.canLogsRxTerminal) el.canLogsRxTerminal.innerHTML = "";

    const filtered = canLogState.history.filter(matchesCanFilter);
    if (canLogState.viewMode === "combined") {
      appendStreamBatchToTerminal(el.canLogsTerminal, filtered);
    } else if (canLogState.viewMode === "split") {
      appendStreamBatchToTerminal(el.canLogsTxTerminal, filtered.filter(e => e.dir === "TX"));
      appendStreamBatchToTerminal(el.canLogsRxTerminal, filtered.filter(e => e.dir === "RX"));
    }
  }

  function renderCanSummaryTable() {
    if (!el.canSummaryTbody) return;
    const items = Array.from(canLogState.summaryMap.values())
      .filter(matchesCanFilter)
      .sort((a, b) => {
        if (a.idNum !== b.idNum) return a.idNum - b.idNum;
        return a.dir.localeCompare(b.dir);
      });

    if (items.length === 0) {
      el.canSummaryTbody.innerHTML = `
        <tr class="can-empty-row">
          <td colspan="7">条件に一致するCANフレームはまだありません。</td>
        </tr>`;
      return;
    }

    el.canSummaryTbody.innerHTML = items.map(item => {
      const dirBadge = item.dir === "TX"
        ? '<span class="can-dir-badge can-dir-tx">TX</span>'
        : '<span class="can-dir-badge can-dir-rx">RX</span>';
      const isSelected = canLogState.filterId === item.idHex ? "selected-id-row" : "";
      const bytesHtml = item.hexTokens.map((hx, idx) => {
        const changed = item.prevHexTokens && item.prevHexTokens[idx] !== undefined && item.prevHexTokens[idx] !== hx;
        return `<span class="can-hex-byte ${changed ? "changed" : ""}">${hx}</span>`;
      }).join("");

      return `
        <tr class="${isSelected}" data-can-id="${item.idHex}" title="クリックでこのCAN ID (${item.idHex}) を絞り込み">
          <td>${dirBadge}</td>
          <td><span class="can-id-badge">${item.idHex}</span></td>
          <td style="font-weight: 500;">${item.label}</td>
          <td style="text-align: center; font-family: 'Consolas', monospace;">${item.dlc}</td>
          <td><div class="can-hex-bytes">${bytesHtml}</div></td>
          <td><span class="can-decoded-text">${item.decoded || "-"}</span></td>
          <td style="text-align: right; font-family: 'Consolas', monospace; font-size: 11px; color: var(--text-muted);">
            <strong>${item.count}</strong>回<br>${item.timeStr}
          </td>
        </tr>`;
    }).join("");
  }

  function updateCanViewLayout() {
    if (!el.canStreamContainer) return;
    if (canLogState.viewMode === "table-only") {
      el.canStreamContainer.style.display = "none";
    } else if (canLogState.viewMode === "combined") {
      el.canStreamContainer.style.display = "block";
      el.canStreamContainer.className = "can-stream-combined mt-3";
      if (el.canStreamPanelTx) el.canStreamPanelTx.style.display = "none";
      if (el.canStreamPanelRx) el.canStreamPanelRx.style.display = "none";
      if (el.canStreamPanelAll) el.canStreamPanelAll.style.display = "block";
    } else {
      el.canStreamContainer.style.display = "grid";
      el.canStreamContainer.className = "can-stream-split mt-3";
      if (el.canStreamPanelTx) el.canStreamPanelTx.style.display = canLogState.filterDir === "RX" ? "none" : "block";
      if (el.canStreamPanelRx) el.canStreamPanelRx.style.display = canLogState.filterDir === "TX" ? "none" : "block";
      if (el.canStreamPanelAll) el.canStreamPanelAll.style.display = "none";
    }
  }

  function flushCanLogUI() {
    canLogState.rafScheduled = false;

    if (canLogState.knownIdsDirty) {
      canLogState.knownIdsDirty = false;
      updateCanFilterSelectOptions();
    }

    const viewLogsEl = document.getElementById("view-logs");
    const isLogsActive = viewLogsEl && viewLogsEl.classList.contains("active");

    if (!isLogsActive) {
      canLogState.pendingStreamEntries = [];
      return;
    }

    if (el.canStatTxCount) el.canStatTxCount.textContent = canLogState.txTotal;
    if (el.canStatRxCount) el.canStatRxCount.textContent = canLogState.rxTotal;
    if (el.canStatIdCount) el.canStatIdCount.textContent = canLogState.knownIds.size;

    renderCanSummaryTable();

    if (canLogState.pendingStreamEntries.length > 0) {
      const batch = canLogState.pendingStreamEntries;
      canLogState.pendingStreamEntries = [];

      if (canLogState.viewMode === "combined") {
        appendStreamBatchToTerminal(el.canLogsTerminal, batch);
      } else if (canLogState.viewMode === "split") {
        const txBatch = [];
        const rxBatch = [];
        for (const entry of batch) {
          if (entry.dir === "TX") txBatch.push(entry);
          else rxBatch.push(entry);
        }
        if (txBatch.length > 0 && canLogState.filterDir !== "RX") {
          appendStreamBatchToTerminal(el.canLogsTxTerminal, txBatch);
        }
        if (rxBatch.length > 0 && canLogState.filterDir !== "TX") {
          appendStreamBatchToTerminal(el.canLogsRxTerminal, rxBatch);
        }
      }
    }
  }

  function appendCanLog(text) {
    if (canLogState.paused) return;

    const entry = parseRawCanLogLine(text);
    if (!entry) {
      if (el.canLogsTerminal) appendTerminalLog(el.canLogsTerminal, text);
      return;
    }

    if (entry.dir === "TX") {
      canLogState.txTotal++;
    } else {
      canLogState.rxTotal++;
    }

    if (!canLogState.knownIds.has(entry.idHex)) {
      canLogState.knownIds.add(entry.idHex);
      canLogState.knownIdsDirty = true;
    }

    const key = `${entry.dir}_${entry.idHex}`;
    const prev = canLogState.summaryMap.get(key);
    canLogState.summaryMap.set(key, {
      ...entry,
      prevHexTokens: prev ? prev.hexTokens : null,
      count: prev ? prev.count + 1 : 1,
    });

    canLogState.history.push(entry);
    if (canLogState.history.length > 400) {
      canLogState.history.shift();
    }

    if (matchesCanFilter(entry)) {
      canLogState.pendingStreamEntries.push(entry);
      if (canLogState.pendingStreamEntries.length > 200) {
        canLogState.pendingStreamEntries.shift();
      }
    }

    if (!canLogState.rafScheduled) {
      canLogState.rafScheduled = true;
      requestAnimationFrame(flushCanLogUI);
    }
  }

  // 送受信フィルタ切替イベント
  if (el.canFilterDirGroup) {
    el.canFilterDirGroup.addEventListener("click", (e) => {
      const btn = e.target.closest(".can-seg-btn");
      if (!btn) return;
      el.canFilterDirGroup.querySelectorAll(".can-seg-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      canLogState.filterDir = btn.getAttribute("data-dir") || "ALL";
      canLogState.pendingStreamEntries = [];
      updateCanViewLayout();
      renderCanSummaryTable();
      rebuildCanStreamTerminals();
    });
  }

  // 表示モード切替イベント (送受信2分割 / 統合ストリーム / ID表のみ)
  if (el.canViewModeGroup) {
    el.canViewModeGroup.addEventListener("click", (e) => {
      const btn = e.target.closest(".can-seg-btn");
      if (!btn) return;
      el.canViewModeGroup.querySelectorAll(".can-seg-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      canLogState.viewMode = btn.getAttribute("data-mode") || "split";
      canLogState.pendingStreamEntries = [];
      updateCanViewLayout();
      rebuildCanStreamTerminals();
    });
  }

  // IDセレクト絞り込みイベント
  if (el.canFilterIdSelect) {
    el.canFilterIdSelect.addEventListener("change", () => {
      canLogState.filterId = el.canFilterIdSelect.value;
      if (el.btnResetIdFilter) {
        el.btnResetIdFilter.style.display = canLogState.filterId === "ALL" ? "none" : "inline";
      }
      renderCanSummaryTable();
      rebuildCanStreamTerminals();
    });
  }

  // テキスト検索絞り込みイベント
  if (el.canFilterSearch) {
    el.canFilterSearch.addEventListener("input", () => {
      canLogState.searchQuery = el.canFilterSearch.value.trim();
      renderCanSummaryTable();
      rebuildCanStreamTerminals();
    });
  }

  // ID別モニター表の行クリックで特定CAN IDの絞り込みトグル
  if (el.canSummaryTbody) {
    el.canSummaryTbody.addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-can-id]");
      if (!tr) return;
      const clickedId = tr.getAttribute("data-can-id");
      canLogState.filterId = canLogState.filterId === clickedId ? "ALL" : clickedId;
      if (el.canFilterIdSelect) el.canFilterIdSelect.value = canLogState.filterId;
      if (el.btnResetIdFilter) {
        el.btnResetIdFilter.style.display = canLogState.filterId === "ALL" ? "none" : "inline";
      }
      renderCanSummaryTable();
      rebuildCanStreamTerminals();
    });
  }

  if (el.btnResetIdFilter) {
    el.btnResetIdFilter.addEventListener("click", () => {
      canLogState.filterId = "ALL";
      if (el.canFilterIdSelect) el.canFilterIdSelect.value = "ALL";
      el.btnResetIdFilter.style.display = "none";
      renderCanSummaryTable();
      rebuildCanStreamTerminals();
    });
  }

  // 一時停止 / 再開ボタン
  if (el.btnPauseCanLogs) {
    el.btnPauseCanLogs.addEventListener("click", () => {
      canLogState.paused = !canLogState.paused;
      if (canLogState.paused) {
        el.btnPauseCanLogs.innerHTML = '<i class="fa-solid fa-play"></i> 再開';
        el.btnPauseCanLogs.classList.add("btn-primary");
        el.btnPauseCanLogs.classList.remove("btn-secondary");
      } else {
        el.btnPauseCanLogs.innerHTML = '<i class="fa-solid fa-pause"></i> 一時停止';
        el.btnPauseCanLogs.classList.remove("btn-primary");
        el.btnPauseCanLogs.classList.add("btn-secondary");
      }
    });
  }

  // クリアボタン
  if (el.btnClearCanLogs) {
    el.btnClearCanLogs.addEventListener("click", () => {
      canLogState.txTotal = 0;
      canLogState.rxTotal = 0;
      canLogState.summaryMap.clear();
      canLogState.knownIds.clear();
      canLogState.knownIdsDirty = false;
      canLogState.history = [];
      canLogState.pendingStreamEntries = [];
      if (el.canStatTxCount) el.canStatTxCount.textContent = "0";
      if (el.canStatRxCount) el.canStatRxCount.textContent = "0";
      if (el.canStatIdCount) el.canStatIdCount.textContent = "0";
      updateCanFilterSelectOptions();
      renderCanSummaryTable();
      rebuildCanStreamTerminals();
    });
  }

  function appendTerminalLog(terminal, text, className = "") {
    const line = document.createElement("div");
    line.className = `terminal-line ${className}`;

    const timestamp = `[${new Date().toLocaleTimeString()}] `;

    // Python スタックトレースのパターン検出:
    // 例: File "C:\path\to\script.py", line 481, in <module>
    const traceRegex = /File\s+"([^"]+)",\s+line\s+(\d+)/;

    if (traceRegex.test(text)) {
      const escapeHtml = (str) =>
        str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

      const rawEscaped = escapeHtml(text);
      const replaced = rawEscaped.replace(
        /File\s+&quot;([^&]+)&quot;,\s+line\s+(\d+)(?:,\s+in\s+([^<\r\n]+|&lt;[^&]+&gt;))?/g,
        (match, filePath, lineNum, funcName) => {
          const fileName = filePath.replace(/\\/g, "/").split("/").pop();
          const fnPart = funcName ? `, in ${funcName}` : "";
          return `<span class="traceback-link" data-file="${fileName}" data-line="${lineNum}" title="クリックして ${fileName} の ${lineNum} 行目をエディタで確認"><i class="fa-solid fa-code"></i> File "${fileName}", line ${lineNum}${fnPart}</span>`;
        }
      );
      line.innerHTML = `<span style="opacity: 0.6;">${timestamp}</span>${replaced}`;
    } else {
      line.textContent = `${timestamp}${text}`;
    }

    terminal.appendChild(line);

    // 最大300行に制限
    while (terminal.childElementCount > 300) {
      terminal.removeChild(terminal.firstChild);
    }

    // スクロール追従
    terminal.scrollTop = terminal.scrollHeight;
  }

  // --- 7. モジュール構成 (config) のロードとレンダリング ---
  async function loadConfigAndRender() {
    try {
      const res = await fetch("/api/config");
      state.config = await res.json();

      renderModuleCards();
      updateCanFilterSelectOptions();
      updateScopeModuleSelect();
    } catch (err) {
      console.error("モジュール設定のロードに失敗しました:", err);
    }
  }

  function renderModuleCards() {
    el.modulesContainer.innerHTML = ""; // クリア

    if (state.config.modules.length === 0) {
      el.modulesContainer.innerHTML = `
        <div class="glass-card page-card" style="grid-column: 1/-1; text-align: center; padding: 40px;">
          <i class="fa-solid fa-folder-open" style="font-size: 48px; color: var(--text-muted); margin-bottom: 15px;"></i>
          <p>登録されている制御モジュールはありません。右上の「Add Module」から追加してください。</p>
        </div>`;
      return;
    }

    state.config.modules.forEach(mod => {
      const card = document.createElement("div");
      card.className = `glass-card module-card module-card-${mod.type}`;
      card.id = `module-card-${mod.name}`;

      // 各モジュールタイプに応じた内部HTMLの生成
      let contentHtml = "";

      if (mod.type === "mdd") {
        contentHtml = renderMddCardHtml(mod);
      } else if (mod.type === "servo") {
        contentHtml = renderServoCardHtml(mod);
      } else if (mod.type === "solenoid") {
        contentHtml = renderSolenoidCardHtml(mod);
      }

      card.innerHTML = `
        <div class="card-header-row">
          <div class="module-title">
            <h2>${mod.name}</h2>
            <div class="module-meta-info" style="margin-bottom: 2px;">
              <span>ID: ${mod.base_id}</span>
              <span>Type: ${mod.type.toUpperCase()}</span>
            </div>
            <!-- UI操作送信トグルスイッチ -->
            <div class="send-toggle-row" style="display: flex; align-items: center; gap: 6px; margin-top: 6px;">
              <label class="toggle-checkbox" style="display: flex; align-items: center; gap: 6px; cursor: pointer; margin-bottom: 0;">
                <input type="checkbox" class="toggle-send-cmd" data-module="${mod.name}" id="toggle-send-${mod.name}" ${state.moduleSendToggles[mod.name] ? "checked" : ""}>
                <span class="toggle-switch toggle-switch-sm"></span>
              </label>
              <span style="font-size: 11px; font-weight: 600; color: var(--text-muted); user-select: none;">UI操作送信</span>
            </div>
          </div>
          <div class="card-actions">
            <button class="btn btn-secondary btn-icon btn-xs" onclick="editModule('${mod.name}')" title="設定編集">
              <i class="fa-solid fa-pen-to-square"></i>
            </button>
            <button class="btn btn-danger btn-icon btn-xs" onclick="deleteModule('${mod.name}')" title="削除">
              <i class="fa-solid fa-trash"></i>
            </button>
          </div>
        </div>
        <div class="card-body">
          ${contentHtml}
        </div>
      `;

      el.modulesContainer.appendChild(card);

      // イベントリスナーの動的設定
      bindCardEvents(mod);
    });
  }

  // --- MDDカードレンダリング ---
  function renderMddCardHtml(mod) {
    let slidersHtml = "";
    for (let i = 1; i <= 4; i++) {
      const motorParam = mod.parameters?.[`m${i}`] ?? { mode: 0, p: 10.0, i: 0.0, d: 0.0, diameter: 100.0, direction: 1 };
      const mode = motorParam.mode ?? 0;

      let min = -10;
      let max = 10;
      let step = 0.1;
      let unit = "rps";

      if (mode === 1) {
        min = -360;
        max = 360;
        step = 1;
        unit = "deg";
      } else if (mode === 2) {
        min = -1000;
        max = 1000;
        step = 1;
        unit = "mm";
      }

      slidersHtml += `
        <div class="control-slider-group mt-2">
          <div class="slider-label-row" style="display: flex; justify-content: space-between; align-items: center;">
            <span class="slider-name">Motor ${i} Goal</span>
            <div style="display: flex; align-items: center; gap: 4px;">
              <button class="btn btn-secondary btn-xs btn-target-adjust" data-module="${mod.name}" data-motor="${i}" data-action="minus" style="padding: 0; width: 16px; height: 16px; font-size: 10px; line-height: 1; font-weight: bold;">-</button>
              <span class="slider-val" id="val-${mod.name}-m${i}" style="min-width: 60px; text-align: center; font-weight: 500;">0.0 ${unit}</span>
              <button class="btn btn-secondary btn-xs btn-target-adjust" data-module="${mod.name}" data-motor="${i}" data-action="plus" style="padding: 0; width: 16px; height: 16px; font-size: 10px; line-height: 1; font-weight: bold;">+</button>
            </div>
          </div>
          <input type="range" class="custom-range range-mdd" data-module="${mod.name}" data-motor="${i}" 
                 min="${min}" max="${max}" step="${step}" value="0" id="range-${mod.name}-m${i}">
        </div>`;
    }

    // M1〜M4のパラメータ（モード, P, I, D, diameter, direction）設定リスト
    let paramsCardsHtml = "";
    for (let i = 1; i <= 4; i++) {
      const motorParam = mod.parameters?.[`m${i}`] ?? { mode: 0, p: 10.0, i: 0.0, d: 0.0, diameter: 100.0, direction: 1 };
      paramsCardsHtml += `
        <div class="mdd-motor-card">
          <!-- 上段: チャンネル, モード, 車輪径, 回転方向 -->
          <div class="mdd-motor-header">
            <span class="mdd-ch-badge">M${i}</span>
            <div class="mdd-header-field mdd-mode-field">
              <select class="form-input form-input-sm select-mdd-mode" data-module="${mod.name}" data-motor="${i}" title="制御モード">
                <option value="0" ${motorParam.mode === 0 ? "selected" : ""}>Speed</option>
                <option value="1" ${motorParam.mode === 1 ? "selected" : ""}>Angle</option>
                <option value="2" ${motorParam.mode === 2 ? "selected" : ""}>Pos</option>
              </select>
            </div>
            <div class="mdd-header-field mdd-wheel-field">
              <span class="mdd-field-label">径</span>
              <input type="number" class="form-input form-input-sm input-mdd-wheel" data-module="${mod.name}" data-motor="${i}" step="1" value="${motorParam.diameter ?? 100.0}" title="車輪直径(mm)">
              <span class="mdd-field-unit">mm</span>
            </div>
            <div class="mdd-header-field mdd-dir-field">
              <span class="mdd-field-label">Dir</span>
              <select class="form-input form-input-sm select-mdd-dir" data-module="${mod.name}" data-motor="${i}" title="回転方向">
                <option value="1" ${(motorParam.direction ?? 1) >= 0 ? "selected" : ""}>+</option>
                <option value="-1" ${(motorParam.direction ?? 1) < 0 ? "selected" : ""}>-</option>
              </select>
            </div>
          </div>

          <!-- 下段: PID設定ステッパー (P, I, D) -->
          <div class="mdd-motor-pid-row">
            <div class="mdd-pid-group">
              <span class="mdd-pid-tag">P</span>
              <div class="mdd-stepper">
                <button type="button" class="btn-stepper btn-pid-adjust" data-module="${mod.name}" data-motor="${i}" data-param="p" data-action="minus" title="P減少">-</button>
                <input type="number" class="stepper-input input-mdd-p" data-module="${mod.name}" data-motor="${i}" step="0.1" value="${motorParam.p}" title="Pゲイン">
                <button type="button" class="btn-stepper btn-pid-adjust" data-module="${mod.name}" data-motor="${i}" data-param="p" data-action="plus" title="P増加">+</button>
              </div>
            </div>
            <div class="mdd-pid-group">
              <span class="mdd-pid-tag">I</span>
              <div class="mdd-stepper">
                <button type="button" class="btn-stepper btn-pid-adjust" data-module="${mod.name}" data-motor="${i}" data-param="i" data-action="minus" title="I減少">-</button>
                <input type="number" class="stepper-input input-mdd-i" data-module="${mod.name}" data-motor="${i}" step="0.01" value="${motorParam.i}" title="Iゲイン">
                <button type="button" class="btn-stepper btn-pid-adjust" data-module="${mod.name}" data-motor="${i}" data-param="i" data-action="plus" title="I増加">+</button>
              </div>
            </div>
            <div class="mdd-pid-group">
              <span class="mdd-pid-tag">D</span>
              <div class="mdd-stepper">
                <button type="button" class="btn-stepper btn-pid-adjust" data-module="${mod.name}" data-motor="${i}" data-param="d" data-action="minus" title="D減少">-</button>
                <input type="number" class="stepper-input input-mdd-d" data-module="${mod.name}" data-motor="${i}" step="0.01" value="${motorParam.d}" title="Dゲイン">
                <button type="button" class="btn-stepper btn-pid-adjust" data-module="${mod.name}" data-motor="${i}" data-param="d" data-action="plus" title="D増加">+</button>
              </div>
            </div>
          </div>
        </div>`;
    }

    const paramTableHtml = `
      <div class="mdd-params-table-wrapper mt-3">
        <h4 style="font-size: 12px; margin-bottom: 8px; font-weight: 600;"><i class="fa-solid fa-gears"></i> PID & Mode Settings</h4>
        <div class="mdd-motors-list">
          ${paramsCardsHtml}
        </div>
      </div>`;

    return `
      <!-- モータ目標値スライダー -->
      <div class="mdd-sliders">
        ${slidersHtml}
      </div>
      
      <!-- PIDおよびモードの編集テーブル -->
      ${paramTableHtml}

      <!-- Limitスイッチインジケータ -->
      <div class="switches-section mt-3">
        <h4 style="font-size: 12px; margin-bottom: 6px; font-weight: 600;">Limit Switches</h4>
        <div class="switches-row">
          <div class="sw-indicator" id="sw-${mod.name}-1">SW 1</div>
          <div class="sw-indicator" id="sw-${mod.name}-2">SW 2</div>
          <div class="sw-indicator" id="sw-${mod.name}-3">SW 3</div>
          <div class="sw-indicator" id="sw-${mod.name}-4">SW 4</div>
        </div>
      </div>

      <!-- エンコーダ実測データ表示 -->
      <div class="mdd-params-grid mt-3">
        <div class="mdd-param-item">M1 FB: <span id="lbl-${mod.name}-m1-fb">0.0° / 0.0</span></div>
        <div class="mdd-param-item">M2 FB: <span id="lbl-${mod.name}-m2-fb">0.0° / 0.0</span></div>
        <div class="mdd-param-item">M3 FB: <span id="lbl-${mod.name}-m3-fb">0.0° / 0.0</span></div>
        <div class="mdd-param-item">M4 FB: <span id="lbl-${mod.name}-m4-fb">0.0° / 0.0</span></div>
      </div>
    `;
  }

  // --- Servoカードレンダリング ---
  function renderServoCardHtml(mod) {
    let slidersHtml = "";
    for (let i = 1; i <= 6; i++) {
      slidersHtml += `
        <div class="control-slider-group mt-2">
          <div class="slider-label-row">
            <span class="slider-name">Servo ${i}</span>
            <span class="slider-val" id="val-${mod.name}-s${i}">90°</span>
          </div>
          <input type="range" class="custom-range range-servo" data-module="${mod.name}" data-servo="${i}" 
                 min="0" max="180" value="90" id="range-${mod.name}-s${i}">
        </div>`;
    }
    return slidersHtml;
  }

  // --- Solenoidカードレンダリング ---
  function renderSolenoidCardHtml(mod) {
    let buttonsHtml = "";
    for (let i = 1; i <= 12; i++) {
      buttonsHtml += `<button class="valve-btn btn-solenoid" data-module="${mod.name}" data-channel="${i}" id="btn-${mod.name}-v${i}">V${i}</button>`;
    }
    return `
      <div class="valves-grid">
        ${buttonsHtml}
      </div>
    `;
  }

  // --- モジュール操作イベントのバインディング ---
  function bindCardEvents(mod) {
    // UI操作送信トグルの状態変更イベント
    const toggleSend = document.getElementById(`toggle-send-${mod.name}`);
    if (toggleSend) {
      if (state.moduleSendToggles[mod.name] === undefined) {
        state.moduleSendToggles[mod.name] = false;
      }
      toggleSend.checked = state.moduleSendToggles[mod.name];

      toggleSend.addEventListener("change", (e) => {
        const isChecked = e.target.checked;
        state.moduleSendToggles[mod.name] = isChecked;

        if (isChecked) {
          appendTerminalLog(el.behaviorTerminal, `[SYSTEM] ${mod.name} へのリアルタイムUI操作送信を有効にしました。`, "system-msg");
        } else {
          appendTerminalLog(el.behaviorTerminal, `[SYSTEM] ${mod.name} へのリアルタイムUI操作送信を無効にしました（目標値をゼロに安全停止します）。`, "system-msg");

          // トグルOFF時は安全のために目標値を0に戻す
          if (mod.type === "mdd") {
            for (let i = 1; i <= 4; i++) {
              const slider = document.getElementById(`range-${mod.name}-m${i}`);
              const valEl = document.getElementById(`val-${mod.name}-m${i}`);
              if (slider) slider.value = 0;
              if (valEl) {
                const mode = mod.parameters?.[`m${i}`]?.mode ?? 0;
                const unit = mode === 0 ? "rps" : mode === 1 ? "deg" : "mm";
                valEl.textContent = `0.0 ${unit}`;
              }
            }
            if (state.ws && state.ws.readyState === WebSocket.OPEN) {
              state.ws.send(JSON.stringify({
                type: "mdd_cmd",
                name: mod.name,
                targets: [0, 0, 0, 0]
              }));
            }
          } else if (mod.type === "servo") {
            // サーボは中央（90度）にリセット
            for (let i = 1; i <= 6; i++) {
              const slider = document.getElementById(`range-${mod.name}-s${i}`);
              const valEl = document.getElementById(`val-${mod.name}-s${i}`);
              if (slider) slider.value = 90;
              if (valEl) valEl.textContent = `90°`;
            }
            if (state.ws && state.ws.readyState === WebSocket.OPEN) {
              state.ws.send(JSON.stringify({
                type: "servo_cmd",
                name: mod.name,
                angles: [90, 90, 90, 90, 90, 90]
              }));
            }
          }
        }
      });
    }

    if (mod.type === "mdd") {
      // MDDスライダーのドラッグイベント
      const sliders = document.querySelectorAll(`.range-mdd[data-module="${mod.name}"]`);
      sliders.forEach(slider => {
        slider.addEventListener("input", (e) => {
          const motorIdx = e.target.getAttribute("data-motor");
          const valEl = document.getElementById(`val-${mod.name}-m${motorIdx}`);

          // モード表示の読み込み
          const mode = mod.parameters?.[`m${motorIdx}`]?.mode ?? 0;
          const unit = mode === 0 ? "rps" : mode === 1 ? "deg" : "mm";
          valEl.textContent = `${parseFloat(e.target.value).toFixed(1)} ${unit}`;

          // WebSocket経由で指令送信 (送信トグルがONのときのみ)
          if (state.moduleSendToggles[mod.name]) {
            sendMddTargetCommand(mod.name);
          }
        });
      });

      // モード変更イベントリスナーの追加
      const modeSelects = document.querySelectorAll(`.select-mdd-mode[data-module="${mod.name}"]`);
      modeSelects.forEach(sel => {
        sel.addEventListener("change", async (e) => {
          const motorIdx = e.target.getAttribute("data-motor");
          const modeVal = parseInt(e.target.value);

          const moduleObj = state.config.modules.find(m => m.name === mod.name);
          if (moduleObj) {
            if (!moduleObj.parameters) moduleObj.parameters = {};
            if (!moduleObj.parameters[`m${motorIdx}`]) {
              moduleObj.parameters[`m${motorIdx}`] = { p: 10.0, i: 0.0, d: 0.0, diameter: 100.0, direction: 1, mode: 0 };
            }
            moduleObj.parameters[`m${motorIdx}`].mode = modeVal;

            // スライダーおよび単位の動的更新
            const valEl = document.getElementById(`val-${mod.name}-m${motorIdx}`);
            const slider = document.getElementById(`range-${mod.name}-m${motorIdx}`);

            let min = -10;
            let max = 10;
            let step = 0.1;
            let unit = "rps";

            if (modeVal === 1) {
              min = -360;
              max = 360;
              step = 1;
              unit = "deg";
            } else if (modeVal === 2) {
              min = -1000;
              max = 1000;
              step = 1;
              unit = "mm";
            }

            if (slider) {
              slider.min = min;
              slider.max = max;
              slider.step = step;
              slider.value = 0; // モード切替時にリセット
            }
            if (valEl) valEl.textContent = `0.0 ${unit}`;

            // 設定ファイルを自動保存
            await saveConfigToServer();
          }
        });
      });

      // 目標値（スライダー値）の微調整ボタンイベントリスナー
      const adjustBtns = document.querySelectorAll(`.btn-target-adjust[data-module="${mod.name}"]`);
      adjustBtns.forEach(btn => {
        btn.addEventListener("click", (e) => {
          const motorIdx = btn.getAttribute("data-motor");
          const action = btn.getAttribute("data-action");

          const slider = document.getElementById(`range-${mod.name}-m${motorIdx}`);
          const valEl = document.getElementById(`val-${mod.name}-m${motorIdx}`);
          if (!slider) return;

          let curVal = parseFloat(slider.value) || 0.0;
          let step = parseFloat(slider.step) || 0.1;

          if (action === "plus") {
            curVal = Math.min(parseFloat(slider.max), curVal + step);
          } else {
            curVal = Math.max(parseFloat(slider.min), curVal - step);
          }

          slider.value = curVal;

          // モード表示の読み込み
          const mode = mod.parameters?.[`m${motorIdx}`]?.mode ?? 0;
          const unit = mode === 0 ? "rps" : mode === 1 ? "deg" : "mm";
          if (valEl) {
            valEl.textContent = `${curVal.toFixed(mode === 0 ? 1 : 0)} ${unit}`;
          }

          // WebSocket経由で指令送信 (送信トグルがONのときのみ)
          if (state.moduleSendToggles[mod.name]) {
            sendMddTargetCommand(mod.name);
          }
        });
      });

      // PIDの向き (direction) 変更イベントリスナーの追加
      const dirSelects = document.querySelectorAll(`.select-mdd-dir[data-module="${mod.name}"]`);
      dirSelects.forEach(sel => {
        sel.addEventListener("change", async (e) => {
          const motorIdx = e.target.getAttribute("data-motor");
          const dirVal = parseInt(e.target.value) || 1;

          const moduleObj = state.config.modules.find(m => m.name === mod.name);
          if (moduleObj) {
            if (!moduleObj.parameters) moduleObj.parameters = {};
            if (!moduleObj.parameters[`m${motorIdx}`]) {
              moduleObj.parameters[`m${motorIdx}`] = { p: 10.0, i: 0.0, d: 0.0, diameter: 100.0, direction: 1, mode: 0 };
            }
            moduleObj.parameters[`m${motorIdx}`].direction = dirVal;

            // 設定ファイルを自動保存
            await saveConfigToServer();
          }
        });
      });

      // 車輪直径 (diameter) 変更イベントリスナーの追加
      const wheelInputs = document.querySelectorAll(`.input-mdd-wheel[data-module="${mod.name}"]`);
      wheelInputs.forEach(input => {
        input.addEventListener("change", async (e) => {
          const motorIdx = e.target.getAttribute("data-motor");
          const wheelVal = parseFloat(e.target.value) || 100.0;

          const moduleObj = state.config.modules.find(m => m.name === mod.name);
          if (moduleObj) {
            if (!moduleObj.parameters) moduleObj.parameters = {};
            if (!moduleObj.parameters[`m${motorIdx}`]) {
              moduleObj.parameters[`m${motorIdx}`] = { p: 10.0, i: 0.0, d: 0.0, diameter: 100.0, direction: 1, mode: 0 };
            }
            moduleObj.parameters[`m${motorIdx}`].diameter = wheelVal;

            // 設定ファイルを自動保存
            await saveConfigToServer();
          }
        });
      });

      // PID値変更イベントリスナーの追加
      const pidInputs = document.querySelectorAll(`.input-mdd-p[data-module="${mod.name}"], .input-mdd-i[data-module="${mod.name}"], .input-mdd-d[data-module="${mod.name}"]`);
      pidInputs.forEach(input => {
        input.addEventListener("change", async (e) => {
          const motorIdx = e.target.getAttribute("data-motor");
          const moduleObj = state.config.modules.find(m => m.name === mod.name);
          if (moduleObj) {
            if (!moduleObj.parameters) moduleObj.parameters = {};
            if (!moduleObj.parameters[`m${motorIdx}`]) {
              moduleObj.parameters[`m${motorIdx}`] = { p: 10.0, i: 0.0, d: 0.0, diameter: 100.0, direction: 1, mode: 0 };
            }

            const val = parseFloat(e.target.value) || 0.0;
            if (e.target.classList.contains("input-mdd-p")) {
              moduleObj.parameters[`m${motorIdx}`].p = val;
            } else if (e.target.classList.contains("input-mdd-i")) {
              moduleObj.parameters[`m${motorIdx}`].i = val;
            } else if (e.target.classList.contains("input-mdd-d")) {
              moduleObj.parameters[`m${motorIdx}`].d = val;
            }

            // 設定ファイルを自動保存
            await saveConfigToServer();
          }
        });
      });

      // PIDゲインの微調整ボタン (+ / -) イベントリスナーの追加
      const pidAdjustBtns = document.querySelectorAll(`.btn-pid-adjust[data-module="${mod.name}"]`);
      pidAdjustBtns.forEach(btn => {
        btn.addEventListener("click", async () => {
          const motorIdx = btn.getAttribute("data-motor");
          const param = btn.getAttribute("data-param");
          const action = btn.getAttribute("data-action");
          const inputEl = document.querySelector(`.input-mdd-${param}[data-module="${mod.name}"][data-motor="${motorIdx}"]`);
          if (!inputEl) return;

          const step = parseFloat(inputEl.step) || (param === "p" ? 0.1 : 0.01);
          const curVal = parseFloat(inputEl.value) || 0.0;
          const nextVal = Math.max(0, parseFloat((curVal + (action === "plus" ? step : -step)).toFixed(3)));
          inputEl.value = nextVal;

          const moduleObj = state.config.modules.find(m => m.name === mod.name);
          if (moduleObj) {
            if (!moduleObj.parameters) moduleObj.parameters = {};
            if (!moduleObj.parameters[`m${motorIdx}`]) {
              moduleObj.parameters[`m${motorIdx}`] = { p: 10.0, i: 0.0, d: 0.0, diameter: 100.0, direction: 1, mode: 0 };
            }
            moduleObj.parameters[`m${motorIdx}`][param] = nextVal;
            await saveConfigToServer();
          }
        });
      });

    } else if (mod.type === "servo") {
      // サーボスライダーのドラッグイベント
      const sliders = document.querySelectorAll(`.range-servo[data-module="${mod.name}"]`);
      sliders.forEach(slider => {
        slider.addEventListener("input", (e) => {
          const servoIdx = e.target.getAttribute("data-servo");
          const valEl = document.getElementById(`val-${mod.name}-s${servoIdx}`);
          valEl.textContent = `${e.target.value}°`;

          // 即時送信 (送信トグルがONのときのみ)
          if (state.moduleSendToggles[mod.name]) {
            sendServoAngleCommand(mod.name);
          }
        });
      });

    } else if (mod.type === "solenoid") {
      // ソレノイドバルブのON/OFFトグルイベント
      const btns = document.querySelectorAll(`.btn-solenoid[data-module="${mod.name}"]`);
      btns.forEach(btn => {
        btn.addEventListener("click", (e) => {
          btn.classList.toggle("active");

          // 即時送信 (送信トグルがONのときのみ)
          if (state.moduleSendToggles[mod.name]) {
            sendSolenoidCommand(mod.name);
          } else {
            // トグルOFFの場合はクリックされてもスタイルをもとに戻す
            btn.classList.toggle("active");
            appendTerminalLog(el.behaviorTerminal, `[WARNING] ${mod.name} の「UI操作送信」がOFFのためバルブ制御は送信されません。`, "error-msg");
          }
        });
      });
    }
  }

  // --- WebSocket 指令送信ロジック ---
  function sendMddTargetCommand(moduleName) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;

    // 4つのスライダー値を取得
    const targets = [];
    for (let i = 1; i <= 4; i++) {
      const slider = document.getElementById(`range-${moduleName}-m${i}`);
      targets.push(parseFloat(slider.value));
    }

    const payload = {
      type: "mdd_cmd",
      name: moduleName,
      targets: targets
    };
    state.ws.send(JSON.stringify(payload));
  }

  function sendServoAngleCommand(moduleName) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;

    const angles = [];
    for (let i = 1; i <= 6; i++) {
      const slider = document.getElementById(`range-${moduleName}-s${i}`);
      angles.push(parseInt(slider.value));
    }

    const payload = {
      type: "servo_cmd",
      name: moduleName,
      angles: angles
    };
    state.ws.send(JSON.stringify(payload));
  }

  function sendSolenoidCommand(moduleName) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;

    const valves = [];
    for (let i = 1; i <= 12; i++) {
      const btn = document.getElementById(`btn-${moduleName}-v${i}`);
      valves.push(btn.classList.contains("active"));
    }

    const payload = {
      type: "solenoid_cmd",
      name: moduleName,
      valves: valves
    };
    state.ws.send(JSON.stringify(payload));
  }

  // --- 8. WebSocket テレメトリ（フィードバック）のカード反映 ---
  const pendingMddFeedback = new Map();
  let mddFeedbackRafScheduled = false;

  function flushMddCardFeedbackDOM() {
    mddFeedbackRafScheduled = false;
    for (const [name, data] of pendingMddFeedback.entries()) {
      // Limitスイッチ
      for (let i = 0; i < 4; i++) {
        const swEl = document.getElementById(`sw-${name}-${i + 1}`);
        if (swEl) {
          if (data.limit_switches[i]) {
            swEl.classList.add("active");
          } else {
            swEl.classList.remove("active");
          }
        }
      }

      // エンコーダフィードバック (角度 ＆ 速度)
      for (let i = 0; i < 4; i++) {
        const fbEl = document.getElementById(`lbl-${name}-m${i + 1}-fb`);
        if (fbEl) {
          const ang = data.angles[i].toFixed(1);
          const spd = data.speeds[i].toFixed(2);
          fbEl.textContent = `${ang}° / ${spd} rps`;
        }
      }

      // エラー状態のチェック
      const card = document.getElementById(`module-card-${name}`);
      if (card) {
        card.style.borderColor = data.error_code > 0 ? "var(--color-danger)" : "var(--border-light)";
      }
    }
    pendingMddFeedback.clear();
  }

  function updateMddCardFeedback(name, data) {
    pendingMddFeedback.set(name, data);
    if (!mddFeedbackRafScheduled) {
      mddFeedbackRafScheduled = true;
      requestAnimationFrame(flushMddCardFeedbackDOM);
    }

    // オシロスコープ波形バッファへデータを転送
    updateScopeData(name, data);

    // マイコン側のモード判定による自動リセット検知（全MDDの状態を個別に管理しピンポン発振を防止）
    if (typeof data.system_status !== 'undefined') {
      const prevStatus = state.mddStatuses[name];
      state.mddStatuses[name] = data.system_status;

      if (!state.mddZeroCounts) state.mddZeroCounts = {};
      if (data.system_status === 0) {
        state.mddZeroCounts[name] = (state.mddZeroCounts[name] || 0) + 1;
      } else {
        state.mddZeroCounts[name] = 0;
      }

      if (!state.isSendingParams) {
        const mddModules = (state.config?.modules || []).filter(m => m.type === "mdd");
        const allRunning = mddModules.length > 0 && mddModules.every(m => state.mddStatuses[m.name] === 1);

        if (allRunning && state.controlMode !== "CONTROL") {
          state.controlMode = "CONTROL";
          if (el.lblControlModeStatus) {
            el.lblControlModeStatus.innerHTML = 'ステータス: <span class="badge badge-success">制御実行中 (Control Mode)</span>';
          }
        } else if (data.system_status === 0 && (state.mddZeroCounts[name] >= 10) && (state.controlMode === "CONTROL" || prevStatus === 1)) {
          state.controlMode = "SETUP";
          if (el.lblControlModeStatus) {
            el.lblControlModeStatus.innerHTML = 'ステータス: <span class="badge badge-warning">パラメータ未送信 (待機中)</span>';
          }
          appendTerminalLog(el.behaviorTerminal, `[SYSTEM] マイコン '${name}' の待機状態（パラメータ設定モード）へのリセットを検知しました。パラメータを再送信してください。`, "system-msg");
        }
      }
    }
  }

  // --- 9. ポート一覧 ＆ CAN接続制御 ---
  async function refreshPorts() {
    try {
      const res = await fetch("/api/ports");
      const data = await res.json();
      state.ports = data.ports;

      el.selCanPort.innerHTML = "";
      if (state.ports.length === 0) {
        el.selCanPort.innerHTML = '<option value="">ポート未検出</option>';
        return;
      }

      state.ports.forEach(port => {
        const opt = document.createElement("option");
        opt.value = port;
        opt.textContent = port;
        el.selCanPort.appendChild(opt);
      });
    } catch (err) {
      console.error("ポート取得失敗:", err);
    }
  }

  el.btnRefreshPorts.addEventListener("click", refreshPorts);

  // Ethernet / USB 接続モードタブ切り替え
  if (el.tabModeEth && el.tabModeUsb) {
    el.tabModeEth.addEventListener("click", () => {
      el.tabModeEth.className = "btn btn-sm btn-primary";
      el.tabModeUsb.className = "btn btn-sm btn-secondary";
      el.panelConnEth.style.display = "block";
      el.panelConnUsb.style.display = "none";
    });

    el.tabModeUsb.addEventListener("click", () => {
      el.tabModeUsb.className = "btn btn-sm btn-primary";
      el.tabModeEth.className = "btn btn-sm btn-secondary";
      el.panelConnUsb.style.display = "block";
      el.panelConnEth.style.display = "none";
    });
  }

  // Ethernet-CAN 設定の初期ロード
  async function loadEthCanConfig() {
    try {
      const res = await fetch("/api/eth_can/config");
      const cfg = await res.json();
      if (cfg.target_ip && el.txtEthIp) el.txtEthIp.value = cfg.target_ip;
      if (cfg.target_port && el.txtEthPort) el.txtEthPort.value = cfg.target_port;
      if (cfg.can_channel && el.selEthCanChannel) el.selEthCanChannel.value = cfg.can_channel;
    } catch (e) {
      // 読み込み失敗時は初期値を維持
    }
  }
  loadEthCanConfig();

  // Ethernet-CAN チャンネル切り替え (接続中も即座に反映)
  if (el.selEthCanChannel) {
    el.selEthCanChannel.addEventListener("change", async () => {
      const ch = el.selEthCanChannel.value;
      try {
        const res = await fetch("/api/eth_can/channel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ can_channel: ch })
        });
        const data = await res.json();
        if (data.success) {
          appendTerminalLog(el.behaviorTerminal, `[SYSTEM] ${data.message}`, "system-msg");
        }
      } catch (err) {
        appendTerminalLog(el.behaviorTerminal, `[ERROR] チャンネル切替に失敗しました: ${err}`, "error-msg");
      }
    });
  }

  // Ethernet-CAN 接続ボタン
  if (el.btnConnectEth) {
    el.btnConnectEth.addEventListener("click", async () => {
      const ip = el.txtEthIp.value.trim();
      const port = parseInt(el.txtEthPort.value.trim(), 10) || 5000;
      const canChannel = el.selEthCanChannel ? el.selEthCanChannel.value : "can1";

      appendTerminalLog(el.behaviorTerminal, `Ethernet-CAN (${ip}:${port} / ${canChannel.toUpperCase()}) への接続要求を送信中...`);

      try {
        const res = await fetch("/api/eth_can/connect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target_ip: ip, target_port: port, can_channel: canChannel })
        });
        const data = await res.json();
        if (data.success) {
          appendTerminalLog(el.behaviorTerminal, `[SYSTEM] ${data.message}`, "system-msg");
        } else {
          appendTerminalLog(el.behaviorTerminal, `[ERROR] ${data.message}`, "error-msg");
        }
      } catch (err) {
        appendTerminalLog(el.behaviorTerminal, `[ERROR] 通信に失敗しました: ${err}`, "error-msg");
      }
    });
  }

  // Ethernet-CAN 切断ボタン
  if (el.btnDisconnectEth) {
    el.btnDisconnectEth.addEventListener("click", async () => {
      appendTerminalLog(el.behaviorTerminal, "Ethernet-CAN 切断要求を送信中...");
      try {
        const res = await fetch("/api/eth_can/disconnect", { method: "POST" });
        const data = await res.json();
        appendTerminalLog(el.behaviorTerminal, `[SYSTEM] ${data.message}`, "system-msg");
      } catch (err) {
        appendTerminalLog(el.behaviorTerminal, `[ERROR] 通信失敗: ${err}`, "error-msg");
      }
    });
  }

  // 自動探索チェックボックスの挙動
  if (el.chkAutoConnect) {
    const syncAutoConnectUI = () => {
      const isAuto = el.chkAutoConnect.checked;
      if (el.selCanPort) el.selCanPort.disabled = isAuto;
      if (el.btnRefreshPorts) el.btnRefreshPorts.disabled = isAuto;
    };
    el.chkAutoConnect.addEventListener("change", syncAutoConnectUI);
    syncAutoConnectUI();
  }

  // 接続ボタン
  el.btnConnectCan.addEventListener("click", async () => {
    const auto = el.chkAutoConnect.checked;
    const port = el.selCanPort.value;

    appendTerminalLog(el.behaviorTerminal, "USB-to-CAN 接続要求を送信中...");

    try {
      const res = await fetch("/api/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port: port, auto_connect: auto })
      });
      const data = await res.json();

      if (data.success) {
        appendTerminalLog(el.behaviorTerminal, `[SYSTEM] ${data.message}`, "system-msg");
      } else {
        appendTerminalLog(el.behaviorTerminal, `[ERROR] ${data.message}`, "error-msg");
      }
    } catch (err) {
      appendTerminalLog(el.behaviorTerminal, `[ERROR] 通信に失敗しました: ${err}`, "error-msg");
    }
  });

  // 切断ボタン
  el.btnDisconnectCan.addEventListener("click", async () => {
    appendTerminalLog(el.behaviorTerminal, "USB-to-CAN 切断要求を送信中...");
    try {
      const res = await fetch("/api/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port: "", auto_connect: false }) // 空で送ると切断
      });
      const data = await res.json();
      appendTerminalLog(el.behaviorTerminal, `[SYSTEM] ${data.message}`, "system-msg");
    } catch (err) {
      appendTerminalLog(el.behaviorTerminal, `[ERROR] 通信失敗: ${err}`, "error-msg");
    }
  });

  // パラメータ送信 ＆ 全マイコン応答待機 ＆ 制御開始
  el.btnSendParams.addEventListener("click", async () => {
    state.isSendingParams = true;
    state.controlMode = "SENDING";
    if (el.lblControlModeStatus) {
      el.lblControlModeStatus.innerHTML = 'ステータス: <span class="badge badge-warning">パラメータ送信・応答待機中...</span>';
    }
    appendTerminalLog(el.behaviorTerminal, "制御パラメータを送信し、全マイコンからの設定完了応答を待機しています...");
    try {
      const res = await fetch("/api/start_control", { method: "POST" });
      const data = await res.json();
      state.isSendingParams = false;

      if (data.success) {
        (state.config?.modules || []).forEach(m => {
          if (m.type === "mdd") state.mddStatuses[m.name] = 1;
        });
        appendTerminalLog(el.behaviorTerminal, `[SYSTEM] ${data.message}`, "system-msg");
        if (el.lblControlModeStatus) {
          el.lblControlModeStatus.innerHTML = 'ステータス: <span class="badge badge-success">制御実行中 (Control Mode)</span>';
        }
        state.controlMode = "CONTROL";
      } else {
        state.controlMode = "SETUP";
        if (el.lblControlModeStatus) {
          el.lblControlModeStatus.innerHTML = 'ステータス: <span class="badge badge-warning">パラメータ未送信 (待機中)</span>';
        }
        appendTerminalLog(el.behaviorTerminal, `[ERROR] 送信失敗: ${data.message}`, "error-msg");
      }
    } catch (err) {
      state.isSendingParams = false;
      state.controlMode = "SETUP";
      if (el.lblControlModeStatus) {
        el.lblControlModeStatus.innerHTML = 'ステータス: <span class="badge badge-warning">パラメータ未送信 (待機中)</span>';
      }
      appendTerminalLog(el.behaviorTerminal, `[ERROR] 通信失敗: ${err}`, "error-msg");
    }
  });

  // --- 10. プロファイル管理処理 ---
  async function refreshProfiles() {
    try {
      const res = await fetch("/api/profiles");
      const data = await res.json();
      state.profiles = data.profiles;

      el.profileListUl.innerHTML = "";
      if (state.profiles.length === 0) {
        el.profileListUl.innerHTML = '<li class="profile-item">プロファイルはありません。</li>';
        return;
      }

      state.profiles.forEach(pname => {
        const li = document.createElement("li");
        li.className = "profile-item";
        li.innerHTML = `
          <div class="profile-name-sec">
            <i class="fa-solid fa-file-invoice"></i>
            <span>${pname}</span>
          </div>
          <div class="profile-actions">
            <button class="btn btn-primary btn-xs" onclick="loadProfile('${pname}')">適用</button>
            <button class="btn btn-danger btn-xs" onclick="deleteProfileFile('${pname}')">削除</button>
          </div>
        `;
        el.profileListUl.appendChild(li);
      });
    } catch (err) {
      console.error("プロファイル取得失敗:", err);
    }
  }

  // --- 動作プログラムファイル一覧の動的取得とフォルダー連携 ---
  const btnRefreshBehaviorList = document.getElementById("btn-refresh-behavior-list");
  const btnDeleteBehavior = document.getElementById("btn-delete-behavior");
  const txtNewBehaviorName = document.getElementById("txt-new-behavior-name");
  const btnCreateBehavior = document.getElementById("btn-create-behavior");
  const btnOpenBehaviorFolder = document.getElementById("btn-open-behavior-folder");

  if (btnOpenBehaviorFolder) {
    btnOpenBehaviorFolder.addEventListener("click", async () => {
      try {
        const res = await fetch("/api/behavior/open_folder", { method: "POST" });
        const data = await res.json();
        if (data.success) {
          appendTerminalLog(el.behaviorTerminal, `[SYSTEM] ${data.message}`, "system-msg");
        } else {
          appendTerminalLog(el.behaviorTerminal, `[ERROR] ${data.message}`, "error-msg");
        }
      } catch (err) {
        appendTerminalLog(el.behaviorTerminal, `[ERROR] フォルダーを開けませんでした: ${err}`, "error-msg");
      }
    });
  }

  async function refreshBehaviors(preferredSelect = "") {
    try {
      const prevSelect = preferredSelect || el.selBehaviorScript.value;
      const res = await fetch("/api/behavior/list");
      const data = await res.json();

      if (!data.success || !data.behaviors) {
        console.error("プログラムファイル取得失敗:", data.error || "不明なエラー");
        el.selBehaviorScript.innerHTML = '<option value="">ファイルが見つかりません</option>';
        return;
      }

      // ドロップダウンをクリア
      el.selBehaviorScript.innerHTML = '';

      // 取得したファイル一覧をオプションとして追加
      if (data.behaviors.length === 0) {
        el.selBehaviorScript.innerHTML = '<option value="">プログラムファイルがありません</option>';
      } else {
        data.behaviors.forEach(filename => {
          const option = document.createElement("option");
          option.value = filename;
          option.textContent = filename;
          el.selBehaviorScript.appendChild(option);
        });
        if (prevSelect && data.behaviors.includes(prevSelect)) {
          el.selBehaviorScript.value = prevSelect;
        }
      }
    } catch (err) {
      console.error("プログラムファイル取得失敗:", err);
      el.selBehaviorScript.innerHTML = '<option value="">通信エラー</option>';
    }
  }

  if (btnRefreshBehaviorList) {
    btnRefreshBehaviorList.addEventListener("click", () => refreshBehaviors());
  }

  if (btnCreateBehavior && txtNewBehaviorName) {
    btnCreateBehavior.addEventListener("click", async () => {
      const name = txtNewBehaviorName.value.trim();
      if (!name) {
        alert("新しいスクリプトのファイル名を入力してください (例: my_robot.py)");
        return;
      }
      try {
        const res = await fetch("/api/behavior/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name })
        });
        const data = await res.json();
        if (data.success) {
          txtNewBehaviorName.value = "";
          appendTerminalLog(el.behaviorTerminal, `[SYSTEM] ${data.message}`, "system-msg");
          await refreshBehaviors(data.name);
        } else {
          appendTerminalLog(el.behaviorTerminal, `[ERROR] ${data.message}`, "error-msg");
          alert(data.message);
        }
      } catch (err) {
        appendTerminalLog(el.behaviorTerminal, `[ERROR] 作成エラー: ${err}`, "error-msg");
      }
    });
  }

  if (btnDeleteBehavior) {
    btnDeleteBehavior.addEventListener("click", async () => {
      const target = el.selBehaviorScript.value;
      if (!target) return;
      if (!confirm(`スクリプト '${target}' を本当に削除しますか？`)) return;
      try {
        const res = await fetch("/api/behavior/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: target })
        });
        const data = await res.json();
        if (data.success) {
          appendTerminalLog(el.behaviorTerminal, `[SYSTEM] ${data.message}`, "system-msg");
          await refreshBehaviors();
        } else {
          appendTerminalLog(el.behaviorTerminal, `[ERROR] ${data.message}`, "error-msg");
          alert(data.message);
        }
      } catch (err) {
        appendTerminalLog(el.behaviorTerminal, `[ERROR] 削除エラー: ${err}`, "error-msg");
      }
    });
  }

  // --- スクリプトコードエディタ ＆ スタックトレース該当行ジャンプ機能 ---
  let currentEditorFile = "";
  let currentEditorLine = 0;

  const btnViewBehaviorCode = document.getElementById("btn-view-behavior-code");
  const codeEditorModal = document.getElementById("code-editor-modal");
  const codeEditorFilename = document.getElementById("code-editor-filename");
  const codeEditorLineBadge = document.getElementById("code-editor-line-badge");
  const codeEditorTextarea = document.getElementById("code-editor-textarea");
  const codeEditorLinenums = document.getElementById("code-editor-linenums");
  const codeEditorHighlight = document.getElementById("code-editor-highlight");
  const codeEditorStatusText = document.getElementById("code-editor-status-text");
  const btnCloseCodeEditor = document.getElementById("btn-close-code-editor");
  const btnCancelCodeEditor = document.getElementById("btn-cancel-code-editor");
  const btnEditorSave = document.getElementById("btn-editor-save");
  const btnEditorOpenVscode = document.getElementById("btn-editor-open-vscode");

  async function openCodeEditorModal(fileName, lineNum = 0) {
    if (!fileName) {
      fileName = el.selBehaviorScript ? el.selBehaviorScript.value : "";
    }
    if (!fileName) {
      alert("表示するスクリプトファイルを選択してください。");
      return;
    }

    const baseName = fileName.replace(/\\/g, "/").split("/").pop();
    currentEditorFile = baseName;
    currentEditorLine = parseInt(lineNum, 10) || 0;

    if (codeEditorFilename) codeEditorFilename.textContent = baseName;
    if (codeEditorLineBadge) {
      if (currentEditorLine > 0) {
        codeEditorLineBadge.textContent = `line ${currentEditorLine}`;
        codeEditorLineBadge.style.display = "inline-block";
      } else {
        codeEditorLineBadge.style.display = "none";
      }
    }
    if (codeEditorTextarea) codeEditorTextarea.value = "# コードを読み込み中...";
    if (codeEditorModal) codeEditorModal.style.display = "flex";

    try {
      const res = await fetch(`/api/behavior/code?name=${encodeURIComponent(baseName)}`);
      const data = await res.json();
      if (!data.success) {
        if (codeEditorTextarea) codeEditorTextarea.value = `# エラー: ${data.message}`;
        return;
      }

      if (codeEditorTextarea) {
        codeEditorTextarea.value = data.code;
        updateLineNumbers(data.code, currentEditorLine);
        setTimeout(() => {
          scrollToEditorLine(currentEditorLine);
        }, 50);
      }
      if (codeEditorStatusText) {
        if (currentEditorLine > 0) {
          codeEditorStatusText.textContent = `スクリプト: ${baseName} | エラー該当行: ${currentEditorLine} 行目 | Ctrl+S で保存`;
        } else {
          codeEditorStatusText.textContent = `スクリプト: ${baseName} | Ctrl+S で保存`;
        }
      }
    } catch (err) {
      if (codeEditorTextarea) codeEditorTextarea.value = `# 読み込み失敗: ${err.message}`;
    }
  }

  function updateLineNumbers(codeText, errorLine = 0) {
    if (!codeEditorLinenums) return;
    const lines = codeText.split("\n");
    const count = Math.max(1, lines.length);
    let html = "";
    for (let i = 1; i <= count; i++) {
      const isErr = (i === errorLine);
      html += `<div class="linenum-item ${isErr ? 'error-line' : ''}">${i}</div>`;
    }
    codeEditorLinenums.innerHTML = html;
  }

  function scrollToEditorLine(lineNum) {
    if (!codeEditorTextarea || lineNum <= 0) {
      if (codeEditorHighlight) codeEditorHighlight.style.display = "none";
      return;
    }
    const lineHeight = 20;
    const targetScroll = Math.max(0, (lineNum - 1) * lineHeight - 100);
    codeEditorTextarea.scrollTop = targetScroll;

    if (codeEditorHighlight) {
      codeEditorHighlight.style.display = "block";
      const topPos = 12 + (lineNum - 1) * lineHeight - codeEditorTextarea.scrollTop;
      codeEditorHighlight.style.top = `${topPos}px`;
    }
  }

  function updateHighlightPosition() {
    if (!codeEditorTextarea || !codeEditorHighlight || currentEditorLine <= 0) return;
    const lineHeight = 20;
    const topPos = 12 + (currentEditorLine - 1) * lineHeight - codeEditorTextarea.scrollTop;
    codeEditorHighlight.style.top = `${topPos}px`;
  }

  async function saveEditorCode() {
    if (!currentEditorFile || !codeEditorTextarea) return;
    if (codeEditorStatusText) codeEditorStatusText.textContent = "保存処理中...";
    try {
      const res = await fetch("/api/behavior/code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: currentEditorFile, code: codeEditorTextarea.value })
      });
      const data = await res.json();
      if (data.success) {
        if (codeEditorStatusText) {
          codeEditorStatusText.textContent = `保存完了 (${new Date().toLocaleTimeString()})`;
        }
        appendTerminalLog(el.behaviorTerminal, `[SYSTEM] ${data.message}`, "system-msg");
      } else {
        if (codeEditorStatusText) codeEditorStatusText.textContent = `保存失敗: ${data.message}`;
      }
    } catch (err) {
      if (codeEditorStatusText) codeEditorStatusText.textContent = `通信エラー: ${err.message}`;
    }
  }

  async function openEditorInVscode() {
    if (!currentEditorFile) return;
    try {
      const res = await fetch("/api/behavior/open_vscode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: currentEditorFile, line: currentEditorLine || 1 })
      });
      const data = await res.json();
      if (data.success) {
        appendTerminalLog(el.behaviorTerminal, `[SYSTEM] ${data.message}`, "system-msg");
      } else {
        appendTerminalLog(el.behaviorTerminal, `[WARN] ${data.message}`, "error-msg");
      }
    } catch (err) {
      console.error("VSCode起動リクエストエラー:", err);
    }
  }

  function closeCodeEditorModal() {
    if (codeEditorModal) codeEditorModal.style.display = "none";
  }

  if (btnViewBehaviorCode) {
    btnViewBehaviorCode.addEventListener("click", () => {
      openCodeEditorModal(el.selBehaviorScript ? el.selBehaviorScript.value : "", 0);
    });
  }

  if (btnCloseCodeEditor) btnCloseCodeEditor.addEventListener("click", closeCodeEditorModal);
  if (btnCancelCodeEditor) btnCancelCodeEditor.addEventListener("click", closeCodeEditorModal);
  if (btnEditorSave) btnEditorSave.addEventListener("click", saveEditorCode);
  if (btnEditorOpenVscode) btnEditorOpenVscode.addEventListener("click", openEditorInVscode);

  if (codeEditorTextarea) {
    codeEditorTextarea.addEventListener("scroll", () => {
      if (codeEditorLinenums) {
        codeEditorLinenums.scrollTop = codeEditorTextarea.scrollTop;
      }
      updateHighlightPosition();
    });
    codeEditorTextarea.addEventListener("input", () => {
      updateLineNumbers(codeEditorTextarea.value, currentEditorLine);
    });
    codeEditorTextarea.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        saveEditorCode();
      }
    });
  }

  // ターミナル内のスタックトレースリンククリックの委譲処理
  if (el.behaviorTerminal) {
    el.behaviorTerminal.addEventListener("click", (e) => {
      const link = e.target.closest(".traceback-link");
      if (link) {
        e.preventDefault();
        const fName = link.getAttribute("data-file");
        const lNum = parseInt(link.getAttribute("data-line"), 10) || 0;
        openCodeEditorModal(fName, lNum);
      }
    });
  }

  // プロファイルのロード（グローバル関数化）
  window.loadProfile = async (name) => {
    appendTerminalLog(el.behaviorTerminal, `プロファイル '${name}' をロード中...`);
    try {
      const res = await fetch(`/api/profiles/load?name=${name}`, { method: "POST" });
      const data = await res.json();
      appendTerminalLog(el.behaviorTerminal, `[SYSTEM] ${data.message}`, "system-msg");

      // 設定ファイルを再読み込みしてDashboardを更新
      await loadConfigAndRender();
    } catch (err) {
      appendTerminalLog(el.behaviorTerminal, `[ERROR] ロード失敗: ${err}`, "error-msg");
    }
  };

  // プロファイルの削除（グローバル関数化）
  window.deleteProfileFile = async (name) => {
    if (!confirm(`プロファイル '${name}' を本当に削除しますか？`)) {
      return;
    }
    appendTerminalLog(el.behaviorTerminal, `プロファイル '${name}' を削除中...`);
    try {
      const res = await fetch(`/api/profiles/delete?name=${name}`, { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        appendTerminalLog(el.behaviorTerminal, `[SYSTEM] ${data.message}`, "system-msg");
        refreshProfiles();
      } else {
        appendTerminalLog(el.behaviorTerminal, `[ERROR] 削除失敗: ${data.detail || data.message}`, "error-msg");
      }
    } catch (err) {
      appendTerminalLog(el.behaviorTerminal, `[ERROR] 削除失敗: ${err}`, "error-msg");
    }
  };

  // プロファイル新規保存
  el.btnSaveProfile.addEventListener("click", async () => {
    const name = el.txtNewProfileName.value.trim();
    if (!name) return;

    appendTerminalLog(el.behaviorTerminal, `現在の構成をプロファイル '${name}' として保存中...`);
    try {
      const res = await fetch(`/api/profiles/save?name=${name}`, { method: "POST" });
      const data = await res.json();
      appendTerminalLog(el.behaviorTerminal, `[SYSTEM] ${data.message}`, "system-msg");

      el.txtNewProfileName.value = "";
      refreshProfiles();
    } catch (err) {
      appendTerminalLog(el.behaviorTerminal, `[ERROR] 保存失敗: ${err}`, "error-msg");
    }
  });

  // プロファイルエクスポート
  el.btnExportProfile.addEventListener("click", async () => {
    try {
      const res = await fetch("/api/config");
      const configData = await res.json();

      const blob = new Blob([JSON.stringify(configData, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = url;
      a.download = "modules_config.json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("エクスポート失敗:", err);
    }
  });

  // プロファイルインポート
  el.fileImportProfile.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const configData = JSON.parse(event.target.result);

        // サーバーの設定を上書き更新
        const res = await fetch("/api/config/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(configData)
        });
        const data = await res.json();

        appendTerminalLog(el.behaviorTerminal, `[SYSTEM] 設定ファイルをインポートしました: ${data.message}`, "system-msg");
        await loadConfigAndRender();
      } catch (err) {
        alert("インポートに失敗しました。JSONファイルの構造が正しいか確認してください。");
      }
    };
    reader.readAsText(file);
  });

  // --- 11. 動作プログラム(Behavior)の起動 ＆ 停止制御 ---
  el.btnStartBehavior.addEventListener("click", async () => {
    const script = el.selBehaviorScript.value;
    if (!script) {
      alert("実行するスクリプトを選択してください。");
      return;
    }
    appendTerminalLog(el.behaviorTerminal, `プログラム '${script}' の起動要求を送信...`);
    try {
      const res = await fetch("/api/behavior/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ behavior_name: script })
      });
      const data = await res.json();
      if (data.success) {
        appendTerminalLog(el.behaviorTerminal, `[SYSTEM] ${data.message}`, "system-msg");
      } else {
        appendTerminalLog(el.behaviorTerminal, `[ERROR] ${data.message}`, "error-msg");
        // 構文エラーなどの行番号が含まれている場合は自動でエディタを開いて該当行をハイライト
        const lineMatch = data.message.match(/line\s+(\d+)/);
        if (lineMatch) {
          const errLine = parseInt(lineMatch[1], 10) || 0;
          setTimeout(() => {
            openCodeEditorModal(script, errLine);
          }, 200);
        }
      }
    } catch (err) {
      appendTerminalLog(el.behaviorTerminal, `[ERROR] 通信エラー: ${err}`, "error-msg");
    }
  });

  el.btnStopBehavior.addEventListener("click", async () => {
    appendTerminalLog(el.behaviorTerminal, "プログラム停止要求を送信...");
    try {
      const res = await fetch("/api/behavior/stop", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        appendTerminalLog(el.behaviorTerminal, `[SYSTEM] ${data.message}`, "system-msg");
      } else {
        appendTerminalLog(el.behaviorTerminal, `[ERROR] ${data.message}`, "error-msg");
      }
    } catch (err) {
      appendTerminalLog(el.behaviorTerminal, `[ERROR] 通信エラー: ${err}`, "error-msg");
    }
  });

  el.btnClearConsole.addEventListener("click", () => {
    el.behaviorTerminal.innerHTML = '<div class="terminal-line system-msg">[SYSTEM] ターミナルをクリアしました。</div>';
  });

  // --- 12. モジュール動的削除 ＆ 編集用（グローバル定義） ---
  window.deleteModule = async (name) => {
    if (!confirm(`本当にモジュール '${name}' を削除しますか？`)) return;

    // 設定ファイルから除外して更新
    state.config.modules = state.config.modules.filter(m => m.name !== name);

    try {
      const res = await fetch("/api/config/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state.config)
      });
      const data = await res.json();
      appendTerminalLog(el.behaviorTerminal, `モジュールを削除しました: ${data.message}`);
      await loadConfigAndRender();
    } catch (err) {
      console.error("モジュール削除失敗:", err);
    }
  };

  let editingModuleOriginalName = null;

  window.editModule = (name) => {
    const mod = state.config.modules.find(m => m.name === name);
    if (!mod) return;
    editingModuleOriginalName = mod.name;
    el.modalModuleType.value = mod.type;
    el.modalModuleName.value = mod.name;
    el.modalModuleId.value = mod.base_id;
    el.modalModuleDesc.value = mod.description || "";
    el.modal.classList.add("active");
  };

  // モーダル制御
  el.btnAddModuleModal.addEventListener("click", () => {
    editingModuleOriginalName = null;
    el.modalModuleName.value = "";
    el.modalModuleId.value = "";
    el.modalModuleDesc.value = "";
    el.modal.classList.add("active");
  });

  el.btnCloseModal.addEventListener("click", closeModal);
  el.btnCancelModal.addEventListener("click", closeModal);

  function closeModal() {
    el.modal.classList.remove("active");
    editingModuleOriginalName = null;
    // フォームクリア
    el.modalModuleName.value = "";
    el.modalModuleId.value = "";
    el.modalModuleDesc.value = "";
  }

  el.btnSaveModule.addEventListener("click", async () => {
    const type = el.modalModuleType.value;
    const name = el.modalModuleName.value.trim();
    const id = el.modalModuleId.value.trim();
    const desc = el.modalModuleDesc.value.trim();

    if (!name || !id) {
      alert("名前とBase CAN IDは必須です。");
      return;
    }

    if (editingModuleOriginalName) {
      if (name !== editingModuleOriginalName && state.config.modules.some(m => m.name === name)) {
        alert("すでに同じ名前のモジュールが存在します。");
        return;
      }
      const mod = state.config.modules.find(m => m.name === editingModuleOriginalName);
      if (mod) {
        mod.name = name;
        mod.type = type;
        mod.base_id = id;
        mod.description = desc;
        if (type === "mdd" && !mod.parameters) {
          mod.parameters = {
            m1: { p: 10.0, i: 0.0, d: 0.0, diameter: 100.0, direction: 1, mode: 0 },
            m2: { p: 10.0, i: 0.0, d: 0.0, diameter: 100.0, direction: 1, mode: 0 },
            m3: { p: 10.0, i: 0.0, d: 0.0, diameter: 100.0, direction: 1, mode: 0 },
            m4: { p: 10.0, i: 0.0, d: 0.0, diameter: 100.0, direction: 1, mode: 0 }
          };
        }
      }
    } else {
      // 重複チェック
      if (state.config.modules.some(m => m.name === name)) {
        alert("すでに同じ名前のモジュールが存在します。");
        return;
      }

      // 新規モジュールオブジェクト
      const newMod = {
        name: name,
        type: type,
        base_id: id,
        description: desc
      };

      // MDD特有の初期パラメータ構造を追加
      if (type === "mdd") {
        newMod.parameters = {
          m1: { p: 10.0, i: 0.0, d: 0.0, diameter: 100.0, direction: 1, mode: 0 },
          m2: { p: 10.0, i: 0.0, d: 0.0, diameter: 100.0, direction: 1, mode: 0 },
          m3: { p: 10.0, i: 0.0, d: 0.0, diameter: 100.0, direction: 1, mode: 0 },
          m4: { p: 10.0, i: 0.0, d: 0.0, diameter: 100.0, direction: 1, mode: 0 }
        };
      }

      state.config.modules.push(newMod);
    }

    try {
      const res = await fetch("/api/config/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state.config)
      });
      const data = await res.json();
      appendTerminalLog(el.behaviorTerminal, `モジュールを追加しました: ${data.message}`);

      closeModal();
      await loadConfigAndRender();
    } catch (err) {
      console.error("モジュール追加失敗:", err);
    }
  });

  // 非常停止
  el.btnEmergencyStop.addEventListener("click", async () => {
    appendTerminalLog(el.behaviorTerminal, "🚨 [EMERGENCY STOP] 非常停止コマンドを発行しました！", "error-msg");
    // 全指令を停止するために WebSocket に停止要求を一括送信
    state.config.modules.forEach(mod => {
      if (mod.type === "mdd") {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
          state.ws.send(JSON.stringify({ type: "mdd_cmd", name: mod.name, targets: [0, 0, 0, 0] }));
        }
      } else if (mod.type === "solenoid") {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
          state.ws.send(JSON.stringify({ type: "solenoid_cmd", name: mod.name, valves: new Array(12).fill(false) }));
        }
      }
    });

    // 動作プログラムの強制終了
    await fetch("/api/behavior/stop", { method: "POST" });
  });

  // 設定保存用APIの呼び出し
  async function saveConfigToServer() {
    try {
      await fetch("/api/config/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state.config)
      });
    } catch (err) {
      console.error("設定の自動保存に失敗しました:", err);
    }
  }

  // --- 13. 初期化処理の実行 ---
  connectWebSocket();
  loadConfigAndRender();
  refreshPorts();
  refreshProfiles();
  refreshBehaviors();

  // GitHub Releases アップデート確認・適用 ＆ デスクトップメニューバー制御
  const lblAppVersion = document.getElementById("lbl-app-version");
  const lblSidebarVersion = document.getElementById("lbl-sidebar-version");
  const lblAboutVer = document.getElementById("lbl-about-ver");
  const btnCheckUpdate = document.getElementById("btn-check-update");
  const btnApplyUpdate = document.getElementById("btn-apply-update");
  const btnReportIssue = document.getElementById("btn-report-issue");
  const btnHelpInfo = document.getElementById("btn-help-info");

  // アップデート確認モーダル要素
  const updateModal = document.getElementById("update-check-modal");
  const btnCloseUpdateModal = document.getElementById("btn-close-update-modal");
  const btnCancelUpdateModal = document.getElementById("btn-cancel-update-modal");
  const btnExecUpdateModal = document.getElementById("btn-exec-update-modal");
  const btnRestartNow = document.getElementById("btn-restart-now");
  const lblModalCurVer = document.getElementById("lbl-modal-cur-ver");
  const lblModalLatestVer = document.getElementById("lbl-modal-latest-ver");
  const lblUpdateModalMsg = document.getElementById("lbl-update-modal-msg");
  const boxUpdateReleaseNotes = document.getElementById("box-update-release-notes");
  const progressContainer = document.getElementById("update-progress-container");
  const progressSpinner = document.getElementById("update-progress-spinner");
  const progressStep = document.getElementById("update-progress-step");
  const progressTimer = document.getElementById("update-progress-timer");
  const progressBarFill = document.getElementById("update-progress-bar-fill");
  const progressDetail = document.getElementById("update-progress-detail");

  // ヘルプ / 権利情報モーダル要素
  const helpAboutModal = document.getElementById("help-about-modal");
  const btnCloseHelpModal = document.getElementById("btn-close-help-modal");
  const btnOkHelpModal = document.getElementById("btn-ok-help-modal");
  const btnOpenHelp = document.getElementById("btn-open-help");
  const btnAppUninstall = document.getElementById("btn-app-uninstall");

  if (btnOpenHelp && helpAboutModal) {
    btnOpenHelp.addEventListener("click", () => helpAboutModal.classList.add("active"));
  }

  if (btnAppUninstall) {
    btnAppUninstall.addEventListener("click", async () => {
      if (!confirm("Altair_module_system_control をアンインストールしますか？\nWindowsのアンインストーラーを起動します。")) {
        return;
      }
      try {
        const res = await fetch("/api/system/uninstall", { method: "POST" });
        const data = await res.json();
        alert(data.message);
        if (data.success && helpAboutModal) {
          helpAboutModal.classList.remove("active");
        }
      } catch (err) {
        alert("アンインストーラーの起動要求に失敗しました: " + err);
      }
    });
  }

  async function openExternalUrl(url) {
    try {
      await fetch("/api/open_url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url })
      });
    } catch (_) {
      window.open(url, "_blank");
    }
  }

  let updateTimerInterval = null;

  async function triggerAppRestart() {
    if (progressStep) progressStep.textContent = "アプリを再起動中...";
    if (progressDetail) progressDetail.textContent = "新しいプロセスを起動しています。まもなく画面が再読み込みされます...";
    if (btnRestartNow) {
      btnRestartNow.disabled = true;
      btnRestartNow.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> 再起動中...`;
    }

    try {
      await fetch("/api/system/restart", { method: "POST" });
    } catch (_) {
      // サーバープロセスが終了するとfetchがエラーになる場合があるが正常
    }

    // サーバーが新プロセスで立ち上がるまでポーリングし、応答があれば画面をリロード
    let pollCount = 0;
    const pollInterval = setInterval(async () => {
      pollCount++;
      try {
        const res = await fetch("/api/update/check", { cache: "no-store" });
        if (res.ok) {
          clearInterval(pollInterval);
          window.location.reload();
        }
      } catch (_) {
        // まだ起動準備中
      }
      if (pollCount > 30) {
        clearInterval(pollInterval);
        if (progressDetail) {
          progressDetail.textContent = "再起動に時間がかかっています。手動でアプリを起動してください。";
        }
      }
    }, 1000);
  }

  async function executeSelfUpdate() {
    // モーダルが閉じていれば開く
    if (updateModal && !updateModal.classList.contains("active")) {
      updateModal.classList.add("active");
    }

    if (!confirm("GitHub Releases から最新バージョンをダウンロードして更新しますか？\n更新完了後、アプリは自動で再起動されます。")) {
      return;
    }

    // UI状態を更新中へ切り替え
    if (btnApplyUpdate) btnApplyUpdate.disabled = true;
    if (btnExecUpdateModal) btnExecUpdateModal.style.display = "none";
    if (btnCancelUpdateModal) {
      btnCancelUpdateModal.disabled = true;
      btnCancelUpdateModal.textContent = "更新処理中...";
    }
    if (btnCloseUpdateModal) btnCloseUpdateModal.disabled = true;
    if (btnRestartNow) btnRestartNow.style.display = "none";

    // プログレスインジケーター表示
    if (progressContainer) {
      progressContainer.style.display = "block";
    }
    if (progressSpinner) {
      progressSpinner.className = "fa-solid fa-circle-notch fa-spin";
      progressSpinner.style.color = "var(--color-primary, #3b82f6)";
    }
    if (progressStep) progressStep.textContent = "最新バイナリをダウンロード中 (1/3)";
    if (progressBarFill) {
      progressBarFill.className = "update-progress-bar-fill indeterminate";
      progressBarFill.style.width = "100%";
    }
    if (progressTimer) progressTimer.textContent = "0s";
    if (progressDetail) {
      progressDetail.textContent = "GitHub Releases から最新バイナリを受信しています...";
    }
    if (lblUpdateModalMsg) {
      lblUpdateModalMsg.textContent = "ダウンロードと適用を実行しています。しばらくお待ちください...";
    }

    appendTerminalLog(el.behaviorTerminal, "[UPDATE] 最新バイナリをダウンロードして適用中...", "system-msg");

    // 経過秒数タイマー開始（フリーズしていないことの明示）
    let elapsedSeconds = 0;
    if (updateTimerInterval) clearInterval(updateTimerInterval);
    updateTimerInterval = setInterval(() => {
      elapsedSeconds++;
      if (progressTimer) progressTimer.textContent = `${elapsedSeconds}s`;

      if (elapsedSeconds >= 4 && elapsedSeconds < 10) {
        if (progressStep) progressStep.textContent = "バイナリを受信中... (1/3)";
        if (progressDetail) progressDetail.textContent = "GitHub からデータをダウンロードしています。ネットワーク状況により数十秒かかる場合があります...";
      } else if (elapsedSeconds >= 10 && elapsedSeconds < 25) {
        if (progressStep) progressStep.textContent = "データ受信・検証中... (2/3)";
        if (progressDetail) progressDetail.textContent = "大きなアセットをダウンロード中です。処理は正常に進行しています...";
      } else if (elapsedSeconds >= 25) {
        if (progressStep) progressStep.textContent = "ファイルを展開・置換中... (2/3)";
        if (progressDetail) progressDetail.textContent = "アーカイブの展開と実行ファイルの安全な置換を行っています...";
      }
    }, 1000);

    try {
      const res = await fetch("/api/update/apply", { method: "POST" });
      const data = await res.json();
      clearInterval(updateTimerInterval);

      if (data.success && data.updated) {
        // アップデート成功
        appendTerminalLog(el.behaviorTerminal, `[UPDATE] ${data.message}`, "system-msg");
        if (lblUpdateModalMsg) lblUpdateModalMsg.textContent = data.message;
        if (progressSpinner) {
          progressSpinner.className = "fa-solid fa-circle-check";
          progressSpinner.style.color = "#10b981";
        }
        if (progressStep) progressStep.textContent = "アップデート完了 (3/3)";
        if (progressBarFill) {
          progressBarFill.className = "update-progress-bar-fill success";
          progressBarFill.style.width = "100%";
        }

        if (btnRestartNow) {
          btnRestartNow.style.display = "inline-flex";
          btnRestartNow.disabled = false;
          btnRestartNow.innerHTML = `<i class="fa-solid fa-rotate-right"></i> 今すぐ再起動`;
          btnRestartNow.onclick = () => {
            clearInterval(countdownInterval);
            triggerAppRestart();
          };
        }

        // 2秒カウントダウン後に自動再起動
        let count = 2;
        if (progressDetail) {
          progressDetail.textContent = `${count}秒後にアプリを自動再起動します...`;
        }
        const countdownInterval = setInterval(() => {
          count--;
          if (count > 0) {
            if (progressDetail) {
              progressDetail.textContent = `${count}秒後にアプリを自動再起動します...`;
            }
          } else {
            clearInterval(countdownInterval);
            triggerAppRestart();
          }
        }, 1000);

      } else if (data.success && !data.updated) {
        // すでに最新
        appendTerminalLog(el.behaviorTerminal, `[UPDATE] ${data.message}`, "system-msg");
        if (lblUpdateModalMsg) lblUpdateModalMsg.textContent = data.message;
        if (progressSpinner) {
          progressSpinner.className = "fa-solid fa-circle-info";
          progressSpinner.style.color = "#3b82f6";
        }
        if (progressStep) progressStep.textContent = "すでに最新バージョンです";
        if (progressBarFill) {
          progressBarFill.className = "update-progress-bar-fill success";
        }
        if (progressDetail) progressDetail.textContent = data.message;
        if (btnCancelUpdateModal) {
          btnCancelUpdateModal.disabled = false;
          btnCancelUpdateModal.textContent = "閉じる";
        }
        if (btnCloseUpdateModal) btnCloseUpdateModal.disabled = false;

      } else {
        // エラー
        appendTerminalLog(el.behaviorTerminal, `[ERROR] ${data.message}`, "error-msg");
        if (lblUpdateModalMsg) lblUpdateModalMsg.textContent = `エラー: ${data.message}`;
        if (progressSpinner) {
          progressSpinner.className = "fa-solid fa-circle-xmark";
          progressSpinner.style.color = "#ef4444";
        }
        if (progressStep) progressStep.textContent = "アップデート失敗";
        if (progressBarFill) {
          progressBarFill.className = "update-progress-bar-fill error";
        }
        if (progressDetail) progressDetail.textContent = data.message;
        if (btnApplyUpdate) btnApplyUpdate.disabled = false;
        if (btnExecUpdateModal) {
          btnExecUpdateModal.style.display = "inline-flex";
          btnExecUpdateModal.disabled = false;
        }
        if (btnCancelUpdateModal) {
          btnCancelUpdateModal.disabled = false;
          btnCancelUpdateModal.textContent = "閉じる";
        }
        if (btnCloseUpdateModal) btnCloseUpdateModal.disabled = false;
      }
    } catch (err) {
      clearInterval(updateTimerInterval);
      appendTerminalLog(el.behaviorTerminal, `[ERROR] アップデート適用エラー: ${err}`, "error-msg");
      if (lblUpdateModalMsg) lblUpdateModalMsg.textContent = `通信エラー: ${err}`;
      if (progressSpinner) {
        progressSpinner.className = "fa-solid fa-circle-xmark";
        progressSpinner.style.color = "#ef4444";
      }
      if (progressStep) progressStep.textContent = "アップデート失敗";
      if (progressBarFill) {
        progressBarFill.className = "update-progress-bar-fill error";
      }
      if (progressDetail) progressDetail.textContent = String(err);
      if (btnApplyUpdate) btnApplyUpdate.disabled = false;
      if (btnExecUpdateModal) {
        btnExecUpdateModal.style.display = "inline-flex";
        btnExecUpdateModal.disabled = false;
      }
      if (btnCancelUpdateModal) {
        btnCancelUpdateModal.disabled = false;
        btnCancelUpdateModal.textContent = "閉じる";
      }
      if (btnCloseUpdateModal) btnCloseUpdateModal.disabled = false;
    }
  }

  async function checkAppUpdate(manual = false) {
    if (manual && updateModal) {
      if (lblModalLatestVer) lblModalLatestVer.textContent = "確認中...";
      if (lblUpdateModalMsg) lblUpdateModalMsg.textContent = "GitHub Releases に問い合わせています...";
      if (boxUpdateReleaseNotes) boxUpdateReleaseNotes.style.display = "none";
      if (btnExecUpdateModal) btnExecUpdateModal.style.display = "none";
      if (btnRestartNow) btnRestartNow.style.display = "none";
      if (progressContainer) progressContainer.style.display = "none";
      if (btnCancelUpdateModal) {
        btnCancelUpdateModal.disabled = false;
        btnCancelUpdateModal.textContent = "閉じる";
      }
      if (btnCloseUpdateModal) btnCloseUpdateModal.disabled = false;
      updateModal.classList.add("active");
    }

    try {
      const res = await fetch("/api/update/check");
      const data = await res.json();
      if (data.current_version) {
        const vText = `v${data.current_version}`;
        if (lblAppVersion) lblAppVersion.textContent = vText;
        if (lblSidebarVersion) lblSidebarVersion.textContent = vText;
        if (lblAboutVer) lblAboutVer.textContent = vText;
        if (lblModalCurVer) lblModalCurVer.textContent = vText;
      }
      if (lblModalLatestVer && data.latest_version) {
        lblModalLatestVer.textContent = `v${data.latest_version}`;
      }
      if (lblUpdateModalMsg && data.message) {
        lblUpdateModalMsg.textContent = data.message;
      }
      if (boxUpdateReleaseNotes) {
        if (data.release_notes && data.release_notes.trim().length > 0) {
          boxUpdateReleaseNotes.textContent = data.release_notes;
          boxUpdateReleaseNotes.style.display = "block";
        } else {
          boxUpdateReleaseNotes.style.display = "none";
        }
      }

      if (data.update_available) {
        if (btnApplyUpdate) {
          btnApplyUpdate.style.display = "inline-flex";
          btnApplyUpdate.innerHTML = `<i class="fa-solid fa-cloud-arrow-down"></i> v${data.latest_version} へ更新`;
        }
        if (btnExecUpdateModal) {
          btnExecUpdateModal.style.display = "inline-flex";
        }
        appendTerminalLog(el.behaviorTerminal, `[UPDATE] ${data.message}`, "system-msg");
      } else if (manual) {
        appendTerminalLog(el.behaviorTerminal, `[UPDATE] ${data.message}`, "system-msg");
      }
    } catch (err) {
      if (lblUpdateModalMsg) {
        lblUpdateModalMsg.textContent = `アップデート確認に失敗しました: ${err}`;
      }
      if (manual) {
        appendTerminalLog(el.behaviorTerminal, `[ERROR] アップデート確認エラー: ${err}`, "error-msg");
      }
    }
  }

  if (btnCheckUpdate) {
    btnCheckUpdate.addEventListener("click", () => checkAppUpdate(true));
  }
  if (btnApplyUpdate) {
    btnApplyUpdate.addEventListener("click", executeSelfUpdate);
  }
  if (btnExecUpdateModal) {
    btnExecUpdateModal.addEventListener("click", executeSelfUpdate);
  }
  if (btnCloseUpdateModal && updateModal) {
    btnCloseUpdateModal.addEventListener("click", () => {
      if (btnCloseUpdateModal.disabled) return;
      updateModal.classList.remove("active");
    });
  }
  if (btnCancelUpdateModal && updateModal) {
    btnCancelUpdateModal.addEventListener("click", () => {
      if (btnCancelUpdateModal.disabled) return;
      updateModal.classList.remove("active");
    });
  }

  if (btnReportIssue) {
    btnReportIssue.addEventListener("click", () => {
      openExternalUrl("https://github.com/Altairu/Altair_module_system_control/issues/new");
    });
  }

  if (btnHelpInfo && helpAboutModal) {
    btnHelpInfo.addEventListener("click", () => helpAboutModal.classList.add("active"));
  }
  if (btnCloseHelpModal && helpAboutModal) {
    btnCloseHelpModal.addEventListener("click", () => helpAboutModal.classList.remove("active"));
  }
  if (btnOkHelpModal && helpAboutModal) {
    btnOkHelpModal.addEventListener("click", () => helpAboutModal.classList.remove("active"));
  }

  // 上部メニューバー (ファイル / ヘルプ) ドロップダウン開閉とアクション
  const menuDropdowns = document.querySelectorAll(".win-menu-dropdown");
  menuDropdowns.forEach(dd => {
    const trigger = dd.querySelector(".win-menu-trigger");
    if (trigger) {
      trigger.addEventListener("click", (e) => {
        e.stopPropagation();
        const isOpen = dd.classList.contains("open");
        menuDropdowns.forEach(d => d.classList.remove("open"));
        if (!isOpen) dd.classList.add("open");
      });
    }
  });
  document.addEventListener("click", () => {
    menuDropdowns.forEach(d => d.classList.remove("open"));
  });

  const menuImport = document.getElementById("menu-item-import-profile");
  const menuExport = document.getElementById("menu-item-export-profile");
  const menuReload = document.getElementById("menu-item-reload");
  const menuCheckUpdate = document.getElementById("menu-item-check-update");
  const menuReportIssue = document.getElementById("menu-item-report-issue");
  const menuAbout = document.getElementById("menu-item-about");

  if (menuImport && el.fileImportProfile) {
    menuImport.addEventListener("click", () => el.fileImportProfile.click());
  }
  if (menuExport && el.btnExportProfile) {
    menuExport.addEventListener("click", () => el.btnExportProfile.click());
  }
  if (menuReload) {
    menuReload.addEventListener("click", () => window.location.reload());
  }
  if (menuCheckUpdate) {
    menuCheckUpdate.addEventListener("click", () => checkAppUpdate(true));
  }
  if (menuReportIssue) {
    menuReportIssue.addEventListener("click", () => {
      openExternalUrl("https://github.com/Altairu/Altair_module_system_control/issues/new");
    });
  }
  if (menuAbout && helpAboutModal) {
    menuAbout.addEventListener("click", () => helpAboutModal.classList.add("active"));
  }

  checkAppUpdate(false);

  // 全画面表示の切り替え
  const btnFullscreen = document.getElementById("btn-fullscreen-toggle");
  if (btnFullscreen) {
    btnFullscreen.addEventListener("click", () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(err => {
          console.error(`全画面表示への切り替えに失敗しました: ${err.message}`);
        });
        btnFullscreen.innerHTML = '<i class="fa-solid fa-compress"></i> 画面縮小';
      } else {
        document.exitFullscreen();
        btnFullscreen.innerHTML = '<i class="fa-solid fa-expand"></i> 全画面表示';
      }
    });
  }

  // ==========================================================================
  // --- 14. Blockly ビジュアルマクロ統合 ＆ Pythonコードリアルタイム生成 ---
  // ==========================================================================

  // 登録済みモジュールの一覧を動的に取得するドロップダウン生成ヘルパー
  const getModuleOptionsDropdown = function (type) {
    return function () {
      if (!state.config || !state.config.modules) {
        return [["未選択", "none"]];
      }
      const mods = state.config.modules.filter(m => m.type === type);
      let options = mods.map(m => [m.name, m.name]);
      if (options.length === 0) {
        options.push(["登録なし", "none"]);
      }
      return options;
    };
  };

  // Blockly カスタムブロック定義
  Blockly.Blocks['mdd_move'] = {
    init: function () {
      this.appendDummyInput()
        .appendField("MDD モータ制御")
        .appendField(new Blockly.FieldDropdown(getModuleOptionsDropdown('mdd')), "NAME");
      this.appendValueInput("M1")
        .setCheck("Number")
        .appendField("M1");
      this.appendValueInput("M2")
        .setCheck("Number")
        .appendField("M2");
      this.appendValueInput("M3")
        .setCheck("Number")
        .appendField("M3");
      this.appendValueInput("M4")
        .setCheck("Number")
        .appendField("M4");
      this.setPreviousStatement(true, null);
      this.setNextStatement(true, null);
      this.setColour(230);
      this.setTooltip("MDDモータの目標速度/目標角度/目標位置を一括指示します。");
      this.setHelpUrl("");
    }
  };

  Blockly.Blocks['servo_move'] = {
    init: function () {
      this.appendDummyInput()
        .appendField("Servo 角度制御")
        .appendField(new Blockly.FieldDropdown(getModuleOptionsDropdown('servo')), "NAME");
      this.appendValueInput("S1")
        .setCheck("Number")
        .appendField("S1 (0-180°)");
      this.appendValueInput("S2")
        .setCheck("Number")
        .appendField("S2 (0-180°)");
      this.appendValueInput("S3")
        .setCheck("Number")
        .appendField("S3 (0-180°)");
      this.appendValueInput("S4")
        .setCheck("Number")
        .appendField("S4 (0-180°)");
      this.appendValueInput("S5")
        .setCheck("Number")
        .appendField("S5 (0-180°)");
      this.appendValueInput("S6")
        .setCheck("Number")
        .appendField("S6 (0-180°)");
      this.setPreviousStatement(true, null);
      this.setNextStatement(true, null);
      this.setColour(60);
      this.setTooltip("サーボの目標角度を6ch一括指示します。");
      this.setHelpUrl("");
    }
  };

  Blockly.Blocks['valve_control'] = {
    init: function () {
      this.appendDummyInput()
        .appendField("Solenoid 電磁弁制御")
        .appendField(new Blockly.FieldDropdown(getModuleOptionsDropdown('solenoid')), "NAME")
        .appendField("Ch")
        .appendField(new Blockly.FieldNumber(1, 1, 12, 1), "CHANNEL")
        .appendField("状態")
        .appendField(new Blockly.FieldDropdown([["ON", "True"], ["OFF", "False"]]), "STATE");
      this.setPreviousStatement(true, null);
      this.setNextStatement(true, null);
      this.setColour(0);
      this.setTooltip("特定の電磁弁をON/OFF制御します。");
      this.setHelpUrl("");
    }
  };

  Blockly.Blocks['mdd_sw_val'] = {
    init: function () {
      this.appendDummyInput()
        .appendField("MDD SW:")
        .appendField(new Blockly.FieldDropdown(getModuleOptionsDropdown('mdd')), "NAME")
        .appendField("の リミットSW")
        .appendField(new Blockly.FieldDropdown([["SW1", "0"], ["SW2", "1"], ["SW3", "2"], ["SW4", "3"]]), "SW_IDX")
        .appendField("状態 (ON/OFF)");
      this.setOutput(true, "Boolean");
      this.setColour(80);
      this.setTooltip("対象MDDのリミットスイッチ状態(True=ON / 押されている, False=OFF)を取得します。");
      this.setHelpUrl("");
    }
  };

  Blockly.Blocks['mdd_enc_deg_val'] = {
    init: function () {
      this.appendDummyInput()
        .appendField("MDD エンコーダー:")
        .appendField(new Blockly.FieldDropdown(getModuleOptionsDropdown('mdd')), "NAME")
        .appendField("の モータ")
        .appendField(new Blockly.FieldDropdown([["M1", "0"], ["M2", "1"], ["M3", "2"], ["M4", "3"]]), "MOTOR_IDX")
        .appendField("の現在角度 (度)");
      this.setOutput(true, "Number");
      this.setColour(80);
      this.setTooltip("対象MDDのモータの現在角度(度)を取得します。");
      this.setHelpUrl("");
    }
  };

  Blockly.Blocks['mdd_enc_rps_val'] = {
    init: function () {
      this.appendDummyInput()
        .appendField("MDD エンコーダー:")
        .appendField(new Blockly.FieldDropdown(getModuleOptionsDropdown('mdd')), "NAME")
        .appendField("の モータ")
        .appendField(new Blockly.FieldDropdown([["M1", "0"], ["M2", "1"], ["M3", "2"], ["M4", "3"]]), "MOTOR_IDX")
        .appendField("の現在速度 (rps)");
      this.setOutput(true, "Number");
      this.setColour(80);
      this.setTooltip("対象MDDのモータの現在回転速度(rps)を取得します。");
      this.setHelpUrl("");
    }
  };

  Blockly.Blocks['event_macro'] = {
    init: function () {
      this.appendDummyInput()
        .appendField("🏁 マクロ実行時 (エントリポイント)");
      this.appendStatementInput("DO")
        .setCheck(null);
      this.setColour('#f59e0b');
      this.setTooltip("「マクロを実行」ボタンを押した時に、この中に接続されたブロックが上から順に実行されます。");
    }
  };

  Blockly.Blocks['delay_wait'] = {
    init: function () {
      this.appendDummyInput()
        .appendField("遅延ウェイト")
        .appendField(new Blockly.FieldNumber(500, 0, 60000, 10), "MS")
        .appendField("ミリ秒 (ms)");
      this.setPreviousStatement(true, null);
      this.setNextStatement(true, null);
      this.setColour(120);
      this.setTooltip("指定されたミリ秒数処理を一時停止します。1000ミリ秒＝1秒です。");
      this.setHelpUrl("");
    }
  };

  Blockly.Blocks['print_log'] = {
    init: function () {
      this.appendDummyInput()
        .appendField("ログ出力");
      this.appendValueInput("TEXT")
        .setCheck(null);
      this.setPreviousStatement(true, null);
      this.setNextStatement(true, null);
      this.setColour(180);
      this.setTooltip("ROS2ログ出力画面に変数の値や文字列を出力します。");
      this.setHelpUrl("");
    }
  };

  // コントローラー用カスタムブロック
  Blockly.Blocks['gamepad_button'] = {
    init: function () {
      this.appendDummyInput()
        .appendField("コントローラー ボタン")
        .appendField(new Blockly.FieldDropdown([
          ["Button A / ×", "0"],
          ["Button B / ○", "1"],
          ["Button X / □", "2"],
          ["Button Y / △", "3"],
          ["L1", "4"],
          ["R1", "5"],
          ["L2 (デジタル)", "6"],
          ["R2 (デジタル)", "7"],
          ["Share / Select", "8"],
          ["Options / Start", "9"],
          ["L-Stick クリック", "10"],
          ["R-Stick クリック", "11"],
          ["D-Pad Up", "12"],
          ["D-Pad Down", "13"],
          ["D-Pad Left", "14"],
          ["D-Pad Right", "15"]
        ]), "BUTTON");
      this.setOutput(true, "Boolean");
      this.setColour(290);
      this.setTooltip("ゲームコントローラーの特定のボタンが押されているか(True/False)を取得します。");
      this.setHelpUrl("");
    }
  };

  Blockly.Blocks['gamepad_axis'] = {
    init: function () {
      this.appendDummyInput()
        .appendField("コントローラー ")
        .appendField(new Blockly.FieldDropdown([
          ["L-Stick 左右 (X)", "0"],
          ["L-Stick 上下 (Y)", "1"],
          ["R-Stick 左右 (X)", "2"],
          ["R-Stick 上下 (Y)", "3"]
        ]), "AXIS")
        .appendField("傾き");
      this.setOutput(true, "Number");
      this.setColour(290);
      this.setTooltip("ゲームコントローラーの指定されたスティックの傾き値(-1.0〜1.0)を取得します。");
      this.setHelpUrl("");
    }
  };

  Blockly.Blocks['gamepad_axis_scaled'] = {
    init: function () {
      this.appendDummyInput()
        .appendField("コントローラー ")
        .appendField(new Blockly.FieldDropdown([
          ["L-Stick 左右 (X)", "0"],
          ["L-Stick 上下 (Y)", "1"],
          ["R-Stick 左右 (X)", "2"],
          ["R-Stick 上下 (Y)", "3"]
        ]), "AXIS")
        .appendField("の傾き × 係数")
        .appendField(new Blockly.FieldNumber(1000, -10000, 10000, 1), "SCALE");
      this.setOutput(true, "Number");
      this.setColour(290);
      this.setTooltip("コントローラーの指定されたスティックの傾き値(-1.0〜1.0)に指定した係数を掛けた値を取得します。");
      this.setHelpUrl("");
    }
  };

  Blockly.Blocks['robot_kinematics'] = {
    init: function () {
      this.appendDummyInput()
        .appendField("🤖 ロボット運動学制御")
        .appendField(new Blockly.FieldDropdown([
          ["3輪オムニ", "3_OMNI"],
          ["4輪オムニ", "4_OMNI"],
          ["4輪メカナム", "4_MECANUM"],
          ["差動2輪", "2_DIFF"]
        ]), "TYPE");
      this.appendDummyInput()
        .appendField("モータドライバ:")
        .appendField(new Blockly.FieldDropdown(getModuleOptionsDropdown('mdd')), "MDD")
        .appendField("  旋回直径:")
        .appendField(new Blockly.FieldNumber(300, 10, 2000, 1), "L")
        .appendField("mm");
      this.appendDummyInput()
        .appendField("モータ割当: LF/左前/左輪:")
        .appendField(new Blockly.FieldDropdown([["M1", "m1"], ["M2", "m2"], ["M3", "m3"], ["M4", "m4"], ["なし", "none"]]), "M_LF")
        .appendField(" 反転:")
        .appendField(new Blockly.FieldCheckbox("FALSE"), "INV_LF");
      this.appendDummyInput()
        .appendField("            RF/右前/右輪:")
        .appendField(new Blockly.FieldDropdown([["M1", "m1"], ["M2", "m2"], ["M3", "m3"], ["M4", "m4"], ["なし", "none"]]), "M_RF")
        .appendField(" 反転:")
        .appendField(new Blockly.FieldCheckbox("FALSE"), "INV_RF");
      this.appendDummyInput()
        .appendField("            LR/左後/左輪:")
        .appendField(new Blockly.FieldDropdown([["M1", "m1"], ["M2", "m2"], ["M3", "m3"], ["M4", "m4"], ["なし", "none"]]), "M_LR")
        .appendField(" 反転:")
        .appendField(new Blockly.FieldCheckbox("FALSE"), "INV_LR");
      this.appendDummyInput()
        .appendField("            RR/右後/右輪:")
        .appendField(new Blockly.FieldDropdown([["M1", "m1"], ["M2", "m2"], ["M3", "m3"], ["M4", "m4"], ["なし", "none"]]), "M_RR")
        .appendField(" 反転:")
        .appendField(new Blockly.FieldCheckbox("FALSE"), "INV_RR");
      this.appendValueInput("VX")
        .setCheck("Number")
        .appendField("入力 Vx (左右速度 mm/s)");
      this.appendValueInput("VY")
        .setCheck("Number")
        .appendField("入力 Vy (前後速度 mm/s)");
      this.appendValueInput("OMEGA")
        .setCheck("Number")
        .appendField("入力 ω (旋回角速度 rad/s)");
      this.setPreviousStatement(true, null);
      this.setNextStatement(true, null);
      this.setColour(260);
      this.setTooltip("Vx, Vy, ω から足回りの逆運動学を計算し、指定したMDDモータの目標値へ指示します。各タイヤ直径はパラメータ設定の値が自動使用されます。");
      this.setHelpUrl("");
    }
  };

  // Blockly.Python ジェネレーターの定義と互換性ポリフィル
  let pyGen = null;
  if (typeof python !== 'undefined' && python.pythonGenerator) {
    pyGen = python.pythonGenerator;
    // 古いコードへの互換マッピングを安全に行う
    if (typeof Blockly !== 'undefined') {
      Blockly.Python = pyGen;
    }
  } else if (typeof Blockly !== 'undefined' && Blockly.Python) {
    pyGen = Blockly.Python;
  }
  if (pyGen) {
    pyGen.INDENT = "    "; // Pythonの標準インデント幅を4スペースに統一
  }
  if (typeof Blockly !== 'undefined' && Blockly.Python) {
    Blockly.Python.INDENT = "    ";
  }

  // ジェネレーター登録ヘルパー（最新・旧バージョン両対応）
  const registerGenerator = function (blockName, generatorFunc) {
    if (!pyGen) return;
    if (pyGen.forBlock) {
      pyGen.forBlock[blockName] = generatorFunc;
    } else {
      pyGen[blockName] = generatorFunc;
    }
  };

  // アトミックオーダー取得ヘルパー
  const getAtomicOrder = function () {
    if (pyGen && pyGen.Order) return pyGen.Order.ATOMIC;
    if (Blockly.Python && typeof Blockly.Python.ORDER_ATOMIC !== 'undefined') return Blockly.Python.ORDER_ATOMIC;
    return 99; // fallback
  };

  registerGenerator('event_macro', function (block, generator) {
    const gen = generator || pyGen;
    const branch = gen.statementToCode(block, 'DO');
    // statementToCode が自動付与する先頭のインデントを1レベル分削除する
    const indent = gen.INDENT || '    ';
    const cleanedBranch = branch.split('\n').map(line => {
      if (line.startsWith(indent)) {
        return line.substring(indent.length);
      }
      return line;
    }).join('\n');
    return cleanedBranch;
  });

  registerGenerator('mdd_move', function (block, generator) {
    const root = block.getRootBlock();
    if (!root || root.type !== 'event_macro') return '';
    const name = block.getFieldValue('NAME');
    if (name === 'none') return '';
    const gen = generator || pyGen;
    const order = getAtomicOrder();
    const m1 = gen.valueToCode(block, 'M1', order) || '0.0';
    const m2 = gen.valueToCode(block, 'M2', order) || '0.0';
    const m3 = gen.valueToCode(block, 'M3', order) || '0.0';
    const m4 = gen.valueToCode(block, 'M4', order) || '0.0';
    return `self.get_module("${name}").set_targets([${m1}, ${m2}, ${m3}, ${m4}])\n`;
  });

  registerGenerator('servo_move', function (block, generator) {
    const root = block.getRootBlock();
    if (!root || root.type !== 'event_macro') return '';
    const name = block.getFieldValue('NAME');
    if (name === 'none') return '';
    const gen = generator || pyGen;
    const order = getAtomicOrder();
    const s1 = gen.valueToCode(block, 'S1', order) || '90';
    const s2 = gen.valueToCode(block, 'S2', order) || '90';
    const s3 = gen.valueToCode(block, 'S3', order) || '90';
    const s4 = gen.valueToCode(block, 'S4', order) || '90';
    const s5 = gen.valueToCode(block, 'S5', order) || '90';
    const s6 = gen.valueToCode(block, 'S6', order) || '90';
    return `self.get_module("${name}").set_angles([${s1}, ${s2}, ${s3}, ${s4}, ${s5}, ${s6}])\n`;
  });

  registerGenerator('valve_control', function (block, generator) {
    const root = block.getRootBlock();
    if (!root || root.type !== 'event_macro') return '';
    const name = block.getFieldValue('NAME');
    if (name === 'none') return '';
    const channel = block.getFieldValue('CHANNEL');
    const state = block.getFieldValue('STATE');
    return `self.get_module("${name}").set_valve(${channel}, ${state})\n`;
  });

  registerGenerator('delay_wait', function (block, generator) {
    const root = block.getRootBlock();
    if (!root || root.type !== 'event_macro') return '';
    const ms = block.getFieldValue('MS');
    return `time.sleep(${ms} / 1000.0)\n`;
  });

  registerGenerator('print_log', function (block, generator) {
    const root = block.getRootBlock();
    if (!root || root.type !== 'event_macro') return '';
    const gen = generator || pyGen;
    const val = gen.valueToCode(block, 'TEXT', getAtomicOrder()) || '"マクロを実行中..."';
    return `self.get_logger().info(f"[BLOCKLY] {${val}}")\n`;
  });

  registerGenerator('gamepad_button', function (block, generator) {
    const buttonIdx = block.getFieldValue('BUTTON');
    const code = `self.gamepad.get_button(${buttonIdx})`;
    return [code, getAtomicOrder()];
  });

  registerGenerator('gamepad_axis', function (block, generator) {
    const axisIdx = block.getFieldValue('AXIS');
    const code = `self.gamepad.get_axis(${axisIdx})`;
    return [code, getAtomicOrder()];
  });

  registerGenerator('mdd_sw_val', function (block, generator) {
    const name = block.getFieldValue('NAME');
    if (name === 'none') return ['False', getAtomicOrder()];
    const swIdx = block.getFieldValue('SW_IDX');
    const code = `self.get_module("${name}").get_feedback().limit_switches[${swIdx}]`;
    return [code, getAtomicOrder()];
  });

  registerGenerator('mdd_enc_deg_val', function (block, generator) {
    const name = block.getFieldValue('NAME');
    if (name === 'none') return ['0.0', getAtomicOrder()];
    const motorIdx = block.getFieldValue('MOTOR_IDX');
    const code = `self.get_module("${name}").get_feedback().angles[${motorIdx}]`;
    return [code, getAtomicOrder()];
  });

  registerGenerator('mdd_enc_rps_val', function (block, generator) {
    const name = block.getFieldValue('NAME');
    if (name === 'none') return ['0.0', getAtomicOrder()];
    const motorIdx = block.getFieldValue('MOTOR_IDX');
    const code = `self.get_module("${name}").get_feedback().speeds[${motorIdx}]`;
    return [code, getAtomicOrder()];
  });

  registerGenerator('gamepad_axis_scaled', function (block, generator) {
    const axisIdx = block.getFieldValue('AXIS');
    const scale = block.getFieldValue('SCALE') || '1.0';
    const code = `(self.gamepad.get_axis(${axisIdx}) * ${scale})`;
    return [code, getAtomicOrder()];
  });

  registerGenerator('controls_whileUntil', function (block, generator) {
    const gen = generator || pyGen;
    const until = block.getFieldValue('MODE') === 'UNTIL';
    let argument0 = gen.valueToCode(block, 'BOOL', getAtomicOrder()) || 'False';
    let branch = gen.statementToCode(block, 'DO');
    if (until) {
      argument0 = 'not ' + argument0;
    }
    // ループ内に明示的なスリープがない場合でも、ビジーループによるGILロックとCPU高負荷を防ぐため 10ms (100Hz) スリープを自動挿入
    const indent = gen.INDENT || '    ';
    return `while ${argument0}:\n${branch}${indent}time.sleep(0.01)\n`;
  });

  registerGenerator('controls_repeat_ext', function (block, generator) {
    const gen = generator || pyGen;
    const repeats = gen.valueToCode(block, 'TIMES', getAtomicOrder()) || '0';
    let branch = gen.statementToCode(block, 'DO');
    const indent = gen.INDENT || '    ';
    return `for _count in range(int(${repeats})):\n${branch}${indent}time.sleep(0.01)\n`;
  });

  registerGenerator('robot_kinematics', function (block, generator) {
    const root = block.getRootBlock();
    if (!root || root.type !== 'event_macro') return '';
    const gen = generator || pyGen;
    const order = getAtomicOrder();

    const type = block.getFieldValue('TYPE');
    const mddName = block.getFieldValue('MDD');
    const tread = block.getFieldValue('L') || '300.0';

    const mLf = block.getFieldValue('M_LF');
    const mRf = block.getFieldValue('M_RF');
    const mLr = block.getFieldValue('M_LR');
    const mRr = block.getFieldValue('M_RR');

    const invLf = block.getFieldValue('INV_LF') === 'TRUE' ? '-1.0' : '1.0';
    const invRf = block.getFieldValue('INV_RF') === 'TRUE' ? '-1.0' : '1.0';
    const invLr = block.getFieldValue('INV_LR') === 'TRUE' ? '-1.0' : '1.0';
    const invRr = block.getFieldValue('INV_RR') === 'TRUE' ? '-1.0' : '1.0';

    const vx = gen.valueToCode(block, 'VX', order) || '0.0';
    const vy = gen.valueToCode(block, 'VY', order) || '0.0';
    const omega = gen.valueToCode(block, 'OMEGA', order) || '0.0';

    return `
# ロボット運動学計算と目標速度送信
_vx_val = float(${vx}) / 1000.0
_vy_val = float(${vy}) / 1000.0
_omega_val = float(${omega})
_r_t = ${tread} / 2000.0

def _get_dia(m_slot):
    if m_slot == 'none': return 100.0
    for _m in self.config.get('modules', []):
        if _m.get('name') == "${mddName}":
            return _m.get('parameters', {}).get(m_slot, {}).get('diameter', 100.0)
    return 100.0

_k_lf = 1000.0 / (3.141592653589793 * _get_dia("${mLf}"))
_k_rf = 1000.0 / (3.141592653589793 * _get_dia("${mRf}"))
_k_lr = 1000.0 / (3.141592653589793 * _get_dia("${mLr}"))
_k_rr = 1000.0 / (3.141592653589793 * _get_dia("${mRr}"))

_target_speeds = [0.0, 0.0, 0.0, 0.0]
if "${type}" == "3_OMNI":
    _v1 = (_vy_val + _r_t * _omega_val) * ${invLf}
    _v2 = (-0.866025 * _vx_val - 0.5 * _vy_val + _r_t * _omega_val) * ${invRf}
    _v3 = (0.866025 * _vx_val - 0.5 * _vy_val + _r_t * _omega_val) * ${invLr}
    for _slot, _val in [("${mLf}", _v1 * _k_lf), ("${mRf}", _v2 * _k_rf), ("${mLr}", _v3 * _k_lr)]:
        if _slot != 'none':
            _target_speeds[int(_slot[1]) - 1] = _val
elif "${type}" == "4_OMNI":
    _v_lf = (-0.707107 * _vx_val + 0.707107 * _vy_val - _r_t * _omega_val) * ${invLf}
    _v_rf = (0.707107 * _vx_val + 0.707107 * _vy_val + _r_t * _omega_val) * ${invRf}
    _v_lr = (-0.707107 * _vx_val - 0.707107 * _vy_val + _r_t * _omega_val) * ${invLr}
    _v_rr = (0.707107 * _vx_val - 0.707107 * _vy_val - _r_t * _omega_val) * ${invRr}
    for _slot, _val in [("${mLf}", _v_lf * _k_lf), ("${mRf}", _v_rf * _k_rf), ("${mLr}", _v_lr * _k_lr), ("${mRr}", _v_rr * _k_rr)]:
        if _slot != 'none':
            _target_speeds[int(_slot[1]) - 1] = _val
elif "${type}" == "4_MECANUM":
    _v_lf = (_vy_val - _vx_val - _r_t * _omega_val) * ${invLf}
    _v_rf = (_vy_val + _vx_val + _r_t * _omega_val) * ${invRf}
    _v_lr = (_vy_val + _vx_val - _r_t * _omega_val) * ${invLr}
    _v_rr = (_vy_val - _vx_val + _r_t * _omega_val) * ${invRr}
    for _slot, _val in [("${mLf}", _v_lf * _k_lf), ("${mRf}", _v_rf * _k_rf), ("${mLr}", _v_lr * _k_lr), ("${mRr}", _v_rr * _k_rr)]:
        if _slot != 'none':
            _target_speeds[int(_slot[1]) - 1] = _val
elif "${type}" == "2_DIFF":
    _v_l = _vy_val - _r_t * _omega_val
    _v_r = _vy_val + _r_t * _omega_val
    for _slot, _val in [("${mLf}", _v_l * _k_lf * ${invLf}), ("${mLr}", _v_l * _k_lr * ${invLr})]:
        if _slot != 'none':
            _target_speeds[int(_slot[1]) - 1] = _val
    for _slot, _val in [("${mRf}", _v_r * _k_rf * ${invRf}), ("${mRr}", _v_r * _k_rr * ${invRr})]:
        if _slot != 'none':
            _target_speeds[int(_slot[1]) - 1] = _val

self.get_module("${mddName}").set_targets(_target_speeds)
`;
  });

  // フルPythonコードに組み立てるヘルパー
  function generatePythonCode(blocklyCode) {
    // すべての行に対して一律で 12スペース（tryブロックのインデント）を動的に付与する
    const indentedCode = blocklyCode
      .split('\n')
      .map(line => {
        if (line.trim() === '') return '';
        return '            ' + line;
      })
      .join('\n');

    return `#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Altair Module System - Blockly 自動生成プログラム
"""

import sys
import rclpy
import os
import time
import math

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from altair_core.base_behavior import AltairBehavior

class BlocklyBehavior(AltairBehavior):
    def on_init(self):
        self.get_logger().info("BlocklyマクロBehaviorが初期化されました。")
        self.executed = False

    def loop(self):
        if self.executed:
            return
        self.executed = True
        
        try:
            print("--- Blocklyマクロの実行を開始します ---")
${indentedCode}
            print("--- Blocklyマクロの実行が完了しました ---")
        except Exception as e:
            self.get_logger().error(f"マクロ実行中にエラーが発生しました: {str(e)}")
        finally:
            sys.exit(0)

def main(args=None):
    rclpy.init(args=args)
    behavior = BlocklyBehavior("blockly_behavior_node")
    behavior.run(rate_hz=500.0)

if __name__ == '__main__':
    main()
`;
  }

  // ツールボックスの定義 XML (Logic, Math, Loops, Gamepad, 変数, テキスト, アクチュエータ, センサーの統合)
  const toolboxXml = `
    <xml id="toolbox" style="display: none">
      <category name="イベント" colour="#f59e0b">
        <block type="event_macro"></block>
      </category>
      <category name="基本動作" colour="120">
        <block type="delay_wait">
          <value name="MS"><block type="math_number"><field name="NUM">500</field></block></value>
        </block>
        <block type="print_log">
          <value name="TEXT"><block type="text"><field name="TEXT">マクロを実行中...</field></block></value>
        </block>
      </category>
      <category name="条件分岐 (Logic)" colour="210">
        <block type="controls_if"></block>
        <block type="logic_compare"></block>
        <block type="logic_operation"></block>
        <block type="logic_negate"></block>
        <block type="logic_boolean"></block>
      </category>
      <category name="繰り返し (Loops)" colour="120">
        <block type="controls_repeat_ext">
          <value name="TIMES">
            <shadow type="math_number">
              <field name="NUM">10</field>
            </shadow>
          </value>
        </block>
        <block type="controls_whileUntil"></block>
      </category>
      <category name="計算・数値 (Math)" colour="230">
        <block type="math_number"></block>
        <block type="math_arithmetic"></block>
      </category>
      <category name="テキスト" colour="160">
        <block type="text"></block>
      </category>
      <category name="変数" custom="VARIABLE" colour="330"></category>
      <category name="コントローラー" colour="290">
        <block type="gamepad_button"></block>
        <block type="gamepad_axis"></block>
        <block type="gamepad_axis_scaled">
          <field name="SCALE">1000</field>
        </block>
      </category>
      <category name="MDDモータ" colour="230">
        <block type="mdd_move">
          <value name="M1"><block type="math_number"><field name="NUM">0</field></block></value>
          <value name="M2"><block type="math_number"><field name="NUM">0</field></block></value>
          <value name="M3"><block type="math_number"><field name="NUM">0</field></block></value>
          <value name="M4"><block type="math_number"><field name="NUM">0</field></block></value>
        </block>
        <block type="robot_kinematics">
          <field name="TYPE">4_MECANUM</field>
          <field name="L">300</field>
          <field name="M_LF">m1</field>
          <field name="M_RF">m2</field>
          <field name="M_LR">m3</field>
          <field name="M_RR">m4</field>
          <value name="VX">
            <block type="gamepad_axis_scaled">
              <field name="AXIS">0</field>
              <field name="SCALE">1000</field>
            </block>
          </value>
          <value name="VY">
            <block type="gamepad_axis_scaled">
              <field name="AXIS">1</field>
              <field name="SCALE">1000</field>
            </block>
          </value>
          <value name="OMEGA">
            <block type="gamepad_axis_scaled">
              <field name="AXIS">2</field>
              <field name="SCALE">2.0</field>
            </block>
          </value>
        </block>
      </category>
      <category name="MDDセンサー値" colour="80">
        <block type="mdd_sw_val"></block>
        <block type="mdd_enc_deg_val"></block>
        <block type="mdd_enc_rps_val"></block>
      </category>
      <category name="サーボ" colour="60">
        <block type="servo_move">
          <value name="S1"><block type="math_number"><field name="NUM">90</field></block></value>
          <value name="S2"><block type="math_number"><field name="NUM">90</field></block></value>
          <value name="S3"><block type="math_number"><field name="NUM">90</field></block></value>
          <value name="S4"><block type="math_number"><field name="NUM">90</field></block></value>
          <value name="S5"><block type="math_number"><field name="NUM">90</field></block></value>
          <value name="S6"><block type="math_number"><field name="NUM">90</field></block></value>
        </block>
      </category>
      <category name="電磁弁" colour="0">
        <block type="valve_control"></block>
      </category>
    </xml>
  `;

  const blocklyDiv = document.getElementById('blocklyDiv');
  if (blocklyDiv && typeof Blockly !== 'undefined') {
    const toolboxDom = Blockly.utils.xml.textToDom(toolboxXml);
    blocklyWorkspace = Blockly.inject('blocklyDiv', {
      toolbox: toolboxDom,
      scrollbars: true,
      trashcan: true,
      grid: { spacing: 20, length: 3, colour: '#ccc', snap: true },
      zoom: { controls: true, wheel: true }
    });
  }

  // 既存コード互換のため参照名を維持
  const workspace = blocklyWorkspace;

  // サーバーから保存済みBlocklyワークスペースをロードして復元
  if (workspace && typeof Blockly !== 'undefined') {
    fetch("/api/behavior/get_blockly_workspace")
      .then(res => res.json())
      .then(data => {
        if (data.success && data.xml) {
          try {
            workspace.clear();
            const dom = Blockly.utils.xml.textToDom(data.xml);
            Blockly.Xml.domToWorkspace(dom, workspace);
            console.log("Blocklyワークスペースを正常に復元しました。");
          } catch (restoreErr) {
            console.error("Blocklyワークスペースの復元に失敗しました。デフォルトをロードします:", restoreErr);
            loadDefaultEntryBlock(workspace);
          }
        } else {
          loadDefaultEntryBlock(workspace);
        }
      })
      .catch(err => {
        console.error("Blocklyワークスペースのロードエラー:", err);
        loadDefaultEntryBlock(workspace);
      });
  }

  function loadDefaultEntryBlock(ws) {
    try {
      ws.clear();
      const defaultXml = '<xml xmlns="https://developers.google.com/blockly/xml"><block type="event_macro" id="initial_entry" x="30" y="30"></block></xml>';
      const dom = Blockly.utils.xml.textToDom(defaultXml);
      Blockly.Xml.domToWorkspace(dom, ws);
    } catch (e) {
      console.error("Defaultブロック配置失敗:", e);
    }
  }

  // リアルタイムにコードを生成＆プレビュー
  if (workspace) {
    workspace.addChangeListener(() => {
      try {
        const rawCode = Blockly.Python.workspaceToCode(workspace);
        const fullPython = generatePythonCode(rawCode);
        const codeArea = document.getElementById("blockly-code-area");
        if (codeArea) {
          codeArea.textContent = fullPython;
        }
      } catch (err) {
        const codeArea = document.getElementById("blockly-code-area");
        if (codeArea) {
          codeArea.textContent = "# コード自動生成エラー: " + err.message;
        }
      }
    });
  }

  // 単体「ブロックを保存」ボタンのイベント
  const btnSaveBlocklyXml = document.getElementById("btn-save-blockly-xml");
  if (btnSaveBlocklyXml) {
    btnSaveBlocklyXml.addEventListener("click", async () => {
      if (!workspace) {
        appendTerminalLog(el.behaviorTerminal, "[ERROR] Blocklyワークスペースが初期化されていません。", "error-msg");
        return;
      }

      const rawCode = Blockly.Python.workspaceToCode(workspace);
      const fullPython = generatePythonCode(rawCode);

      let xmlText = "";
      try {
        const dom = Blockly.Xml.workspaceToDom(workspace);
        xmlText = Blockly.Xml.domToText(dom);
      } catch (xmlErr) {
        console.error("XML変換エラー:", xmlErr);
        appendTerminalLog(el.behaviorTerminal, `[ERROR] ブロックXML変換に失敗しました: ${xmlErr.message}`, "error-msg");
        return;
      }

      appendTerminalLog(el.behaviorTerminal, "ブロックとコードをサーバーに保存中...");

      try {
        const saveRes = await fetch("/api/behavior/save_blockly", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: fullPython, xml: xmlText })
        });
        const saveData = await saveRes.json();

        if (saveData.success) {
          appendTerminalLog(el.behaviorTerminal, "[SUCCESS] ブロックの配置状態と自動生成コードを保存しました！", "system-msg");
          refreshBehaviors();
        } else {
          appendTerminalLog(el.behaviorTerminal, `[ERROR] 保存失敗: ${saveData.message}`, "error-msg");
        }
      } catch (err) {
        appendTerminalLog(el.behaviorTerminal, `[ERROR] 保存API通信エラー: ${err.message}`, "error-msg");
      }
    });
  }

  // マクロ実行ボタンのイベント
  const btnRunBlockly = document.getElementById("btn-run-blockly");
  if (btnRunBlockly) {
    btnRunBlockly.addEventListener("click", async () => {
      if (!workspace) {
        appendTerminalLog(el.behaviorTerminal, "[ERROR] Blocklyワークスペースの初期化に失敗しています。ページを再読み込みしてください。", "error-msg");
        return;
      }
      const rawCode = Blockly.Python.workspaceToCode(workspace);
      const fullPython = generatePythonCode(rawCode);

      let xmlText = "";
      try {
        const dom = Blockly.Xml.workspaceToDom(workspace);
        xmlText = Blockly.Xml.domToText(dom);
      } catch (xmlErr) {
        console.error("XML変換エラー:", xmlErr);
      }

      appendTerminalLog(el.behaviorTerminal, "Blocklyコードを blockly_behavior.py として保存中...");

      try {
        const saveRes = await fetch("/api/behavior/save_blockly", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: fullPython, xml: xmlText })
        });
        const saveData = await saveRes.json();

        if (!saveData.success) {
          appendTerminalLog(el.behaviorTerminal, `[ERROR] コード保存失敗: ${saveData.message}`, "error-msg");
          return;
        }

        appendTerminalLog(el.behaviorTerminal, "Blocklyビジュアルマクロを起動中...");

        const runRes = await fetch("/api/behavior/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ behavior_name: "blockly_behavior.py" })
        });
        const runData = await runRes.json();

        if (runData.success) {
          appendTerminalLog(el.behaviorTerminal, "[SYSTEM] Blocklyマクロが正常に起動しました。", "system-msg");
          // 実行画面（Behaviorビュー）へ自動的に切り替える
          const targetItem = document.querySelector('.menu-item[data-target="view-behavior"]');
          if (targetItem) targetItem.click();
        } else {
          appendTerminalLog(el.behaviorTerminal, `[ERROR] 起動失敗: ${runData.message}`, "error-msg");
        }
      } catch (err) {
        appendTerminalLog(el.behaviorTerminal, `[ERROR] 通信エラー: ${err}`, "error-msg");
      }
    });
  }

  // マクロ停止ボタンのイベント
  const btnStopBlockly = document.getElementById("btn-stop-blockly");
  if (btnStopBlockly) {
    btnStopBlockly.addEventListener("click", async () => {
      appendTerminalLog(el.behaviorTerminal, "マクロ停止要求を送信...");
      try {
        const res = await fetch("/api/behavior/stop", { method: "POST" });
        const data = await res.json();
        if (data.success) {
          appendTerminalLog(el.behaviorTerminal, "[SYSTEM] マクロを停止しました。", "system-msg");
        } else {
          appendTerminalLog(el.behaviorTerminal, `[ERROR] 停止失敗: ${data.message}`, "error-msg");
        }
      } catch (err) {
        appendTerminalLog(el.behaviorTerminal, `[ERROR] 通信エラー: ${err}`, "error-msg");
      }
    });
  }

  // 保存ボタンのイベント
  const btnExportBlocklyCode = document.getElementById("btn-export-blockly-code");
  if (btnExportBlocklyCode) {
    btnExportBlocklyCode.addEventListener("click", () => {
      if (!workspace) {
        appendTerminalLog(el.behaviorTerminal, "[ERROR] Blocklyワークスペースが未初期化のため保存できません。", "error-msg");
        return;
      }
      const rawCode = Blockly.Python.workspaceToCode(workspace);
      const fullPython = generatePythonCode(rawCode);
      const blob = new Blob([fullPython], { type: "text/x-python" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "blockly_behavior.py";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });
  }

  // コードプレビュードロワーの開閉制御
  const btnToggleCode = document.getElementById("btn-toggle-code");
  const btnCloseDrawer = document.getElementById("btn-close-drawer");
  const codeDrawer = document.getElementById("blockly-code-drawer");

  if (btnToggleCode && codeDrawer) {
    btnToggleCode.addEventListener("click", () => {
      codeDrawer.classList.toggle("open");
    });
  }

  if (btnCloseDrawer && codeDrawer) {
    btnCloseDrawer.addEventListener("click", () => {
      codeDrawer.classList.remove("open");
    });
  }

  // =========================================================================
  // --- 16. テレメトリ・オシロスコープ (Telemetry Scope) ---
  // =========================================================================
  const scopeState = {
    buffers: new Map(), // key: `${modName}_${motorIdx}`, value: Array of samples
    isPaused: false,
    selectedModule: "",
    selectedMotor: 0,
    selectedMetric: "angle", // "angle" or "speed"
    rangeSeconds: 5,
    prevSwStates: new Map(), // key: modName, value: [false, false, false, false]
    knownModules: new Set(),
  };

  const selScopeModule = document.getElementById("scope-module-select");
  const selScopeMotor = document.getElementById("scope-motor-select");
  const selScopeMetric = document.getElementById("scope-metric-select");
  const selScopeRange = document.getElementById("scope-range-select");
  const btnScopePause = document.getElementById("btn-scope-pause");
  const btnScopeExportCsv = document.getElementById("btn-scope-export-csv");

  function updateScopeModuleSelect() {
    if (!selScopeModule) return;
    const currentVal = selScopeModule.value;

    // 設定ファイルに登録済みの MDD モジュールを取り込む
    if (state.config && state.config.modules) {
      state.config.modules
        .filter(m => m.type === "mdd")
        .forEach(m => scopeState.knownModules.add(m.name));
    }

    const mods = Array.from(scopeState.knownModules);
    if (mods.length === 0) {
      selScopeModule.innerHTML = '<option value="">MDD未設定</option>';
      return;
    }

    selScopeModule.innerHTML = "";
    mods.forEach(name => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      if (name === scopeState.selectedModule || (!scopeState.selectedModule && name === currentVal)) {
        opt.selected = true;
      }
      selScopeModule.appendChild(opt);
    });

    if (!scopeState.selectedModule && mods.length > 0) {
      scopeState.selectedModule = currentVal && mods.includes(currentVal) ? currentVal : mods[0];
      selScopeModule.value = scopeState.selectedModule;
    }
  }

  function updateScopeData(name, data) {
    if (!name || !data) return;

    if (!scopeState.knownModules.has(name)) {
      scopeState.knownModules.add(name);
      updateScopeModuleSelect();
    }
    if (!scopeState.selectedModule) {
      scopeState.selectedModule = name;
      updateScopeModuleSelect();
    }

    const now = performance.now() / 1000.0;
    const angles = data.angles || [0, 0, 0, 0];
    const speeds = data.speeds || [0, 0, 0, 0];
    const targets = data.targets || [0, 0, 0, 0];
    const limitSw = data.limit_switches || [false, false, false, false];

    // エッジ検出（OFF ➔ ON への立ち上がり変化）
    const prevSw = scopeState.prevSwStates.get(name) || [false, false, false, false];
    const swTriggers = [false, false, false, false];
    for (let i = 0; i < 4; i++) {
      if (limitSw[i] && !prevSw[i]) {
        swTriggers[i] = true;
      }
    }
    scopeState.prevSwStates.set(name, [...limitSw]);

    for (let m = 0; m < 4; m++) {
      const key = `${name}_${m}`;
      let buf = scopeState.buffers.get(key);
      if (!buf) {
        buf = [];
        scopeState.buffers.set(key, buf);
      }

      const targetVal = targets[m] || 0.0;
      const angleVal = angles[m] || 0.0;
      const speedVal = speeds[m] || 0.0;

      if (!scopeState.isPaused) {
        buf.push({
          time: now,
          targetAngle: targetVal,
          targetSpeed: targetVal,
          angle: angleVal,
          speed: speedVal,
          errorAngle: targetVal - angleVal,
          errorSpeed: targetVal - speedVal,
          limitSw: [...limitSw],
          swTriggers: [...swTriggers],
        });

        // 100Hz で保持する最大サンプル数
        const limitCount = Math.max(150, scopeState.rangeSeconds * 120);
        while (buf.length > limitCount) {
          buf.shift();
        }
      }
    }

    if (name === scopeState.selectedModule) {
      updateScopeIndicators(data);
    }
  }

  function updateScopeIndicators(data) {
    const m = scopeState.selectedMotor;
    const isAngle = scopeState.selectedMetric === "angle";
    const target = data.targets ? data.targets[m] : 0.0;
    const actual = isAngle ? (data.angles ? data.angles[m] : 0.0) : (data.speeds ? data.speeds[m] : 0.0);
    const err = target - actual;
    const unit = isAngle ? "°" : " rps";

    const lblTarget = document.getElementById("lbl-scope-target");
    const lblActual = document.getElementById("lbl-scope-actual");
    const lblError = document.getElementById("lbl-scope-error");

    if (lblTarget) lblTarget.textContent = `${target.toFixed(1)}${unit}`;
    if (lblActual) lblActual.textContent = `${actual.toFixed(1)}${unit}`;
    if (lblError) lblError.textContent = `${(err > 0 ? "+" : "")}${err.toFixed(1)}${unit}`;

    if (data.limit_switches) {
      for (let i = 0; i < 4; i++) {
        const badge = document.getElementById(`badge-scope-sw-${i}`);
        if (badge) {
          if (data.limit_switches[i]) {
            badge.className = "badge badge-danger";
            badge.style.boxShadow = "0 0 8px rgba(229, 20, 0, 0.6)";
          } else {
            badge.className = "badge badge-secondary";
            badge.style.boxShadow = "none";
          }
        }
      }
    }
  }

  // --- Canvas オシロスコープ描画ループ ---
  function renderScopeCanvas() {
    const canvas = document.getElementById("scope-canvas");
    if (!canvas) {
      requestAnimationFrame(renderScopeCanvas);
      return;
    }

    // 非アクティブビュー時は描画をスキップしてCPUを節約
    const view = document.getElementById("view-telemetry");
    if (!view || !view.classList.contains("active")) {
      requestAnimationFrame(renderScopeCanvas);
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = rect.width;
    const height = rect.height;

    if (width === 0 || height === 0) {
      requestAnimationFrame(renderScopeCanvas);
      return;
    }

    if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
    }

    const ctx = canvas.getContext("2d");
    ctx.save();
    ctx.scale(dpr, dpr);

    // 背景の塗りつぶし
    ctx.fillStyle = "#121316";
    ctx.fillRect(0, 0, width, height);

    const mainHeight = height * 0.68;
    const splitGap = 6;
    const errTop = mainHeight + splitGap;
    const errHeight = height - errTop;

    const key = `${scopeState.selectedModule}_${scopeState.selectedMotor}`;
    const buf = scopeState.buffers.get(key) || [];
    const isAngle = scopeState.selectedMetric === "angle";

    // 上段: 目標値 vs 実測値 ＆ リミットスイッチ縦線
    drawMainScopeArea(ctx, 0, 0, width, mainHeight, buf, isAngle);

    // 下段: 追従偏差波形
    drawErrorScopeArea(ctx, 0, errTop, width, errHeight, buf, isAngle);

    ctx.restore();
    requestAnimationFrame(renderScopeCanvas);
  }

  function drawMainScopeArea(ctx, left, top, width, height, buf, isAngle) {
    const padLeft = 45;
    const padRight = 15;
    const padTop = 15;
    const padBottom = 20;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;

    if (plotW <= 0 || plotH <= 0) return;

    // Y軸レンジの自動算出
    let minVal = -10.0;
    let maxVal = 10.0;
    if (buf.length > 0) {
      for (const p of buf) {
        const t = isAngle ? p.targetAngle : p.targetSpeed;
        const a = isAngle ? p.angle : p.speed;
        minVal = Math.min(minVal, t, a);
        maxVal = Math.max(maxVal, t, a);
      }
    }
    const margin = Math.max(5.0, (maxVal - minVal) * 0.15);
    minVal -= margin;
    maxVal += margin;
    const valRange = maxVal - minVal || 1.0;

    // 背景方眼グリッド線
    ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
    ctx.lineWidth = 1;
    ctx.setLineDash([]);

    const gridRows = 5;
    for (let i = 0; i <= gridRows; i++) {
      const y = padTop + (plotH / gridRows) * i;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(padLeft + plotW, y);
      ctx.stroke();

      const val = maxVal - (valRange / gridRows) * i;
      ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
      ctx.font = "10px Consolas, monospace";
      ctx.textAlign = "right";
      ctx.fillText(val.toFixed(0), padLeft - 6, y + 3);
    }

    if (buf.length < 2) {
      ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
      ctx.font = "12px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("テレメトリ待機中...", padLeft + plotW / 2, padTop + plotH / 2);
      return;
    }

    const latestTime = buf[buf.length - 1].time;
    const startTime = latestTime - scopeState.rangeSeconds;

    const timeToX = (t) => padLeft + Math.max(0, Math.min(plotW, ((t - startTime) / scopeState.rangeSeconds) * plotW));
    const valToY = (v) => padTop + plotH - ((v - minVal) / valRange) * plotH;

    // 1. 目標値ライン (水色 #4dc9f6)
    ctx.strokeStyle = "#4dc9f6";
    ctx.lineWidth = 2;
    ctx.beginPath();
    let started = false;
    for (const p of buf) {
      if (p.time < startTime) continue;
      const x = timeToX(p.time);
      const y = valToY(isAngle ? p.targetAngle : p.targetSpeed);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    // 2. 実測値ライン (黄色 #fdd663)
    ctx.strokeStyle = "#fdd663";
    ctx.lineWidth = 2;
    ctx.beginPath();
    started = false;
    for (const p of buf) {
      if (p.time < startTime) continue;
      const x = timeToX(p.time);
      const y = valToY(isAngle ? p.angle : p.speed);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    // 3. リミットスイッチ立ち上がりイベントの縦線マーカー
    for (const p of buf) {
      if (p.time < startTime) continue;
      if (p.swTriggers && p.swTriggers.some(Boolean)) {
        const x = timeToX(p.time);

        ctx.strokeStyle = "#f28b82";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(x, padTop);
        ctx.lineTo(x, padTop + plotH);
        ctx.stroke();
        ctx.setLineDash([]);

        // ラベル印字
        for (let i = 0; i < 4; i++) {
          if (p.swTriggers[i]) {
            ctx.fillStyle = "#f28b82";
            ctx.font = "bold 9px Consolas, monospace";
            ctx.textAlign = "center";
            ctx.fillText(`SW${i + 1} ON`, x, padTop + 10 + i * 11);
          }
        }
      }
    }
  }

  function drawErrorScopeArea(ctx, left, top, width, height, buf, isAngle) {
    const padLeft = 45;
    const padRight = 15;
    const padTop = 10;
    const padBottom = 15;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;

    if (plotW <= 0 || plotH <= 0) return;

    // 偏差レンジの算出 (0を中心に上下対称)
    let maxAbsErr = 5.0;
    if (buf.length > 0) {
      for (const p of buf) {
        const e = Math.abs(isAngle ? p.errorAngle : p.errorSpeed);
        maxAbsErr = Math.max(maxAbsErr, e);
      }
    }
    maxAbsErr = Math.ceil(maxAbsErr * 1.2);

    const valToY = (err) => padTop + plotH / 2 - (err / maxAbsErr) * (plotH / 2);

    // ゼロ基準線 (中央の白い実線)
    ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    const zeroY = valToY(0);
    ctx.beginPath();
    ctx.moveTo(padLeft, zeroY);
    ctx.lineTo(padLeft + plotW, zeroY);
    ctx.stroke();

    // Y軸目盛りラベル
    ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
    ctx.font = "10px Consolas, monospace";
    ctx.textAlign = "right";
    ctx.fillText(`+${maxAbsErr}`, padLeft - 6, padTop + 8);
    ctx.fillText("0", padLeft - 6, zeroY + 3);
    ctx.fillText(`-${maxAbsErr}`, padLeft - 6, padTop + plotH);

    if (buf.length < 2) return;

    const latestTime = buf[buf.length - 1].time;
    const startTime = latestTime - scopeState.rangeSeconds;
    const timeToX = (t) => padLeft + Math.max(0, Math.min(plotW, ((t - startTime) / scopeState.rangeSeconds) * plotW));

    // 偏差ライン (緑色 #81c995)
    ctx.strokeStyle = "#81c995";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let started = false;
    for (const p of buf) {
      if (p.time < startTime) continue;
      const x = timeToX(p.time);
      const y = valToY(isAngle ? p.errorAngle : p.errorSpeed);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }

  // --- スコープのイベントリスナー ---
  if (selScopeModule) {
    selScopeModule.addEventListener("change", (e) => {
      scopeState.selectedModule = e.target.value;
    });
  }
  if (selScopeMotor) {
    selScopeMotor.addEventListener("change", (e) => {
      scopeState.selectedMotor = parseInt(e.target.value, 10) || 0;
    });
  }
  if (selScopeMetric) {
    selScopeMetric.addEventListener("change", (e) => {
      scopeState.selectedMetric = e.target.value;
    });
  }
  if (selScopeRange) {
    selScopeRange.addEventListener("change", (e) => {
      scopeState.rangeSeconds = parseInt(e.target.value, 10) || 5;
    });
  }
  if (btnScopePause) {
    btnScopePause.addEventListener("click", () => {
      scopeState.isPaused = !scopeState.isPaused;
      if (scopeState.isPaused) {
        btnScopePause.innerHTML = '<i class="fa-solid fa-play"></i> 再開';
        btnScopePause.className = "btn btn-success btn-sm";
      } else {
        btnScopePause.innerHTML = '<i class="fa-solid fa-pause"></i> 一時停止';
        btnScopePause.className = "btn btn-secondary btn-sm";
      }
    });
  }

  if (btnScopeExportCsv) {
    btnScopeExportCsv.addEventListener("click", () => {
      const key = `${scopeState.selectedModule}_${scopeState.selectedMotor}`;
      const buf = scopeState.buffers.get(key) || [];
      if (buf.length === 0) {
        alert("エクスポート可能な波形データがありません。");
        return;
      }

      const isAngle = scopeState.selectedMetric === "angle";
      let csv = "time,target,actual,error,sw1,sw2,sw3,sw4\n";
      for (const p of buf) {
        const t = isAngle ? p.targetAngle : p.targetSpeed;
        const a = isAngle ? p.angle : p.speed;
        const e = isAngle ? p.errorAngle : p.errorSpeed;
        const sw = p.limitSw || [false, false, false, false];
        csv += `${p.time.toFixed(4)},${t.toFixed(2)},${a.toFixed(2)},${e.toFixed(2)},${sw[0] ? 1 : 0},${sw[1] ? 1 : 0},${sw[2] ? 1 : 0},${sw[3] ? 1 : 0}\n`;
      }

      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `telemetry_${scopeState.selectedModule}_M${scopeState.selectedMotor + 1}_${Date.now()}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });
  }

  // 初期選択肢の構築
  updateScopeModuleSelect();

  // 描画ループ起動
  requestAnimationFrame(renderScopeCanvas);
});
