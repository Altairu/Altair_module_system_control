/**
 * Storage.js
 * LocalStorageを使った設定の保存・読み込み、JSONファイルへのエクスポート/インポート、テーマ管理
 */

const storage = {
    SAVE_KEY: 'altair_web_config',
    THEME_KEY: 'altair_web_theme',

    // -------------------------------------------------------
    // LocalStorage への保存・読み込み
    // -------------------------------------------------------

    saveConfig: function() {
        if (!window.altairState) return;

        // BlocklyのXMLを取得
        let blocklyXml = '';
        if (window.automation && window.automation.workspace) {
            const dom = Blockly.Xml.workspaceToDom(window.automation.workspace);
            blocklyXml = Blockly.utils.xml.domToText(dom);
        }

        const data = {
            modules: window.altairState.modules,
            blocklyXml: blocklyXml,
            gamepadMappings: window.altairState.gamepadMappings
        };

        localStorage.setItem(this.SAVE_KEY, JSON.stringify(data));
        ui.log("System", "Configuration saved to LocalStorage.", "success");
    },

    loadConfig: function() {
        const dataStr = localStorage.getItem(this.SAVE_KEY);
        if (!dataStr) return false;

        try {
            const data = JSON.parse(dataStr);
            if (data.modules && Array.isArray(data.modules)) {
                window.altairState.modules = data.modules.map(m => {
                    if (m.type === 'mdd' && m.state) {
                        m.state.paramSendRequested = false;
                        m.state.paramSetupCompleted = false;
                    }
                    return m;
                });

                // modulesById を再構築
                window.altairState.modulesById = {};
                window.altairState.modules.forEach(m => {
                    window.altairState.modulesById[m.id] = m;
                });

                // Blockly の復元は injection 後に行う
                if (data.blocklyXml) {
                    window.altairState._pendingBlocklyXml = data.blocklyXml;
                }

                if (data.gamepadMappings && Array.isArray(data.gamepadMappings)) {
                    window.altairState.gamepadMappings = data.gamepadMappings;
                } else {
                    window.altairState.gamepadMappings = [];
                }

                ui.log("System", `Loaded ${data.modules.length} modules from config.`, "info");
                return true;
            }
        } catch (e) {
            ui.log("System", "Failed to parse config from LocalStorage.", "danger");
            console.error(e);
        }
        return false;
    },

    clearConfig: function() {
        if(confirm("Are you sure you want to clear the saved configuration? This cannot be undone.")) {
            localStorage.removeItem(this.SAVE_KEY);
            window.altairState.modules = [];
            window.altairState.modulesById = {};
            window.altairState.gamepadMappings = [];
            if(window.automation && window.automation.workspace) {
                window.automation.workspace.clear();
            }
            ui.renderModules();
            if(window.gamepad) gamepad.renderMappings();
            ui.log("System", "Configuration cleared.", "info");
        }
    },

    // -------------------------------------------------------
    // JSONファイルへのエクスポート
    // -------------------------------------------------------

    exportConfig: function() {
        if (!window.altairState) return;

        // BlocklyのXMLを取得
        let blocklyXml = '';
        if (window.automation && window.automation.workspace) {
            const dom = Blockly.Xml.workspaceToDom(window.automation.workspace);
            blocklyXml = Blockly.utils.xml.domToText(dom);
        }

        const data = {
            _version: 1,
            _exportedAt: new Date().toISOString(),
            modules: window.altairState.modules,
            blocklyXml: blocklyXml,
            gamepadMappings: window.altairState.gamepadMappings
        };

        // ファイル名に日時を付与
        const now = new Date();
        const pad = n => String(n).padStart(2, '0');
        const dateStr = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`;
        const timeStr = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
        const fileName = `altair_config_${dateStr}_${timeStr}.json`;

        // Blob を生成してダウンロードリンクをクリック
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        ui.log("System", `Configuration exported as "${fileName}".`, "success");
    },

    // -------------------------------------------------------
    // JSONファイルからのインポート
    // -------------------------------------------------------

    importConfig: function() {
        // 隠しファイル入力をトリガー
        const fileInput = document.getElementById('import-config-input');
        if (fileInput) fileInput.click();
    },

    _handleImportFile: function(file) {
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = JSON.parse(e.target.result);

                // モジュールの復元
                if (data.modules && Array.isArray(data.modules)) {
                    window.altairState.modules = data.modules.map(m => {
                        if (m.type === 'mdd' && m.state) {
                            // パラメータ送信フラグはリセット
                            m.state.paramSendRequested = false;
                            m.state.paramSetupCompleted = false;
                        }
                        return m;
                    });
                    window.altairState.modulesById = {};
                    window.altairState.modules.forEach(m => {
                        window.altairState.modulesById[m.id] = m;
                    });
                }

                // Blockly XML の復元
                if (data.blocklyXml && window.automation && window.automation.workspace) {
                    try {
                        const dom = Blockly.utils.xml.textToDom(data.blocklyXml);
                        window.automation.workspace.clear();
                        Blockly.Xml.domToWorkspace(dom, window.automation.workspace);
                    } catch (blocklyErr) {
                        ui.log("System", "Blockly XML restore failed: " + blocklyErr.message, "warning");
                    }
                } else if (data.blocklyXml) {
                    window.altairState._pendingBlocklyXml = data.blocklyXml;
                }

                // Gamepadマッピングの復元
                if (data.gamepadMappings && Array.isArray(data.gamepadMappings)) {
                    window.altairState.gamepadMappings = data.gamepadMappings;
                } else {
                    window.altairState.gamepadMappings = [];
                }

                // UIを更新
                ui.renderModules();
                if (window.gamepad) gamepad.renderMappings();
                if (window.automation) window.automation.updateToolbox();

                // LocalStorage にも保存
                localStorage.setItem(this.SAVE_KEY, JSON.stringify({
                    modules: window.altairState.modules,
                    blocklyXml: data.blocklyXml || '',
                    gamepadMappings: window.altairState.gamepadMappings
                }));

                const exportedAt = data._exportedAt ? ` (exported: ${data._exportedAt})` : '';
                ui.log("System", `Configuration imported from "${file.name}"${exportedAt}.`, "success");

            } catch (parseErr) {
                ui.log("System", `Failed to import: ${parseErr.message}`, "danger");
                console.error(parseErr);
            }
        };
        reader.readAsText(file);
    },

    // -------------------------------------------------------
    // テーマ管理
    // -------------------------------------------------------

    saveTheme: function(theme) {
        localStorage.setItem(this.THEME_KEY, theme);
    },

    loadTheme: function() {
        const theme = localStorage.getItem(this.THEME_KEY) || 'dark';
        this.applyTheme(theme, false);
        return theme;
    },

    applyTheme: function(theme, save = true) {
        const root = document.documentElement;
        const btn = document.getElementById('btn-theme-toggle');

        if (theme === 'light') {
            root.classList.add('light-theme');
            if (btn) {
                btn.innerHTML = '<i class="fa-solid fa-moon"></i>';
                btn.title = 'ダークテーマに切り替え';
            }
        } else {
            root.classList.remove('light-theme');
            if (btn) {
                btn.innerHTML = '<i class="fa-solid fa-sun"></i>';
                btn.title = 'ライトテーマに切り替え';
            }
        }

        if (save) this.saveTheme(theme);
    },

    toggleTheme: function() {
        const isLight = document.documentElement.classList.contains('light-theme');
        const newTheme = isLight ? 'dark' : 'light';
        this.applyTheme(newTheme, true);
        ui.log("System", `Theme switched to ${newTheme}.`, "info");
    }
};
