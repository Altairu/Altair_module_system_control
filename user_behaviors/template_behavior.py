#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Altair Module System - 動作プログラム テンプレート
このファイルをコピーして新しい動作ロジックを作成してください。
"""

import sys
import rclpy
import os

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from altair_core.base_behavior import AltairBehavior


class TemplateBehavior(AltairBehavior):
    def on_init(self):
        """
        [初期化フェーズ]
        起動時に1回だけ呼び出されます。
        使用する各アクチュエータモジュールのクライアントオブジェクトをここで取得します。
        """
        # get_module には modules_config.json に定義した name を指定します。
        # 例:
        # self.mdd = self.get_module("MDD1")
        # self.servo = self.get_module("Servo1")
        # self.solenoid = self.get_module("Solenoid1")

        self.get_logger().info("TemplateBehavior が初期化されました。")

    def loop(self):
        """
        [周期実行フェーズ]
        一定周期で繰り返し呼び出されます。
        センサー（Limit SW、エンコーダ）のフィードバックを参照し、アクチュエータへ目標値を指示するロジックをここに記述します。
        """
        try:
            pass
        except Exception as e:
            self.get_logger().error(f"ループ実行中にエラーが発生しました: {str(e)}")


def main(args=None):
    rclpy.init(args=args)
    behavior = TemplateBehavior("my_custom_behavior")
    behavior.run(rate_hz=500.0)


if __name__ == "__main__":
    main()

