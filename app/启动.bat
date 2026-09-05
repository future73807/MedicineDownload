@echo off
chcp 65001 >nul
title 医学影像本地查看器
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js，请先安装 Node.js: https://nodejs.org/
  pause
  exit /b 1
)
echo 正在启动本地查看器...
node server.mjs
pause
