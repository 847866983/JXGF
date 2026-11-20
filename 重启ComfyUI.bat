@echo off
title 重启 ComfyUI
echo 正在停止 ComfyUI...
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*ComfyUI*main.py*' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }"
powershell -NoProfile -Command "Get-Process 'Comfy Desktop' -ErrorAction SilentlyContinue | Stop-Process -Force"
timeout /t 4 /nobreak >nul
echo 正在启动 Comfy Desktop...
start "" "D:\ComfyUI\Comfy Desktop\Comfy Desktop.exe"
echo 等待端口 8188 就绪（最多 3 分钟）...
powershell -NoProfile -Command "for($i=0;$i -lt 60;$i++){ try { Invoke-RestMethod -Uri 'http://127.0.0.1:8188/system_stats' -TimeoutSec 3 | Out-Null; Write-Host 'ComfyUI 已就绪'; exit 0 } catch { Start-Sleep -Seconds 3 } }; Write-Host '超时，请到 Comfy Desktop 界面点启动'"
pause