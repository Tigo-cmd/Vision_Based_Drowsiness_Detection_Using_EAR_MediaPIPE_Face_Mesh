# Sets up and starts the local/LAN mode of the drowsiness monitor: the same
# backend and frontend as the Fly.io deployment, run on this machine instead,
# pulling frames from a camera's local stream instead of the cloud. The
# Fly.io deployment is untouched by anything this script does.
#
# Re-run any time - it skips what's already installed and only re-prompts
# for the camera IP if you pass -ChangeCamera.

param(
    [switch]$ChangeCamera
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$BackendDir = Join-Path $RepoRoot "MainLogic"
$FrontendDir = Join-Path $RepoRoot "Client"

# Writes text as UTF-8 WITHOUT a byte-order mark. Windows PowerShell 5.1's
# "Set-Content -Encoding utf8" adds a BOM, which Python's json.load (used by
# MainLogic/local_stream.py) rejects.
function Write-Utf8NoBom($path, $text) {
    [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding $false))
}

function Test-Command($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

Write-Host "== Checking prerequisites ==" -ForegroundColor Cyan

if (-not (Test-Command "python")) {
    Write-Host "Python was not found on PATH." -ForegroundColor Red
    Write-Host "Download and install Python 3.10 or newer from: https://www.python.org/downloads/windows/"
    Write-Host "During install, tick 'Add python.exe to PATH', then re-run this script."
    exit 1
}

if (-not (Test-Command "npm")) {
    Write-Host "Node.js (which includes npm) was not found on PATH." -ForegroundColor Red
    Write-Host "Download and install the LTS version from: https://nodejs.org/en/download"
    Write-Host "Then re-run this script."
    exit 1
}

Write-Host "Python and Node.js found." -ForegroundColor Green

Write-Host "== Backend: virtualenv + dependencies ==" -ForegroundColor Cyan
$VenvDir = Join-Path $BackendDir ".venv"
if (-not (Test-Path $VenvDir)) {
    python -m venv $VenvDir
}
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
& $VenvPython -m pip install --quiet --upgrade pip
& $VenvPython -m pip install --quiet -r (Join-Path $BackendDir "requirements.txt")

Write-Host "== Frontend: npm install ==" -ForegroundColor Cyan
Push-Location $FrontendDir
npm install
Pop-Location

$LocalConfigPath = Join-Path $BackendDir "local_config.json"
$NeedsCameraPrompt = $ChangeCamera -or -not (Test-Path $LocalConfigPath)

if ($NeedsCameraPrompt) {
    Write-Host "== Camera setup ==" -ForegroundColor Cyan
    $CameraIp = Read-Host "Camera's local IP address (e.g. 192.168.1.42)"
    $StreamUrl = "http://$CameraIp/stream"
    $CameraDeviceId = "local-cam"

    $Config = @{
        camera_stream_url = $StreamUrl
        camera_device_id  = $CameraDeviceId
    }
    Write-Utf8NoBom $LocalConfigPath (($Config | ConvertTo-Json) + "`n")
    Write-Host "Saved $LocalConfigPath"

    $EnvLocalPath = Join-Path $FrontendDir ".env.local"
    Write-Utf8NoBom $EnvLocalPath "VITE_API_BASE_URL=http://localhost:8000`n"
    Write-Host "Saved $EnvLocalPath"

    Write-Host ""
    Write-Host "Reminder: if you also run a physical alert unit board, point its" -ForegroundColor Yellow
    Write-Host "server URL at this PC's own LAN IP and port 8000 (not 'localhost')" -ForegroundColor Yellow
    Write-Host "from its own Wi-Fi setup page - see Firmware/README.md." -ForegroundColor Yellow
} else {
    Write-Host "Using existing local_config.json (pass -ChangeCamera to update the camera IP)."
}

Write-Host "== Starting backend and frontend ==" -ForegroundColor Cyan
$BackendProc = Start-Process -FilePath $VenvPython -ArgumentList "app.py" -WorkingDirectory $BackendDir -PassThru -WindowStyle Normal
$FrontendProc = Start-Process -FilePath "npm.cmd" -ArgumentList "run", "dev" -WorkingDirectory $FrontendDir -PassThru -WindowStyle Normal

Write-Host ""
Write-Host "Backend running (PID $($BackendProc.Id)), frontend running (PID $($FrontendProc.Id))." -ForegroundColor Green
Write-Host "Open the dashboard at the URL the frontend window prints (usually http://localhost:5173)."
Write-Host "Close both windows, or stop processes $($BackendProc.Id) and $($FrontendProc.Id), to shut down."
