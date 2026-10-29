#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Altair Module System - Blockly 自動生成プログラム
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
                if self.gamepad.get_button(7) == True:
                    self.get_module("MDD1").set_targets([1, 0, 0, 0])
                else:
                    self.get_module("MDD1").set_targets([0, 0, 0, 0])

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

