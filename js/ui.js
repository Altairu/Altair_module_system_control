/**
 * ui.js
 * DOM操作、動的要素の生成
 */

const ui = {
    init: function() {
        // Navigation setup
        document.querySelectorAll('.nav-item').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const targetId = e.currentTarget.getAttribute('data-target');
                this.switchView(targetId);
            });
        });

        // Connection button
        document.getElementById('btn-connect').addEventListener('click', async () => {
            const bitrate = document.getElementById('can-bitrate').value;
            await canSerial.connect(bitrate);
        });

        document.getElementById('btn-disconnect').addEventListener('click', async () => {
            await canSerial.disconnect();
        });

        // Auto Trigger Engine Toggle
        document.getElementById('toggle-trigger-engine').addEventListener('change', (e) => {
            window.altairState.autoTriggerEngine = e.target.checked;
            this.log("System", `Auto Trigger Engine is now ${e.target.checked ? 'ON' : 'OFF'}`);
        });

        // Blockly Run Macro button
        document.getElementById('btn-run-macro').addEventListener('click', () => {
            if(window.automation) window.automation.runMacro();
        });
    },

    switchView: function(viewId) {
        document.querySelectorAll('.view-section').forEach(sec => sec.classList.remove('active'));
        document.querySelectorAll('.nav-item').forEach(btn => btn.classList.remove('active'));
        
        document.getElementById(viewId).classList.add('active');
        document.querySelector(`.nav-item[data-target="${viewId}"]`).classList.add('active');

        // Blockly resize hack
        if(viewId === 'view-automation' && window.automation && window.automation.workspace) {
            setTimeout(() => { Blockly.svgResize(window.automation.workspace); }, 50);
        }
    },

    log: function(source, message, type="info") {
        const out = document.getElementById('log-output');
        const now = new Date();
        const timeStr = now.toTimeString().split(' ')[0] + '.' + String(now.getMilliseconds()).padStart(3, '0');
        
        let color = '#a7f3d0'; // default info
        if(type === 'danger') color = '#fca5a5';
        if(type === 'warning') color = '#fde047';
        if(type === 'success') color = '#86efac';

        const span = document.createElement('span');
        span.style.color = color;
        span.innerText = `[${timeStr}] [${source}] ${message}\n`;
        out.appendChild(span);
        out.scrollTop = out.scrollHeight;
    },

    setConnectionStatus: function(connected) {
        const ind = document.getElementById('connection-status');
        const btnCon = document.getElementById('btn-connect');
        const btnDis = document.getElementById('btn-disconnect');
        const select = document.getElementById('can-bitrate');

        if(connected) {
            ind.classList.remove('offline');
            ind.classList.add('online');
            ind.innerText = 'Online';
            btnCon.disabled = true;
            btnDis.disabled = false;
            select.disabled = true;
        } else {
            ind.classList.remove('online');
            ind.classList.add('offline');
            ind.innerText = 'Offline';
            btnCon.disabled = false;
            btnDis.disabled = true;
            select.disabled = false;
        }
    },

    // --- Modal ---
    showAddModuleModal: function() {
        document.getElementById('add-module-modal').classList.remove('hidden');
    },

    hideAddModuleModal: function() {
        document.getElementById('add-module-modal').classList.add('hidden');
    },

    confirmAddModule: function() {
        const type = document.getElementById('modal-module-type').value;
        const name = document.getElementById('modal-module-name').value || (type.toUpperCase() + '_' + (window.altairState.modules.length+1));
        const baseIdStr = document.getElementById('modal-module-id').value;
        const baseId = parseInt(baseIdStr, 16) || (type==='mdd'?0x200 : type==='servo'?0x100 : 0x300);

        const newMod = this.createModuleData(type, name, baseId);
        window.altairState.modules.push(newMod);
        
        this.renderModules();
        this.hideAddModuleModal();
        this.log("System", `Added ${type.toUpperCase()} module [${name}] at BaseID: 0x${baseId.toString(16).toUpperCase()}`);
        
        // Save config automatically
        storage.saveConfig();
        
        // Reload Blockly toolboxes if needed
        if(window.automation) window.automation.updateToolbox();
    },

    createModuleData: function(type, name, baseId) {
        let m = {
            id: 'mod_' + Date.now().toString() + '_' + Math.floor(Math.random()*1000),
            type: type,
            name: name,
            baseId: baseId,
            txEnabled: false,
        };

        if(type === 'mdd') {
            m.motors = [
                {target:0, mode:0, p:80, i:0, d:2, wheel:65, dir:1},
                {target:0, mode:0, p:80, i:0, d:2, wheel:65, dir:1},
                {target:0, mode:0, p:80, i:0, d:2, wheel:65, dir:1},
                {target:0, mode:0, p:80, i:0, d:2, wheel:65, dir:1}
            ];
            m.state = { appMode: 0, paramSendRequested: false, sw: [0,0,0,0], err: 0, lastUpdate: 0 };
        } else if(type === 'servo') {
            m.ch = [90,90,90,90,90,90];
        } else if(type === 'solenoid') {
            m.valves = 0; // bitfield 12 bits
        }
        return m;
    },

    deleteModule: function(id) {
        if(!confirm("Delete this module?")) return;
        window.altairState.modules = window.altairState.modules.filter(m => m.id !== id);
        this.renderModules();
        storage.saveConfig();
        if(window.automation) window.automation.updateToolbox();
    },

    // --- Render ---
    renderModules: function() {
        const list = document.getElementById('module-list');
        const dash = document.getElementById('dashboard-container');
        list.innerHTML = '';
        dash.innerHTML = '';

        if(window.altairState.modules.length === 0) {
            dash.innerHTML = `
                <div class="empty-state">
                    <i class="fa-solid fa-cubes"></i>
                    <p>No modules added yet. Add a module from the sidebar.</p>
                </div>`;
            return;
        }

        window.altairState.modules.forEach(m => {
            // Sidebar item
            const li = document.createElement('div');
            li.className = 'module-item';
            li.innerHTML = `
                <div class="module-item-info">
                    <span class="m-name">${m.name}</span>
                    <span class="m-id">${m.type.toUpperCase()} / 0x${m.baseId.toString(16).toUpperCase()}</span>
                </div>
                <div class="module-item-del" onclick="ui.deleteModule('${m.id}')"><i class="fa-solid fa-xmark"></i></div>
            `;
            list.appendChild(li);

            // Dashboard card
            const card = document.createElement('div');
            card.className = 'module-card glass-panel';
            card.id = `card-${m.id}`;
            
            let contentHtml = '';
            if(m.type === 'mdd') contentHtml = this.getMddHtml(m);
            else if(m.type === 'servo') contentHtml = this.getServoHtml(m);
            else if(m.type === 'solenoid') contentHtml = this.getSolenoidHtml(m);

            card.innerHTML = `
                <div class="card-header">
                    <h3>${m.name}</h3>
                    <span class="badge">0x${m.baseId.toString(16).toUpperCase()}</span>
                </div>
                <div class="card-body">
                    ${contentHtml}
                </div>
                <div class="card-footer" style="margin-top:15px; border-top:1px solid var(--border-color); padding-top:10px;">
                    <label style="display:flex; align-items:center; gap:10px; cursor:pointer;">
                        <input type="checkbox" onchange="ui.toggleTx('${m.id}', this.checked)" ${m.txEnabled ? 'checked' : ''}>
                        <span style="font-weight:600; font-size:0.9rem;">Enable TX</span>
                    </label>
                </div>
            `;
            dash.appendChild(card);
        });
    },

    getMddHtml: function(m) {
        let html = `
            <div style="display:flex; justify-content:space-between; margin-bottom:10px; font-size:0.85rem;">
                <div id="mdd-status-${m.id}" style="color:${m.state.appMode===1 ? 'var(--success-color)' : 'var(--text-secondary)'}; font-weight:bold;">
                    ${m.state.appMode===1 ? 'CONTROL MODE' : 'PARAM MODE'}
                </div>
                <div id="mdd-sw-${m.id}">SW: [${m.state.sw.join(',')}] Err: ${m.state.err}</div>
            </div>
            <button class="btn btn-secondary" style="margin-bottom:15px; width:100%;" onclick="ui.reqMddParams('${m.id}')">Send Parameters</button>
            <div style="display:flex; flex-direction:column; gap:8px;">
        `;
        for(let i=0; i<4; i++) {
            html += `
                <div class="control-row">
                    <label>M${i+1}</label>
                    <div class="slider-container">
                        <input type="range" min="-32767" max="32767" value="${m.motors[i].target}" 
                            oninput="ui.updateMddTarget('${m.id}', ${i}, this.value)" 
                            onchange="ui.updateMddTarget('${m.id}', ${i}, this.value)">
                        <span class="val-display" id="mdd-val-${m.id}-${i}">${m.motors[i].target}</span>
                    </div>
                </div>
            `;
        }
        html += `</div>`;
        return html;
    },

    getServoHtml: function(m) {
        let html = `<div style="display:flex; flex-direction:column; gap:8px;">`;
        for(let i=0; i<6; i++) {
            html += `
                <div class="control-row">
                    <label>CH${i+1}</label>
                    <div class="slider-container">
                        <input type="range" min="0" max="180" value="${m.ch[i]}" 
                            oninput="ui.updateServoTarget('${m.id}', ${i}, this.value)" 
                            onchange="ui.updateServoTarget('${m.id}', ${i}, this.value)">
                        <span class="val-display" id="servo-val-${m.id}-${i}">${m.ch[i]}</span>
                    </div>
                </div>
            `;
        }
        html += `</div>`;
        return html;
    },

    getSolenoidHtml: function(m) {
        let html = `<div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:10px;">`;
        for(let i=0; i<12; i++) {
            const isChecked = (m.valves & (1<<i)) ? 'checked' : '';
            html += `
                <label style="display:flex; flex-direction:column; align-items:center; gap:5px; font-size:0.8rem;">
                    <span>V${i+1}</span>
                    <input type="checkbox" onchange="ui.updateSolenoidValve('${m.id}', ${i}, this.checked)" ${isChecked}>
                </label>
            `;
        }
        html += `</div>`;
        return html;
    },

    // --- Control Handlers ---
    toggleTx: function(id, enabled) {
        const m = window.altairState.modules.find(x => x.id === id);
        if(m) {
            m.txEnabled = enabled;
            this.log("System", `TX ${enabled ? 'Enabled' : 'Disabled'} for ${m.name}`);
        }
    },

    reqMddParams: function(id) {
        const m = window.altairState.modules.find(x => x.id === id);
        if(m) {
            m.state.paramSendRequested = true;
            this.log("System", `Requested Param Send for MDD ${m.name}`);
        }
    },

    updateMddTarget: function(id, motorIdx, val) {
        const m = window.altairState.modules.find(x => x.id === id);
        if(m) {
            m.motors[motorIdx].target = parseInt(val);
            document.getElementById(`mdd-val-${id}-${motorIdx}`).innerText = val;
        }
    },

    updateServoTarget: function(id, chIdx, val) {
        const m = window.altairState.modules.find(x => x.id === id);
        if(m) {
            m.ch[chIdx] = parseInt(val);
            document.getElementById(`servo-val-${id}-${chIdx}`).innerText = val;
        }
    },

    updateSolenoidValve: function(id, valveIdx, checked) {
        const m = window.altairState.modules.find(x => x.id === id);
        if(m) {
            if(checked) m.valves |= (1 << valveIdx);
            else m.valves &= ~(1 << valveIdx);
        }
    },

    updateModuleUI: function(m) {
        if(m.type === 'mdd') {
            const st = document.getElementById(`mdd-status-${m.id}`);
            const sw = document.getElementById(`mdd-sw-${m.id}`);
            if(st && sw) {
                if(m.state.appMode === 1) {
                    st.innerText = 'CONTROL MODE';
                    st.style.color = 'var(--success-color)';
                } else {
                    st.innerText = 'PARAM MODE';
                    st.style.color = 'var(--text-secondary)';
                }
                sw.innerText = `SW: [${m.state.sw.join(',')}] Err: ${m.state.err}`;
            }
        }
    }
};
