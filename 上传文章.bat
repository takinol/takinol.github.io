@echo off
rem ==== 一键上传 Obsidian 文章到博客 ====
rem 双击运行后粘贴 .md 的绝对路径，或直接把 .md 文件拖到本文件图标上
chcp 65001 >nul
setlocal
set "PS1=%~dp0upload-post.ps1"

if not exist "%PS1%" (
    echo [x] 找不到 upload-post.ps1，请确认它和本文件在同一个文件夹。
    pause
    exit /b 1
)

if "%~1"=="" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -Path "%~1"
)

echo.
pause
