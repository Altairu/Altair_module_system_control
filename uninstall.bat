@echo off
chcp 65001 > nul
cd /d "%~dp0"
if exist "unins000.exe" (
    echo Altair Module System Control のアンインストーラーを起動しています...
    start "" "unins000.exe"
) else (
    echo アンインストーラー (unins000.exe) が見つかりませんでした。
    echo Windows の「設定」＞「インストールされているアプリ」からアンインストールを行ってください。
    pause
)

