# Weekly local security scan for MyTuums.
#
# Runs cyberseek (the DeepSeek-enabled codex-security fork) against the
# working tree, then uploads the resulting SARIF to GitHub code scanning
# directly through the API - no GitHub Actions runner involved. GitHub
# runners were abandoned because codex's Linux build has flaky transport
# failures against DeepSeek's API; Windows builds work reliably.
#
# Requirements (one-time):
#   - cyberseek on PATH (npm install -g from the fork build)
#   - DEEPSEEK_API_KEY env var, or C:\Dev\apikey_deepseek.txt (cyberseek
#     falls back to that file on this machine)
#   - gh CLI authenticated; run once: gh auth refresh -h github.com -s security_events
#
# Exit codes are cyberseek's: 0 clean, 1 = findings at/above high,
# 2 = incomplete coverage or hard failure. The SARIF upload never masks
# the scan result.

$RepoRoot = Split-Path -Parent $PSScriptRoot   # scripts/ -> repo root
$OutDir = Join-Path $env:TEMP "mytuums-security-scan"
$Repo = "ElCabrii/MyTuums"

# Fresh output dir per run; transcript captures the full log for the
# scheduled task.
if (Test-Path $OutDir) { Remove-Item -Recurse -Force $OutDir }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Start-Transcript -Path (Join-Path $OutDir "run.log") -Append

Set-Location $RepoRoot

# 1) The scan itself.
cyberseek scan . --output-dir $OutDir --fail-on-severity high --json
$scanExit = $LASTEXITCODE
Write-Host "cyberseek exit code: $scanExit"

# 2) Upload the SARIF to GitHub code scanning (best effort).
$sarif = Join-Path $OutDir "exports\results.sarif"
if (-not (Test-Path $sarif)) {
    Write-Host "No SARIF at $sarif - skipping upload."
} else {
    try {
        $sha = (git rev-parse HEAD).Trim()
        $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($sarif))
        $body = @{ commit_sha = $sha; ref = "refs/heads/main"; sarif = $b64 } |
            ConvertTo-Json -Compress
        $bodyFile = Join-Path $OutDir "sarif-upload.json"
        Set-Content -Path $bodyFile -Value $body -Encoding ascii
        $response = gh api -X POST "repos/$Repo/code-scanning/sarifs" --input $bodyFile
        Write-Host "SARIF uploaded: $response"
    } catch {
        Write-Host "SARIF upload FAILED: $($_.Exception.Message)"
        Write-Host "Did you run: gh auth refresh -h github.com -s security_events"
    }
}

Stop-Transcript | Out-Null
Write-Host "Log: $OutDir\run.log"
exit $scanExit
