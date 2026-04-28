/**
 * gamepad.js
 * ゲームコントローラー入力とモジュール制御のマッピング
 */

const gamepad = {
    loopId: null,
    gamepadIndex: null,
    prevButtons: [],
    prevAxes: [],
    axisThreshold: 0.5,

    init: function() {
        window.addEventListener("gamepadconnected", (e) => {
            ui.log("Gamepad", `Connected: ${e.gamepad.id}`, "info");
            this.gamepadIndex = e.gamepad.index;
            this.updateStatus(true, e.gamepad.id);
            if (!this.loopId) {
                this.loopId = requestAnimationFrame(this.poll.bind(this));
            }
        });

        window.addEventListener("gamepaddisconnected", (e) => {
            ui.log("Gamepad", `Disconnected: ${e.gamepad.id}`, "warning");
            if (this.gamepadIndex === e.gamepad.index) {
                this.gamepadIndex = null;
                this.updateStatus(false, "");
                if (this.loopId) {
                    cancelAnimationFrame(this.loopId);
                    this.loopId = null;
                }
            }
        });

        // Initialize UI
        this.renderMappings();
    },

    updateStatus: function(connected, name) {
        const statusEl = document.getElementById('gamepad-status');
        if (!statusEl) return;
        if (connected) {
            statusEl.className = 'status-indicator online';
            statusEl.innerText = `Connected: ${name}`;
        } else {
            statusEl.className = 'status-indicator offline';
            statusEl.innerText = 'Press any button on controller';
            document.getElementById('gamepad-test-output').innerText = 'Waiting for input...';
        }
    },

    poll: function() {
        if (this.gamepadIndex === null) return;
        const pad = navigator.getGamepads()[this.gamepadIndex];
        if (!pad) {
            this.loopId = requestAnimationFrame(this.poll.bind(this));
            return;
        }

        let testStr = "";
        
        // Buttons
        for (let i = 0; i < pad.buttons.length; i++) {
            const isPressed = pad.buttons[i].pressed;
            const wasPressed = this.prevButtons[i] || false;
            
            if (isPressed) {
                testStr += `Button ${i} PRESSED\n`;
            }

            if (isPressed !== wasPressed) {
                this.handleInputEvent('button', i, isPressed, pad.buttons[i].value);
            }
            this.prevButtons[i] = isPressed;
        }

        // Axes
        for (let i = 0; i < pad.axes.length; i++) {
            const val = pad.axes[i];
            const prevVal = this.prevAxes[i] || 0;
            
            if (Math.abs(val) > 0.1) {
                testStr += `Axis ${i}: ${val.toFixed(2)}\n`;
            }

            // Positive direction check
            const isPos = val > this.axisThreshold;
            const wasPos = prevVal > this.axisThreshold;
            if (isPos !== wasPos) {
                this.handleInputEvent('axis', i, isPos, val, 1);
            }

            // Negative direction check
            const isNeg = val < -this.axisThreshold;
            const wasNeg = prevVal < -this.axisThreshold;
            if (isNeg !== wasNeg) {
                this.handleInputEvent('axis', i, isNeg, val, -1);
            }

            this.prevAxes[i] = val;
        }

        const testEl = document.getElementById('gamepad-test-output');
        if (testEl) {
            testEl.innerText = testStr || 'Waiting for input...';
        }

        this.loopId = requestAnimationFrame(this.poll.bind(this));
    },

    handleInputEvent: function(inputType, inputIndex, isPressed, rawValue, axisDir = 1) {
        if (!window.altairState.gamepadMappings) return;

        window.altairState.gamepadMappings.forEach(map => {
            if (map.inputType === inputType && map.inputIndex === inputIndex) {
                if (inputType === 'axis' && map.axisDir !== axisDir) {
                    return; // Ignore if axis direction doesn't match
                }

                this.executeAction(map, isPressed, rawValue);
            }
        });
    },

    executeAction: function(map, isPressed, rawValue) {
        const mod = window.altairState.modules.find(m => m.id === map.moduleId);
        if (!mod) return;

        // 電磁弁 トグル (押した瞬間のみ)
        if (map.action === 'solenoid_toggle' && isPressed) {
            ui.toggleSolenoidValve(mod.id, map.valveIdx);
        }
        // 電磁弁 モメンタリ (押してる間ON、離すとOFF)
        else if (map.action === 'solenoid_momentary') {
            ui.updateSolenoidValve(mod.id, map.valveIdx, isPressed);
        }
        // 目標値 トグル (押した瞬間のみ)
        else if (map.action === 'target_toggle' && isPressed) {
            let current = this.getCurrentTarget(mod, map);
            // 値が0ならparamValへ、そうでなければ0へ
            let nextVal = (current === 0) ? map.paramVal : 0;
            this.setTarget(mod, map, nextVal);
        }
        // 目標値 モメンタリ (押してる間paramVal、離すと0)
        else if (map.action === 'target_momentary') {
            let nextVal = isPressed ? map.paramVal : 0;
            this.setTarget(mod, map, nextVal);
        }
        // 目標値 加算 (押した瞬間のみ)
        else if (map.action === 'target_add' && isPressed) {
            let current = this.getCurrentTarget(mod, map);
            this.setTarget(mod, map, current + map.paramVal);
        }
        // 目標値 減算 (押した瞬間のみ)
        else if (map.action === 'target_sub' && isPressed) {
            let current = this.getCurrentTarget(mod, map);
            this.setTarget(mod, map, current - map.paramVal);
        }
    },

    getCurrentTarget: function(mod, map) {
        if (mod.type === 'mdd') {
            return mod.motors[map.motorIdx].target;
        } else if (mod.type === 'servo') {
            return mod.ch[map.chIdx];
        }
        return 0;
    },

    setTarget: function(mod, map, val) {
        if (mod.type === 'mdd') {
            ui.updateMddTarget(mod.id, map.motorIdx, val);
        } else if (mod.type === 'servo') {
            ui.updateServoTarget(mod.id, map.chIdx, val);
        }
        storage.saveConfig();
    },

    // --- UI Methods ---
    showAddMappingModal: function() {
        const modSelect = document.getElementById('modal-map-module');
        modSelect.innerHTML = '';
        if (window.altairState.modules.length === 0) {
            alert("Please add a module first.");
            return;
        }

        window.altairState.modules.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.id;
            opt.innerText = `${m.name} (${m.type.toUpperCase()})`;
            modSelect.appendChild(opt);
        });

        this.updateModalOptions();
        document.getElementById('add-mapping-modal').classList.remove('hidden');
    },

    hideAddMappingModal: function() {
        document.getElementById('add-mapping-modal').classList.add('hidden');
    },

    updateModalOptions: function() {
        const inputType = document.getElementById('modal-map-input-type').value;
        const modId = document.getElementById('modal-map-module').value;
        
        document.getElementById('axis-dir-group').style.display = (inputType === 'axis') ? 'block' : 'none';

        const mod = window.altairState.modules.find(m => m.id === modId);
        if (!mod) return;

        const actionSelect = document.getElementById('modal-map-action');
        const currentAction = actionSelect.value;
        actionSelect.innerHTML = '';

        if (mod.type === 'solenoid') {
            actionSelect.innerHTML += `<option value="solenoid_toggle">Valve Toggle (ON/OFF)</option>`;
            actionSelect.innerHTML += `<option value="solenoid_momentary">Valve Momentary (While Pressed)</option>`;
        } else if (mod.type === 'mdd' || mod.type === 'servo') {
            actionSelect.innerHTML += `<option value="target_toggle">Target Toggle (0 <-> Val)</option>`;
            actionSelect.innerHTML += `<option value="target_momentary">Target Momentary (While Pressed)</option>`;
            actionSelect.innerHTML += `<option value="target_add">Target Add (+Val)</option>`;
            actionSelect.innerHTML += `<option value="target_sub">Target Subtract (-Val)</option>`;
        }

        // Restore action selection if it still exists
        if (Array.from(actionSelect.options).some(o => o.value === currentAction)) {
            actionSelect.value = currentAction;
        }

        this.updateParamOptions(mod);
    },

    updateParamOptions: function(mod) {
        const paramGroup = document.getElementById('modal-map-param-group');
        const action = document.getElementById('modal-map-action').value;
        paramGroup.innerHTML = '';

        if (mod.type === 'solenoid') {
            let html = `<label>Target Valve (1-12)</label><select id="modal-map-param-ch">`;
            for (let i = 0; i < 12; i++) html += `<option value="${i}">Valve ${i+1}</option>`;
            html += `</select>`;
            paramGroup.innerHTML = html;
        } 
        else if (mod.type === 'mdd') {
            let html = `<label>Target Motor (M1-M4)</label><select id="modal-map-param-ch">`;
            for (let i = 0; i < 4; i++) html += `<option value="${i}">Motor ${i+1}</option>`;
            html += `</select>`;
            
            if (action !== 'solenoid_toggle' && action !== 'solenoid_momentary') {
                html += `<label style="margin-top:10px;">Value (Toggle Val / Step Val)</label>
                         <input type="number" id="modal-map-param-val" value="100">`;
            }
            paramGroup.innerHTML = html;
        }
        else if (mod.type === 'servo') {
            let html = `<label>Target Channel (CH1-CH6)</label><select id="modal-map-param-ch">`;
            for (let i = 0; i < 6; i++) html += `<option value="${i}">Channel ${i+1}</option>`;
            html += `</select>`;

            if (action !== 'solenoid_toggle' && action !== 'solenoid_momentary') {
                html += `<label style="margin-top:10px;">Value (Toggle Val / Step Val)</label>
                         <input type="number" id="modal-map-param-val" value="90">`;
            }
            paramGroup.innerHTML = html;
        }
    },

    confirmAddMapping: function() {
        const inputType = document.getElementById('modal-map-input-type').value;
        const inputIndex = parseInt(document.getElementById('modal-map-input-index').value);
        const axisDir = parseInt(document.getElementById('modal-map-axis-dir').value);
        const modId = document.getElementById('modal-map-module').value;
        const action = document.getElementById('modal-map-action').value;
        
        const chSelect = document.getElementById('modal-map-param-ch');
        const valInput = document.getElementById('modal-map-param-val');

        const map = {
            id: 'map_' + Date.now(),
            inputType: inputType,
            inputIndex: inputIndex,
            axisDir: axisDir,
            moduleId: modId,
            action: action,
            valveIdx: chSelect ? parseInt(chSelect.value) : 0,
            motorIdx: chSelect ? parseInt(chSelect.value) : 0,
            chIdx: chSelect ? parseInt(chSelect.value) : 0,
            paramVal: valInput ? parseFloat(valInput.value) : 0
        };

        if (!window.altairState.gamepadMappings) {
            window.altairState.gamepadMappings = [];
        }
        window.altairState.gamepadMappings.push(map);
        
        this.renderMappings();
        this.hideAddMappingModal();
        storage.saveConfig();
        ui.log("Gamepad", `Mapping added: ${inputType} ${inputIndex} -> ${action}`, "success");
    },

    deleteMapping: function(id) {
        window.altairState.gamepadMappings = window.altairState.gamepadMappings.filter(m => m.id !== id);
        this.renderMappings();
        storage.saveConfig();
        ui.log("Gamepad", "Mapping deleted.", "info");
    },

    renderMappings: function() {
        const list = document.getElementById('mapping-list');
        if (!list) return;
        list.innerHTML = '';

        if (!window.altairState.gamepadMappings || window.altairState.gamepadMappings.length === 0) {
            list.innerHTML = `
                <div class="empty-state">
                    <i class="fa-solid fa-link-slash"></i>
                    <p>No mappings defined yet.</p>
                </div>`;
            return;
        }

        window.altairState.gamepadMappings.forEach(map => {
            const mod = window.altairState.modules.find(m => m.id === map.moduleId);
            const modName = mod ? mod.name : 'Deleted Module';

            let inputStr = `${map.inputType === 'button' ? 'BTN' : 'AXIS'} ${map.inputIndex}`;
            if (map.inputType === 'axis') {
                inputStr += map.axisDir > 0 ? ' (+)' : ' (-)';
            }

            let descStr = map.action;
            if (map.action.startsWith('solenoid')) {
                descStr = `${map.action.includes('toggle') ? 'Toggle' : 'Momentary'} V${map.valveIdx + 1}`;
            } else if (map.action.startsWith('target')) {
                let tgt = mod?.type === 'mdd' ? `M${map.motorIdx + 1}` : `CH${map.chIdx + 1}`;
                descStr = `${map.action.split('_')[1].toUpperCase()} ${tgt} (Val: ${map.paramVal})`;
            }

            const item = document.createElement('div');
            item.className = 'mapping-item';
            item.innerHTML = `
                <div class="mapping-info">
                    <div style="display:flex; align-items:center;">
                        <span class="map-input-badge">${inputStr}</span>
                        <span class="map-action-desc">${descStr}</span>
                    </div>
                    <span class="map-module-desc"><i class="fa-solid fa-microchip"></i> ${modName}</span>
                </div>
                <div class="mapping-delete" onclick="gamepad.deleteMapping('${map.id}')">
                    <i class="fa-solid fa-trash-can"></i>
                </div>
            `;
            list.appendChild(item);
        });
    }
};
