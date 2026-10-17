@echo off
rem ==== 一键上传 Obsidian 文章到博客 ====
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0upload-post.ps1"
