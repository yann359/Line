Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path -LiteralPath '.env')) { Copy-Item -LiteralPath '.env.example' -Destination '.env' }
if (-not (Test-Path -LiteralPath 'data')) { New-Item -ItemType Directory -Path 'data' | Out-Null }
# chmod on Windows does not establish a private NTFS ACL. Restrict this app's data folder explicitly.
$lineUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe (Join-Path (Get-Location) 'data') /inheritance:r /grant:r "${lineUser}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw '无法保护数据目录，请检查目录权限后再启动。' }
if (-not (Test-Path -LiteralPath 'node_modules')) { & npm.cmd ci; if ($LASTEXITCODE -ne 0) { throw '依赖安装失败' } }
& npm.cmd run dev
