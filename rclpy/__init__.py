"""
ROS2 rclpy 互換シム
ROS2がインストールされていないWindows / macOS / Linux環境でも、
altair_framework 向けの動作スクリプト (import rclpy) をそのまま動作させるための軽量モジュールです。
"""

_ok = True


def init(args=None):
    global _ok
    _ok = True


def ok():
    return _ok


def shutdown():
    global _ok
    _ok = False

