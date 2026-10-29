# Altair Framework 動作プログラム記述仕様書

本ドキュメントは、Altair Module Systemにおいて、人間やAIアシスタントがバグのない安全な自律動作プログラムとして動作するPythonスクリプトを記述するためのAPI仕様書です。

AIへコードの記述を指示する際は、このファイルの内容をそのままAIのプロンプトに貼り付けることで、システムの仕様を理解して動作するPython制御プログラムを作成させることができます。

---

## 動作プログラムの基本構造

すべての動作プログラムは、altair_core の base_behavior.py に実装された AltairBehavior クラスを継承した単一のPythonクラスとして記述します。

```python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import sys
import rclpy
import os

# パスを設定します
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from altair_core.base_behavior import AltairBehavior

class MyCustomBehavior(AltairBehavior):
    def on_init(self):
        """起動時に一度だけ実行する初期化処理です。"""
        # get_moduleを使用してモジュールを取得します
        self.mdd = self.get_module("drive_mdd")
        self.servo = self.get_module("arm_servo")
        self.valve = self.get_module("valve_controller")

    def loop(self):
        """デフォルトで2ミリ秒ごとに周期実行する処理です。"""
        # 制御ロジックを記述します
        pass

def main(args=None):
    rclpy.init(args=args)
    behavior = MyCustomBehavior("my_behavior_node")
    behavior.run(rate_hz=500.0)

if __name__ == '__main__':
    main()
```

---

## モジュール操作APIの仕様一覧

self.get_moduleを呼び出すと、設定ファイルに基づいた各モジュール専用のクライアントオブジェクトが返されます。これらのオブジェクトは以下のAPIを提供します。

### MDDモータドライバクライアント

4つのDCモータを一括で制御または監視するオブジェクトです。クラス名は MddClient です。

* set_targets(targets)
  引数の targets には、4つのモータの目標値を配列で指定します。
  目標値は制御モードによって以下のように解釈されます。
  * 速度モードは秒間回転数
  * 角度モードは度
  * 位置モードはミリメートル
* get_feedback()
  MddFeedbackオブジェクトを返します。以下の属性を提供します。
  * limit_switches
    各リミットスイッチの状態を示す真偽値の配列です。スイッチが押されている場合は True になります。
  * angles
    各モータの現在角度を度数法で示す配列です。
  * speeds
    各モータの現在の回転速度を示す配列です。
  * error_code
    システムのエラーコードです。0は正常、1は初期化タイムアウト、2はCAN受信タイムアウト、4は送信失敗を示します。
  * system_status
    動作モードの状態です。0はパラメータ設定中、1は制御中を示します。

### サーボモータクライアント

最大6つのPWMサーボの角度を一括指定するオブジェクトです。クラス名は ServoClient です。

* set_angles(angles)
  引数の angles には、6チャンネル分の目標角度を配列で指定します。
  設定できる範囲は0度から180度までです。180を超える値はマイコン側で180に自動で調整されます。

### 電磁弁クライアント

最大12チャンネルの電磁弁を一括または個別に制御するオブジェクトです。クラス名は SolenoidClient です。

* set_valves(valves)
  引数の valves には、12チャンネルの動作状態を真偽値の配列で指定します。
* set_valve(channel, state)
  特定のチャンネルを個別に制御します。
  引数の channel には、1から12までのチャンネル番号を指定します。
  引数の state には、開く場合は True を、閉じる場合は False を指定します。

---

## ノンブロッキングステートマシン記述の厳守

ROS2は非同期通信をバックグラウンドで処理しています。そのため、動作プログラム内で time.sleep(3.0) のようなスレッドを一時停止させる関数を実行すると、通信の送受信がすべて停止してモータが暴走する原因になります。

プログラムへ待機処理を組み込む場合は、time.time() を使用してノンブロッキングな状態遷移モデルで記述してください。

### 悪い例

```python
def loop(self):
    self.mdd.set_targets([1.0, 1.0, 1.0, 1.0])
    time.sleep(3.0) # ループ全体がフリーズするため使用しないでください
    self.mdd.set_targets([0.0, 0.0, 0.0, 0.0])
```

### 正しい例

```python
def on_init(self):
    self.mdd = self.get_module("drive_mdd")
    self.state = "START"
    self.timer = 0.0

def loop(self):
    if self.state == "START":
        self.mdd.set_targets([1.0, 1.0, 1.0, 1.0])
        self.timer = time.time()  # 現在の時刻を記録します
        self.state = "WAITING"
        
    elif self.state == "WAITING":
        # 3秒が経過したかを判定します
        if time.time() - self.timer >= 3.0:
            self.mdd.set_targets([0.0, 0.0, 0.0, 0.0])
            self.state = "FINISHED"
```

---

## プロンプトテンプレート

AIへプログラムの記述を指示する際は、このファイルの内容を送信した後に、以下のテンプレートを貼り付けてください。

```text
現在のシステム構成は以下の通りです。
* MDDモータドライバの名前は drive_mdd です。
* サーボモジュールの名前は arm_servo です。
* 電磁弁モジュールの名前は valve_controller です。

以下の動作を行うプログラムを作成してください。
* 最初に drive_mdd のモータをすべて 1.5 rps で回転させて前進させます。
* drive_mdd のリミットスイッチの1番が押されたら、すべてのモータを停止します。
* 停止した後に、arm_servo のサーボの1番を120度、2番を45度にしてアームを下降させます。
* 下降した直後に、valve_controller の1番と2番の電磁弁を開いて吸引を開始します。
* 吸引を開始してから2秒間待機します。待機処理はノンブロッキングで実装してください。
* 2秒が経過した後に、arm_servo のサーボをすべて90度にしてホームポジションへ上昇させます。吸引は維持したままプログラムを正常に終了してください。

動作プログラム記述仕様書に従い、プログラムを作成してください。
```

---

## ファイル配置と実行方法

### ファイル保存場所

すべての動作プログラムは、リポジトリルートの **`user_behaviors/`** ディレクトリに `.py` ファイルとして保存してください。

```text
altair_framework/
├── user_behaviors/              ← ユーザー動作プログラムの配置先
│   ├── blockly_behavior.py      (Blocklyで生成)
│   ├── template_behavior.py     (雛形ファイル)
│   ├── my_custom_behavior.py    ← 新規作成したファイル
│   └── another_program.py       ← さらに追加可能
│
├── altair_core/user_behaviors/  (古いパス - 後方互換性のみ)
└── ...
```

### WebUI から実行

1. Web UI の **「Python Program」** タブを開く
2. **「プログラムファイル選択」** のドロップダウンを確認
3. 新規作成したファイル名が自動的に表示される
4. ファイルを選択して **「起動 (Start Program)」** ボタンをクリック

**重要：** サーバーを再起動する必要はありません。`user_behaviors/` に `.py` ファイルを追加・削除すると、次にタブにアクセスした時点で自動検出されます。

### 優先順位

実行時のファイル探索順序は以下の通りです：

1. **`./user_behaviors/{filename}.py`** ← 優先
2. `./altair_core/user_behaviors/{filename}.py` (後方互換性)
3. ROS2 install path
4. その他の登録パス

つまり、**`user_behaviors/` ディレクトリが最優先**されるため、このディレクトリをメインの配置場所として使用してください。

---
