# ロボット側 PC セットアップガイド (setup_guide_nuc.md)

本ドキュメントは、ロボット搭載 PC（NUC 等）と CAN 通信モジュールを接続し、安定して通信を確立するための環境構築ガイドです。
Ethernet-CAN 変換モジュール（推奨）の設定手順と、従来の USB-to-CAN アダプタ（非推奨）の設定手順の双方を記載しています。

---

## Ethernet-CAN 変換モジュールのセットアップ (推奨)

Ethernet-CAN 変換モジュール（STM32 + W5500）を使用する場合、PC と基板を有線 LAN ケーブルで直結して通信を行います。

### ネットワーク構成

* Ethernet-CAN 基板側
  * 初期 IP アドレス: 192.168.2.123
  * ポート番号: 5000 (TCP)
  * 動作モード: TCP Analyzer Mode
* PC 側 (有線 LAN ポート)
  * IP アドレス: 192.168.2.100
  * サブネットマスク: 255.255.255.0
  * ゲートウェイ: 設定不要 (空欄)

### Ubuntu での有線 LAN 固定 IP 設定手順

Ubuntu の GUI または nmcli コマンドを用いて、有線 LAN ポートに固定 IP を割り当てます。

* コマンドライン (nmcli) で設定する場合
  ```bash
  # 有線LANの接続名を確認
  nmcli connection show

  # 有線LAN接続 (例: "Wired connection 1") に固定IPを設定
  sudo nmcli connection modify "Wired connection 1" \
      ipv4.addresses 192.168.2.100/24 \
      ipv4.method manual

  # 接続を再起動して設定を反映
  sudo nmcli connection up "Wired connection 1"
  ```

* 接続テスト
  LAN ケーブルを基板と直結し、ping コマンドで応答があるか確認します。
  ```bash
  ping 192.168.2.123
  ```
  応答が返ってくれば、ネットワーク層の接続は完了です。

### 起動方法

* PC 1台運用のスタンドアロン起動 (推奨)
  ```bash
  ./run_standalone.sh
  ```
* PC 2台運用のロボット側ノード起動
  ```bash
  ./run_nuc.sh
  ```

---

## 従来の USB-to-CAN アダプタのセットアップ (非推奨)

CANable 2 などの USB-to-CAN ドングルを使用する場合の環境構築手順です。

### udev ルールによるデバイス名の固定化

USB ポート番号の変動を防ぐため、デバイス固有の ID を用いて固定のシンボリックリンク（/dev/altair_can）を自動生成します。

* デバイスIDの確認
  ```bash
  lsusb
  ```
* udev ルールファイルの作成
  管理者権限で /etc/udev/rules.d/99-altair-can.rules を作成し、以下を記述します。
  ```text
  SUBSYSTEM=="tty", ATTRS{idVendor}=="16d0", ATTRS{idProduct}=="117e", SYMLINK+="altair_can", MODE="0666"
  ```
* ルールの反映
  ```bash
  sudo udevadm control --reload-rules
  sudo udevadm trigger
  ```

### パスワード不要での SocketCAN 起動設定 (sudoers)

slcand の実行やインターフェース起動をロボット起動時にパスワードなしで実行できるように設定します。

```bash
sudo visudo
```
最下部に以下を追記します（nuc はログインユーザー名）。
```text
nuc ALL=(ALL) NOPASSWD: /usr/sbin/modprobe, /usr/bin/slcand, /usr/bin/killall, /usr/sbin/ip
```

### 起動方法

* 単一 PC 運用時
  ```bash
  ./run_standalone.sh --usb
  ```
* 2台 PC 運用時
  ```bash
  ./run_nuc.sh --usb
  ```
