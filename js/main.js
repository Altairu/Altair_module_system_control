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
    // 1. テーマを復元（CSSフラッシュを防ぐため最初に実行）
    storage.loadTheme();

    // 2. Storageからコンフィグをロード
    storage.loadConfig();

    // 3. UI初期化
    ui.init();
    ui.renderModules();
    ui.log("System", "Altair Web Controller Initialized.", "info");

    // 4. CAN初期化確認
    canSerial.init();

    // 5. Blockly初期化
    automation.init();

    // 6. Gamepad初期化
    if (window.gamepad) {
        gamepad.init();
    }

    // 7. Serial Controller 初期化
    if (window.controllerSerial) {
        controllerSerial.init();
    }
});
