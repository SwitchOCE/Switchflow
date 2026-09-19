@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0.switchflow\scripts\start-control.ps1"
if errorlevel 1 pause
