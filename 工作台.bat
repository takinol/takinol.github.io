@echo off
rem ==== 博客工作台：上传照片 / 压缩 / 上传文章 / 构建部署 / 本地预览 ====
rem 双击运行即可，按菜单输入序号。
chcp 65001 >nul
setlocal
set "PS1=%~dp0workbench.ps1"

if not exist "%PS1%" (
    echo [x] 找不到 workbench.ps1，请确认它和本文件在同一个文件夹。
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"

echo.
pause
