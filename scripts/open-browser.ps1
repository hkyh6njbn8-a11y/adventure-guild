# open-browser.ps1 — 冒险公会：等端口就绪后打开浏览器
# 用法：open-browser.ps1 <port>
# 轮询等待服务监听（最多 30 秒），就绪后打开浏览器，避免"无法访问此网站"。

param([int]$Port = 8765)

$url = "http://127.0.0.1:$Port"

# 轮询最多 60 次 × 500ms = 30 秒
for ($i = 0; $i -lt 60; $i++) {
    try {
        $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop
        if ($c) {
            Start-Sleep -Milliseconds 300  # 再多给服务一点响应时间
            Start-Process $url
            exit 0
        }
    } catch { }
    Start-Sleep -Milliseconds 500
}

# 超时仍未就绪，仍然尝试打开（可能服务已起但检测遗漏）
Start-Process $url
exit 1
