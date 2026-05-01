/**
 * can_serial.js
 * Web Serial API を用いた slcan 通信プロトコル実装
 */

const canSerial = {
    port: null,
    reader: null,
    writer: null,
    keepReading: true,
    txLoopTimer10: null,
    txLoopTimer100: null,

    // 送信バッファ (リアルタイム性が重要なため、キューではなくループ時に現在の状態を送信)
    
    init: function() {
        if (!("serial" in navigator)) {
            ui.log("CAN", "Web Serial API is not supported in this browser. Please use Chrome or Edge.", "danger");
            document.getElementById('btn-connect').disabled = true;
            return false;
        }
        return true;
    },

    connect: async function(bitrate) {
        try {
            // Request port
            this.port = await navigator.serial.requestPort();
            
            // Open port (slcan usually uses 115200, 3000000 etc. or baud is ignored by some USB CDC)
            await this.port.open({ baudRate: 115200 });
            
            // Setup streams
            const textEncoder = new TextEncoderStream();
            const writableStreamClosed = textEncoder.readable.pipeTo(this.port.writable);
            this.writer = textEncoder.writable.getWriter();

            // slcan setup commands
            await this.sendRaw("C\r"); // Close CAN channel
            
            // Set bitrate (slcan: S0=10k, S1=20k, S2=50k, S3=100k, S4=125k, S5=250k, S6=500k, S7=800k, S8=1M)
            let sCmd = "S8\r"; // default 1M
            if(bitrate === "125000") sCmd = "S4\r";
            else if(bitrate === "250000") sCmd = "S5\r";
            else if(bitrate === "500000") sCmd = "S6\r";
            
            await this.sendRaw(sCmd);
            await this.sendRaw("O\r"); // Open CAN channel
            
            ui.log("CAN", `Connected to Serial Port. (Bitrate: ${bitrate})`, "success");
            ui.setConnectionStatus(true);
            
            // Start reading loop
            this.keepReading = true;
            this.readLoop();
            
            // Start TX loops
            this.startTxLoops();
            
            return true;
        } catch (e) {
            console.error(e);
            ui.log("CAN", "Connection failed: " + e.message, "danger");
            this.disconnect();
            return false;
        }
    },

    disconnect: async function() {
        this.stopTxLoops();
        this.keepReading = false;
        
        if (this.reader) {
            await this.reader.cancel();
        }
        if (this.writer) {
            await this.sendRaw("C\r"); // Close CAN channel before closing port
            await this.writer.close();
        }
        if (this.port) {
            await this.port.close();
            this.port = null;
        }
        
        ui.log("CAN", "Disconnected from Serial Port.", "info");
        ui.setConnectionStatus(false);
    },

    sendRaw: async function(str) {
        if (this.writer) {
            await this.writer.write(str);
        }
    },

    // data: Array of bytes (0-255)
    sendCanFrame: async function(id, data, ext=false) {
        if (!this.writer) return;
        
        let cmd = ext ? "T" : "t";
        let idHex = id.toString(16).toUpperCase();
        if(ext) {
            idHex = idHex.padStart(8, '0');
        } else {
            idHex = idHex.padStart(3, '0');
        }
        
        let len = data.length;
        if(len > 8) len = 8;
        
        let dataHex = "";
        for(let i=0; i<len; i++) {
            dataHex += data[i].toString(16).padStart(2, '0').toUpperCase();
        }
        
        const frameStr = `${cmd}${idHex}${len}${dataHex}\r`;
        await this.sendRaw(frameStr);
    },

    readLoop: async function() {
        const decoder = new TextDecoderStream();
        this.port.readable.pipeTo(decoder.writable);
        this.reader = decoder.readable.getReader();
        
        let buffer = "";
        
        try {
            while (this.keepReading) {
                const { value, done } = await this.reader.read();
                if (done) break;
                if (value) {
                    buffer += value;
                    let lines = buffer.split('\r');
                    buffer = lines.pop(); // keep the last incomplete part
                    
                    for (let line of lines) {
                        this.parseSlcanLine(line);
                    }
                }
            }
        } catch (error) {
            console.error("Read error:", error);
            ui.log("CAN", "Read error occurred.", "danger");
        } finally {
            this.reader.releaseLock();
        }
    },

    parseSlcanLine: function(line) {
        if(!line || line.length === 0) return;
        
        const cmd = line[0];
        if(cmd === 't' || cmd === 'T') {
            const ext = (cmd === 'T');
            const idLen = ext ? 8 : 3;
            if(line.length < 1 + idLen + 1) return;
            
            const idHex = line.substring(1, 1 + idLen);
            const id = parseInt(idHex, 16);
            
            const dlcStr = line.substring(1 + idLen, 1 + idLen + 1);
            const dlc = parseInt(dlcStr, 10);
            
            const dataHex = line.substring(1 + idLen + 1, 1 + idLen + 1 + dlc * 2);
            let data = [];
            for(let i=0; i<dlc; i++) {
                data.push(parseInt(dataHex.substring(i*2, i*2+2), 16));
            }
            
            this.handleIncomingCanFrame(id, data);
        }
    },

    handleIncomingCanFrame: function(id, data) {
        // ステータス受信など
        // MDD: 0x230 (base+0x30)
        window.altairState.modules.forEach(m => {
            if(m.type === 'mdd' && m.baseId !== null) {
                if(id === m.baseId + 0x30) {
                    // status frame [SW1, SW2, SW3, SW4, Err, Mode]
                    m.state.sw = [data[0], data[1], data[2], data[3]];
                    m.state.err = data[4];
                    m.state.appMode = data[5] & 0x01;
                    m.state.lastUpdate = Date.now();
                    
                    // Automation Trigger evaluation first, or param completion
                    if(m.state.paramSendRequested && m.state.appMode === 1) {
                        m.state.paramSendRequested = false;
                        m.state.paramSetupCompleted = true;
                        ui.log("CAN", `MDD ${m.name} parameter setup completed.`, "success");
                    }
                    
                    ui.updateModuleUI(m);
                    
                    // Automation Trigger evaluation
                    if(window.automation && window.altairState.autoTriggerEngine) {
                        window.automation.evaluateTriggers();
                    }
                }
            }
        });
    },

    // --------------------------------------------------------
    // 送信ループ
    // --------------------------------------------------------
    startTxLoops: function() {
        this.txLoopTimer10 = setInterval(() => this.process10msLoop(), 10);
        this.txLoopTimer100 = setInterval(() => this.process100msLoop(), 100);
    },

    stopTxLoops: function() {
        if(this.txLoopTimer10) clearInterval(this.txLoopTimer10);
        if(this.txLoopTimer100) clearInterval(this.txLoopTimer100);
    },

    process10msLoop: function() {
        if(!this.writer) return;
        
        window.altairState.modules.forEach(m => {
            if(!m.txEnabled) return;
            
            if(m.type === 'mdd') {
                if(m.state.paramSendRequested) {
                    // PARAMETER MODE (Sending continuously until setup is completed)
                    this.sendMddParams(m);
                    this.sendMddMode(m);
                } else if(m.state.appMode === 1 && m.state.paramSetupCompleted) {
                    // CONTROL MODE (Only send targets when setup is completed)
                    this.sendMddTarget(m);
                }
            } else if(m.type === 'servo') {
                this.sendServoTarget(m);
            }
        });
    },

    process100msLoop: function() {
        if(!this.writer) return;
        
        window.altairState.modules.forEach(m => {
            if(!m.txEnabled) return;
            
            if(m.type === 'solenoid') {
                this.sendSolenoidTarget(m);
            }
        });
    },

    // --- Helpers to encode Little Endian ---
    encodeI16LE: function(val) {
        val = val & 0xFFFF;
        return [val & 0xFF, (val >> 8) & 0xFF];
    },

    // --- MDD Send ---
    sendMddMode: function(m) {
        let payload = [m.motors[0].mode, m.motors[1].mode, m.motors[2].mode, m.motors[3].mode];
        this.sendCanFrame(m.baseId + 0x10, payload); // 0x210
    },

    sendMddTarget: function(m) {
        let payload = [];
        for(let i=0; i<4; i++) {
            let t = Math.round(m.motors[i].target * 10);
            t = Math.max(-32768, Math.min(32767, t));
            payload.push(...this.encodeI16LE(t));
        }
        this.sendCanFrame(m.baseId + 0x20, payload); // 0x220
    },

    sendMddParams: function(m) {
        for(let i=0; i<4; i++) {
            let motor = m.motors[i];
            let p = Math.round(motor.p * 100);
            let i_gain = Math.round(motor.i * 100);
            let d = Math.round(motor.d * 100);
            let wheel = Math.round(motor.wheel);
            let dir = motor.dir >= 0 ? 1 : -1;
            
            let payload = [];
            payload.push(...this.encodeI16LE(p));
            payload.push(...this.encodeI16LE(i_gain));
            payload.push(...this.encodeI16LE(d));
            payload.push(...this.encodeI16LE(wheel * dir));
            
            this.sendCanFrame(m.baseId + i, payload); // 0x200 - 0x203
        }
    },

    // --- Servo Send ---
    sendServoTarget: function(m) {
        let payload = [];
        for(let i=0; i<6; i++) {
            let t = Math.max(0, Math.min(180, m.ch[i]));
            payload.push(t);
        }
        this.sendCanFrame(m.baseId, payload);
    },

    // --- Solenoid Send ---
    sendSolenoidTarget: function(m) {
        let v = m.valves; // bitfield 0-11
        let payload = [v & 0xFF, (v >> 8) & 0xFF];
        this.sendCanFrame(m.baseId, payload);
    }
};
