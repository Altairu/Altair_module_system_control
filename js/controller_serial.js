/**
 * controller_serial.js
 * COMポート（シリアル通信）経由で送られてくるコントローラー入力を処理する
 * データフォーマット例（最後に改行）:
 * ボタン: B,0,1  (Button 0 pressed)
 * 軸: A,1,0.5 (Axis 1 value 0.5)
 */

const controllerSerial = {
    port: null,
    reader: null,
    inputDone: null,
    inputStream: null,
    connected: false,
    prevAxes: [],

    init: function() {
        // Init happens on UI connect
    },

    connect: async function(baudRate) {
        if (!('serial' in navigator)) {
            alert("お使いのブラウザはWeb Serial APIをサポートしていません。ChromeまたはEdgeをご利用ください。");
            return false;
        }

        try {
            this.port = await navigator.serial.requestPort();
            await this.port.open({ baudRate: parseInt(baudRate) });

            ui.log("ControllerSerial", `Connected to COM port at ${baudRate} bps`, "success");
            this.connected = true;
            this.updateUI();

            this.readLoop();
            return true;
        } catch (e) {
            ui.log("ControllerSerial", `Connection Failed: ${e}`, "danger");
            return false;
        }
    },

    disconnect: async function() {
        this.connected = false;
        this.updateUI();
        
        if (this.reader) {
            await this.reader.cancel();
        }
        if (this.inputDone) {
            await this.inputDone.catch(() => {});
        }
        if (this.port) {
            await this.port.close();
            this.port = null;
        }
        ui.log("ControllerSerial", "Disconnected.", "info");
    },

    updateUI: function() {
        const statusEl = document.getElementById('serial-controller-status');
        const btnCon = document.getElementById('btn-connect-serial-ctrl');
        const btnDis = document.getElementById('btn-disconnect-serial-ctrl');
        
        if (!statusEl) return;

        if (this.connected) {
            statusEl.className = 'status-indicator online';
            statusEl.innerText = 'COM Controller Connected';
            btnCon.disabled = true;
            btnDis.disabled = false;
        } else {
            statusEl.className = 'status-indicator offline';
            statusEl.innerText = 'Offline';
            btnCon.disabled = false;
            btnDis.disabled = true;
        }
    },

    readLoop: async function() {
        let buffer = '';
        const decoder = new TextDecoderStream();
        this.inputDone = this.port.readable.pipeTo(decoder.writable);
        this.inputStream = decoder.readable;
        this.reader = this.inputStream.getReader();

        try {
            while (true) {
                const { value, done } = await this.reader.read();
                if (done) break;
                
                buffer += value;
                let lines = buffer.split(/\r?\n/);
                buffer = lines.pop(); // 最後の不完全な行をバッファに残す

                for (let line of lines) {
                    this.processLine(line.trim());
                }
            }
        } catch (error) {
            if (this.connected) {
                ui.log("ControllerSerial", `Read Error: ${error}`, "danger");
                this.disconnect();
            }
        } finally {
            this.reader.releaseLock();
        }
    },

    processLine: function(line) {
        if (!line) return;

        const parts = line.split(',');
        if (parts.length < 3) return;

        const type = parts[0];
        const index = parseInt(parts[1]);
        const val = parseFloat(parts[2]);

        const testEl = document.getElementById('gamepad-test-output');

        if (type === 'B') {
            const isPressed = (val === 1);
            if (testEl) {
                testEl.innerText = `Serial Button ${index} ${isPressed ? 'PRESSED' : 'RELEASED'}\n`;
            }
            if (window.gamepad) {
                window.gamepad.handleInputEvent('button', index, isPressed, val);
            }
        } 
        else if (type === 'A') {
            if (testEl) {
                testEl.innerText = `Serial Axis ${index}: ${val.toFixed(2)}\n`;
            }
            
            const prevVal = this.prevAxes[index] || 0;
            const threshold = 0.5;

            // Positive direction check
            const isPos = val > threshold;
            const wasPos = prevVal > threshold;
            if (isPos !== wasPos && window.gamepad) {
                window.gamepad.handleInputEvent('axis', index, isPos, val, 1);
            }

            // Negative direction check
            const isNeg = val < -threshold;
            const wasNeg = prevVal < -threshold;
            if (isNeg !== wasNeg && window.gamepad) {
                window.gamepad.handleInputEvent('axis', index, isNeg, val, -1);
            }

            this.prevAxes[index] = val;
        }
    }
};

window.controllerSerial = controllerSerial;

