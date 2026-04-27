/**
 * automation.js
 * Blocklyを利用したブロック制御（マクロ・トリガー）
 */

const automation = {
    workspace: null,

    init: function() {
        this.defineCustomBlocks();
        this.workspace = Blockly.inject('blockly-container', {
            toolbox: this.getToolboxXml(),
            theme: Blockly.Themes.Dark,
            grid: {spacing: 20, length: 3, colour: '#ccc', snap: true},
            zoom: {controls: true, wheel: true}
        });

        // Load pending xml if any
        if(window.altairState._pendingBlocklyXml) {
            try {
                const dom = Blockly.Xml.textToDom(window.altairState._pendingBlocklyXml);
                Blockly.Xml.domToWorkspace(dom, this.workspace);
            } catch(e) { console.error("Failed to load blockly xml", e); }
            delete window.altairState._pendingBlocklyXml;
        }

        // Auto save on change
        this.workspace.addChangeListener(() => {
            // throttle save to avoid excessive storage writes
            if(this.saveTimer) clearTimeout(this.saveTimer);
            this.saveTimer = setTimeout(() => { storage.saveConfig(); }, 1000);
        });
    },

    updateToolbox: function() {
        if(this.workspace) {
            this.workspace.updateToolbox(this.getToolboxXml());
        }
    },

    getToolboxXml: function() {
        return `
        <xml xmlns="https://developers.google.com/blockly/xml" id="toolbox" style="display: none">
            <category name="イベント" colour="#f59e0b">
                <block type="event_macro"></block>
                <block type="event_trigger"></block>
            </category>
            <category name="条件 (トリガー)" colour="#8b5cf6">
                <block type="trigger_mdd_sw"></block>
            </category>
            <category name="アクション" colour="#ef4444">
                <block type="action_mdd"></block>
                <block type="action_servo"></block>
                <block type="action_solenoid"></block>
                <block type="action_delay"></block>
            </category>
            <category name="論理・数値" colour="#334155">
                <block type="controls_if"></block>
                <block type="logic_compare"></block>
                <block type="math_number"></block>
            </category>
        </xml>
        `;
    },

    defineCustomBlocks: function() {
        // Event: Macro (Click run button)
        Blockly.Blocks['event_macro'] = {
            init: function() {
                this.appendDummyInput().appendField("マクロ実行時");
                this.appendStatementInput("DO").setCheck(null);
                this.setColour('#f59e0b');
                this.setTooltip("「マクロを実行」ボタンを押した時に実行されます");
            }
        };

        // Event: Trigger Loop
        Blockly.Blocks['event_trigger'] = {
            init: function() {
                this.appendDummyInput().appendField("トリガーエンジンON時 (常時ループ)");
                this.appendStatementInput("DO").setCheck(null);
                this.setColour('#f59e0b');
                this.setTooltip("オートトリガーエンジンがONのとき、常に繰り返し実行されます");
            }
        };

        const getModuleOptionsDropdown = function(type) {
            return function() {
                const mods = window.altairState.modules.filter(m => m.type === type);
                if(mods.length === 0) return [["モジュールなし", "none"]];
                return mods.map(m => [m.name, m.id]);
            };
        };

        // Action: MDD
        Blockly.Blocks['action_mdd'] = {
            init: function() {
                this.appendDummyInput()
                    .appendField("MDDを設定:")
                    .appendField(new Blockly.FieldDropdown(getModuleOptionsDropdown('mdd')), "MODULE");
                this.appendValueInput("MOTOR_IDX").setCheck("Number").appendField("モータ番号(0-3)");
                this.appendValueInput("TARGET").setCheck("Number").appendField("目標値");
                this.setPreviousStatement(true, null);
                this.setNextStatement(true, null);
                this.setColour('#ef4444');
            }
        };

        // Action: Servo
        Blockly.Blocks['action_servo'] = {
            init: function() {
                this.appendDummyInput()
                    .appendField("サーボを設定:")
                    .appendField(new Blockly.FieldDropdown(getModuleOptionsDropdown('servo')), "MODULE");
                this.appendValueInput("CH_IDX").setCheck("Number").appendField("CH番号(0-5)");
                this.appendValueInput("ANGLE").setCheck("Number").appendField("角度(0-180)");
                this.setPreviousStatement(true, null);
                this.setNextStatement(true, null);
                this.setColour('#10b981');
            }
        };

        // Action: Solenoid
        Blockly.Blocks['action_solenoid'] = {
            init: function() {
                this.appendDummyInput()
                    .appendField("電磁弁を設定:")
                    .appendField(new Blockly.FieldDropdown(getModuleOptionsDropdown('solenoid')), "MODULE");
                this.appendValueInput("VALVE_IDX").setCheck("Number").appendField("バルブ番号(0-11)");
                this.appendDummyInput()
                    .appendField("状態")
                    .appendField(new Blockly.FieldDropdown([["ON", "1"], ["OFF", "0"]]), "STATE");
                this.setPreviousStatement(true, null);
                this.setNextStatement(true, null);
                this.setColour('#3b82f6');
            }
        };

        // Action: Delay
        Blockly.Blocks['action_delay'] = {
            init: function() {
                this.appendValueInput("DELAY_MS").setCheck("Number").appendField("待機する (ミリ秒):");
                this.setPreviousStatement(true, null);
                this.setNextStatement(true, null);
                this.setColour('#64748b');
                this.setTooltip("指定したミリ秒だけ次のアクションを待ちます");
            }
        };

        // Condition: MDD SW
        Blockly.Blocks['trigger_mdd_sw'] = {
            init: function() {
                this.appendDummyInput()
                    .appendField("MDD:")
                    .appendField(new Blockly.FieldDropdown(getModuleOptionsDropdown('mdd')), "MODULE")
                    .appendField("の SW")
                    .appendField(new Blockly.FieldDropdown([["1", "0"], ["2", "1"], ["3", "2"], ["4", "3"]]), "SW_IDX")
                    .appendField("が ON である");
                this.setOutput(true, "Boolean");
                this.setColour('#8b5cf6');
            }
        };

        // Generate JavaScript for custom blocks
        javascript.javascriptGenerator.forBlock['event_macro'] = function(block, generator) {
            var branch = generator.statementToCode(block, 'DO');
            return `async function __macro() {\n${branch}}\n__macro();\n`;
        };

        javascript.javascriptGenerator.forBlock['event_trigger'] = function(block, generator) {
            var branch = generator.statementToCode(block, 'DO');
            return `async function __trigger() {\n${branch}}\n__trigger();\n`;
        };

        javascript.javascriptGenerator.forBlock['action_mdd'] = function(block, generator) {
            var root = block.getRootBlock();
            if (root.type !== 'event_macro' && root.type !== 'event_trigger') return '';
            var mod = block.getFieldValue('MODULE');
            var idx = generator.valueToCode(block, 'MOTOR_IDX', javascript.Order.ATOMIC) || 0;
            var target = generator.valueToCode(block, 'TARGET', javascript.Order.ATOMIC) || 0;
            return `window.altairControlAPI.setMddTarget('${mod}', ${idx}, ${target});\n`;
        };

        javascript.javascriptGenerator.forBlock['action_servo'] = function(block, generator) {
            var root = block.getRootBlock();
            if (root.type !== 'event_macro' && root.type !== 'event_trigger') return '';
            var mod = block.getFieldValue('MODULE');
            var idx = generator.valueToCode(block, 'CH_IDX', javascript.Order.ATOMIC) || 0;
            var angle = generator.valueToCode(block, 'ANGLE', javascript.Order.ATOMIC) || 90;
            return `window.altairControlAPI.setServoTarget('${mod}', ${idx}, ${angle});\n`;
        };

        javascript.javascriptGenerator.forBlock['action_solenoid'] = function(block, generator) {
            var root = block.getRootBlock();
            if (root.type !== 'event_macro' && root.type !== 'event_trigger') return '';
            var mod = block.getFieldValue('MODULE');
            var idx = generator.valueToCode(block, 'VALVE_IDX', javascript.Order.ATOMIC) || 0;
            var state = block.getFieldValue('STATE');
            return `window.altairControlAPI.setSolenoidValve('${mod}', ${idx}, ${state === '1'});\n`;
        };

        javascript.javascriptGenerator.forBlock['action_delay'] = function(block, generator) {
            var root = block.getRootBlock();
            if (root.type !== 'event_macro' && root.type !== 'event_trigger') return '';
            var ms = generator.valueToCode(block, 'DELAY_MS', javascript.Order.ATOMIC) || 1000;
            return `await window.altairControlAPI.sleep(${ms});\n`;
        };

        javascript.javascriptGenerator.forBlock['trigger_mdd_sw'] = function(block, generator) {
            var mod = block.getFieldValue('MODULE');
            var swIdx = block.getFieldValue('SW_IDX');
            var code = `window.altairControlAPI.getMddSw('${mod}', ${swIdx})`;
            return [code, javascript.Order.NONE];
        };
    },

    runMacro: function() {
        try {
            const code = javascript.javascriptGenerator.workspaceToCode(this.workspace);
            eval(`(async () => { ${code} })();`);
            ui.log("Automation", "Macro executed.", "success");
        } catch(e) {
            console.error(e);
            ui.log("Automation", "Error in Macro: " + e.message, "danger");
        }
    },

    evaluateTriggers: function() {
        if(!this.workspace) return;
        // prevent trigger overlap when using delays
        if(this.isRunningTrigger) return;
        
        try {
            this.isRunningTrigger = true;
            const code = javascript.javascriptGenerator.workspaceToCode(this.workspace);
            eval(`(async () => { ${code} window.automation.isRunningTrigger = false; })();`);
        } catch(e) {
            console.error(e);
            this.isRunningTrigger = false;
        }
    }
};

// API provided to EVAL environment
window.altairControlAPI = {
    sleep: function(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    },
    setMddTarget: function(id, idx, target) {
        if(id === 'none') return;
        ui.updateMddTarget(id, Math.floor(idx), target);
    },
    setServoTarget: function(id, idx, angle) {
        if(id === 'none') return;
        ui.updateServoTarget(id, Math.floor(idx), angle);
    },
    setSolenoidValve: function(id, idx, stateBool) {
        if(id === 'none') return;
        ui.updateSolenoidValve(id, Math.floor(idx), stateBool);
        // Refresh UI
        const cb = document.querySelector(`#card-${id} input[type="checkbox"][onchange*="updateSolenoidValve('${id}', ${Math.floor(idx)}"]`);
        if(cb) cb.checked = stateBool;
    },
    getMddSw: function(id, swIdx) {
        if(id === 'none') return false;
        const m = window.altairState.modules.find(x => x.id === id);
        if(m && m.type === 'mdd' && m.state && m.state.sw) {
            return m.state.sw[Math.floor(swIdx)] === 1;
        }
        return false;
    }
};
