@echo off
rem ==== 一键部署博客到 GitHub Pages（构建 + 推送 gh-pages，不依赖 Actions） ====
rem 双击运行即可。第一次用完之后，要去 Settings -> Pages 把 Source 改成 gh-pages 分支。
chcp 65001 >nul
setlocal
set "PS1=%~dp0deploy-gh-pages.ps1"

if not exist "%PS1%" (
    echo [x] 找不到 deploy-gh-pages.ps1，请确认它和本文件在同一个文件夹。
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"

echo.
pause
