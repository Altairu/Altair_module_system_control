@echo off
chcp 65001 > nul
echo Altair Module System Control - インストーラー作成バッチ
echo.

echo [1/3] リリースバイナリをビルド中...
cargo build --release
if %ERRORLEVEL% neq 0 (
    echo ビルドに失敗しました。
    pause
    exit /b %ERRORLEVEL%
)

echo [2/3] バイナリを配置中...
copy /Y "target\release\altair_module_system_control.exe" "altair_module_system_control.exe" > nul

echo [3/3] Inno Setup でインストーラーを生成中...
set "ISCC_PATH=C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
if not exist "%ISCC_PATH%" (
    set "ISCC_PATH=C:\Program Files\Inno Setup 6\ISCC.exe"
)
if not exist "%ISCC_PATH%" (
    set "ISCC_PATH=%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe"
)

"%ISCC_PATH%" installer.iss
if %ERRORLEVEL% neq 0 (
    echo インストーラーの生成に失敗しました。
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo インストーラーの生成が完了しました: altair_module_system_control_setup.exe
pause

