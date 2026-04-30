/**
 * Storage.js
 * LocalStorageを使った設定の保存・読み込み
 */

const storage = {
    SAVE_KEY: 'altair_web_config',

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
                window.altairState.modules = data.modules;
                
                // restore blockly later after injection
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
        if(confirm("Are you sure you want to clear the saved configuration? This cannot be undone.")){
            localStorage.removeItem(this.SAVE_KEY);
            window.altairState.modules = [];
            window.altairState.gamepadMappings = [];
            if(window.automation && window.automation.workspace){
                window.automation.workspace.clear();
            }
            ui.renderModules();
            if(window.gamepad) gamepad.renderMappings();
            ui.log("System", "Configuration cleared.", "info");
        }
    }
};
