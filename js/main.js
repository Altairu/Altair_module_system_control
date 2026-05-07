/**
 * main.js
 * エントリポイント、状態の初期化
 */

window.altairState = {
    modules: [],
    modulesById: {},
    autoTriggerEngine: false,
    _pendingBlocklyXml: null,
    gamepadMappings: []
};

window.addEventListener('DOMContentLoaded', () => {
    // 1. Storageロード
    storage.loadConfig();

    // 2. UI初期化
    ui.init();
    ui.renderModules();
    ui.log("System", "Altair Web Controller Initialized.", "info");

    // 3. CAN初期化確認
    canSerial.init();

    // 4. Blockly初期化
    automation.init();

    // 5. Gamepad初期化
    if (window.gamepad) {
        gamepad.init();
    }
    
    // 6. Serial Controller 初期化
    if (window.controllerSerial) {
        controllerSerial.init();
    }
});
