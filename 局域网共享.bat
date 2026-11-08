@echo off
chcp 65001 >nul
title SyncText 局域网共享
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装：https://nodejs.org/
  pause
  exit /b 1
)

echo 正在启动 SyncText 局域网共享（Ctrl+C 停止）...
echo 说明：适用于手机热点等无法访问公网域名的场景，
echo       同一热点下的设备直接访问下方打印的局域网地址即可。
echo.
node server.js
pause
