@echo off
chcp 65001 >nul 2>&1
title API 加速客户端

echo ============================================
echo       API 加速客户端 v1.0.0
echo ============================================
echo.

:: 检查 Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js ^(^>= 18.0^)
    echo 下载地址: https://nodejs.org/
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do echo [信息] Node.js 版本: %%v

:: 进入脚本所在目录
cd /d "%~dp0"

:: 检查依赖
if not exist "node_modules" (
    echo [信息] 首次运行，正在安装依赖...
    call npm install --silent
    if %errorlevel% neq 0 (
        echo [错误] 依赖安装失败，请检查网络连接
        pause
        exit /b 1
    )
    echo [信息] 依赖安装完成
    echo.
)

:: 检查启动参数
if "%1"=="--reset" goto :do_reset
if "%1"=="--config" goto :do_reset
if "%1"=="--help" goto :show_help
if "%1"=="-h" goto :show_help
goto :load_config

:show_help
echo 用法: start.bat [选项]
echo.
echo 选项:
echo   --config    修改令牌和代理配置
echo   --reset     重置所有配置（效果同 --config）
echo   --help, -h  显示帮助
echo.
pause
exit /b 0

:do_reset
echo [配置] 进入配置修改模式
echo.
del /f "%~dp0relay.config" >nul 2>&1
goto :input_config

:load_config
set "CONFIG_FILE=%~dp0relay.config"
set "TOKEN="
set "PROXY_URL="

if exist "%CONFIG_FILE%" (
    for /f "usebackq tokens=1,* delims==" %%a in ("%CONFIG_FILE%") do (
        if "%%a"=="TOKEN" set "TOKEN=%%b"
        if "%%a"=="PROXY" set "PROXY_URL=%%b"
    )
)

:: 已有配置，显示菜单
if not "%TOKEN%"=="" (
    echo 当前配置:
    echo   令牌: %TOKEN:~0,12%...
    if not "%PROXY_URL%"=="" (
        echo   代理: %PROXY_URL%
    ) else (
        echo   代理: 未设置（直连）
    )
    echo.
    echo ────────────────────────────────────────────
    echo   [1] 启动加速服务
    echo   [2] 修改令牌
    echo   [3] 修改代理地址
    echo   [4] 修改全部配置
    echo   [5] 退出
    echo ────────────────────────────────────────────
    echo.
    set /p "MENU_CHOICE=请选择 (直接回车=启动): "
    
    if "%MENU_CHOICE%"=="" goto :start_relay
    if "%MENU_CHOICE%"=="1" goto :start_relay
    if "%MENU_CHOICE%"=="2" goto :change_token
    if "%MENU_CHOICE%"=="3" goto :change_proxy
    if "%MENU_CHOICE%"=="4" goto :input_config
    if "%MENU_CHOICE%"=="5" exit /b 0
    goto :start_relay
)

:input_config
echo [配置] 请填写以下信息（配置会自动保存）
echo.
set "TOKEN="
set "PROXY_URL="
set /p "TOKEN=请输入您的加速令牌: "

if "%TOKEN%"=="" (
    echo [错误] 加速令牌不能为空
    pause
    exit /b 1
)

echo.
echo 本地代理地址（可选，直接回车跳过）
echo   * 如果您能正常访问海外网站，无需配置
echo   * 如果需要科学上网才能访问，请填写代理地址
echo.
echo   Clash:        http://127.0.0.1:7890
echo   V2rayN:       http://127.0.0.1:10809
echo   Shadowsocks:  socks5://127.0.0.1:1080
echo.
set /p "PROXY_URL=本地代理地址: "
goto :save_and_start

:change_token
echo.
echo 当前令牌: %TOKEN:~0,12%...
set /p "TOKEN=请输入新的加速令牌（直接回车=保持不变）: "
if "%TOKEN%"=="" (
    for /f "usebackq tokens=1,* delims==" %%a in ("%CONFIG_FILE%") do (
        if "%%a"=="TOKEN" set "TOKEN=%%b"
    )
)
goto :save_and_start

:change_proxy
echo.
if not "%PROXY_URL%"=="" (
    echo 当前代理: %PROXY_URL%
) else (
    echo 当前代理: 未设置
)
echo.
echo 常用代理地址:
echo   Clash:        http://127.0.0.1:7890
echo   V2rayN:       http://127.0.0.1:10809
echo   Shadowsocks:  socks5://127.0.0.1:1080
echo   清除代理请输入: none
echo.
set "NEW_PROXY="
set /p "NEW_PROXY=新的代理地址（直接回车=保持不变）: "
if not "%NEW_PROXY%"=="" (
    if "%NEW_PROXY%"=="none" (
        set "PROXY_URL="
    ) else (
        set "PROXY_URL=%NEW_PROXY%"
    )
)
goto :save_and_start

:save_and_start
(
    echo TOKEN=%TOKEN%
    echo PROXY=%PROXY_URL%
) > "%~dp0relay.config"
echo.
echo [信息] 配置已保存
echo.

:start_relay
echo ============================================
echo   令牌: %TOKEN:~0,12%...
if not "%PROXY_URL%"=="" (echo   代理: %PROXY_URL%) else (echo   代理: 直连)
echo ============================================
echo.
echo [提示] 按 Ctrl+C 可停止运行
echo.

set "CMD=node proxy-relay.js --token %TOKEN%"
if not "%PROXY_URL%"=="" set "CMD=%CMD% --proxy %PROXY_URL%"

%CMD%

echo.
echo [信息] 程序已退出
pause
