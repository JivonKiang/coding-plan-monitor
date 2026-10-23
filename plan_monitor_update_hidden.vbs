' 免黑窗启动器：由计划任务 PlanMonitorUpdate 调用（每 2 分钟）
' 窗口样式 0 = 隐藏；日志重定向与原任务一致（cmd 内部 >> 仍在生效）
Option Explicit
Dim sh
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "e:\ai agent\plan-monitor"
sh.Run "cmd.exe /c node update.mjs 1>>task-update.log 2>&1", 0, False
