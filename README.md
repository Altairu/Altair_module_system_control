# Altair Web Controller

Altair Module System の各モジュール（MDD, Servo, Solenoid Valve）をブラウザから直接制御するためのウェブアプリケーションです。
ローカルのPythonサーバー等を立ち上げる必要なく、ブラウザから直接USBシリアル通信（slcanプロトコル）を行うことができます。

## アクセスURL
https://altairu.github.io/Altair_module_system_control/

## ご利用時の注意点（重要）
本アプリケーションは、ブラウザの標準機能である **Web Serial API** を使用してハードウェアと通信します。

- **対応ブラウザ**: パソコン版の **Google Chrome** または **Microsoft Edge** でのみ動作します。（FirefoxやSafari、スマートフォンからはシリアル通信ができません）
- **対応インターフェース**: `slcan` プロトコル（USBをCOMポートとして認識するもの）にのみ対応しています。専用ドライバ（PCANやSocketCAN）が必要なデバイスではご利用いただけません。

## 特徴
- **完全Webベース**: GitHub Pages等のURLを開くだけで、インストール不要で動作します。
- **リッチなUI**: Glassmorphismとダークテーマを取り入れたモダンなダッシュボード。
- **動的構成**: モジュールを無制限に追加し、それぞれのCAN IDを自由に設定可能。
- **Automation (ブロック制御)**: Google Blocklyを用いたScratchライクなマクロ・トリガー作成機能。MDDのリミットスイッチ等を条件に、他のモジュールを自動制御できます。
- **状態の保存**: ブラウザのローカルストレージに設定が自動保存され、次回アクセス時に復元されます。
