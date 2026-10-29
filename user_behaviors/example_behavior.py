#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Altair Module System
"""

import sys
import rclpy
import os
import time

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
            while True:

                # 運動学計算実行
                def _calc_kinematics():
                    import math
                    vx_val = float((self.gamepad.get_axis(0) * 1000)) / 1000.0
                    vy_val = float((self.gamepad.get_axis(1) * 1000)) / 1000.0
                    omega_val = float((self.gamepad.get_axis(2) * 2))

                    r_t = 300 / 2000.0

                    def get_dia(m_name):
                        if m_name == 'none': return 100.0
                        for m in self.config.get('modules', []):
                            if m.get('name') == "MDD1":
                                return m.get('parameters', {}).get(m_name, {}).get('diameter', 100.0)
                        return 100.0

                    dia_lf = get_dia("m1")
                    dia_rf = get_dia("m2")
                    dia_lr = get_dia("m3")
                    dia_rr = get_dia("m4")

                    k_lf = 1000.0 / (math.pi * dia_lf) if dia_lf > 0 else 1.0
                    k_rf = 1000.0 / (math.pi * dia_rf) if dia_rf > 0 else 1.0
                    k_lr = 1000.0 / (math.pi * dia_lr) if dia_lr > 0 else 1.0
                    k_rr = 1000.0 / (math.pi * dia_rr) if dia_rr > 0 else 1.0

                    target_speeds = [0.0, 0.0, 0.0, 0.0]

                    if "4_OMNI" == "3_OMNI":
                        v1 = (vy_val + r_t * omega_val) * 1.0
                        v2 = (-0.866025 * vx_val - 0.5 * vy_val + r_t * omega_val) * 1.0
                        v3 = (0.866025 * vx_val - 0.5 * vy_val + r_t * omega_val) * 1.0

                        for slot, val in [("m1", v1 * k_lf), ("m2", v2 * k_rf), ("m3", v3 * k_lr)]:
                            if slot != 'none':
                                idx = int(slot[1]) - 1
                                target_speeds[idx] = val

                    elif "4_OMNI" == "4_OMNI":
                        v_lf = (-0.707107 * vx_val + 0.707107 * vy_val - r_t * omega_val) * 1.0
                        v_rf = (0.707107 * vx_val + 0.707107 * vy_val + r_t * omega_val) * 1.0
                        v_lr = (-0.707107 * vx_val - 0.707107 * vy_val + r_t * omega_val) * 1.0
                        v_rr = (0.707107 * vx_val - 0.707107 * vy_val - r_t * omega_val) * 1.0

                        for slot, val in [("m1", v_lf * k_lf), ("m2", v_rf * k_rf), ("m3", v_lr * k_lr), ("m4", v_rr * k_rr)]:
                            if slot != 'none':
                                idx = int(slot[1]) - 1
                                target_speeds[idx] = val

                    elif "4_OMNI" == "4_MECANUM":
                        v_lf = (vy_val - vx_val - r_t * omega_val) * 1.0
                        v_rf = (vy_val + vx_val + r_t * omega_val) * 1.0
                        v_lr = (vy_val + vx_val - r_t * omega_val) * 1.0
                        v_rr = (vy_val - vx_val + r_t * omega_val) * 1.0

                        for slot, val in [("m1", v_lf * k_lf), ("m2", v_rf * k_rf), ("m3", v_lr * k_lr), ("m4", v_rr * k_rr)]:
                            if slot != 'none':
                                idx = int(slot[1]) - 1
                                target_speeds[idx] = val

                    elif "4_OMNI" == "2_DIFF":
                        v_l = vy_val - r_t * omega_val
                        v_r = vy_val + r_t * omega_val

                        for slot, val in [("m1", v_l * k_lf * 1.0), ("m3", v_l * k_lr * 1.0)]:
                            if slot != 'none':
                                idx = int(slot[1]) - 1
                                target_speeds[idx] = val
                        for slot, val in [("m2", v_r * k_rf * 1.0), ("m4", v_r * k_rr * 1.0)]:
                            if slot != 'none':
                                idx = int(slot[1]) - 1
                                target_speeds[idx] = val

                    self.get_module("MDD1").set_targets(target_speeds)

                _calc_kinematics()

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

