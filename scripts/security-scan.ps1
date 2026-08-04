# Weekly local security scan for MyTuums.
#
# Runs cyberseek (the DeepSeek-enabled codex-security fork) against the
# working tree and reports findings as a GitHub issue. GitHub runners
# were abandoned because codex's Linux build has flaky transport failures
# against DeepSeek's API; Windows builds work reliably. Code scanning is
# unavailable on this private repo's plan, so issues are the reporting
# channel (the SARIF upload below stays as a harmless no-op until that
# changes).
#
# Requirements (one-time):
#   - cyberseek on PATH (npm install -g from the fork build)
#   - DEEPSEEK_API_KEY env var, or C:\Dev\apikey_deepseek.txt (cyberseek
#     falls back to that file on this machine)
#   - gh CLI authenticated
#
# Exit codes are cyberseek's: 0 clean, 1 = findings at/above high,
# 2 = incomplete coverage or hard failure. An issue is opened whenever
# findings.json lists ANY finding (exit code alone would miss medium/low
# findings under --fail-on-severity high). Silence is success.

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

# 2) Upload the SARIF to GitHub code scanning (best effort; requires the
#    repo plan to have code scanning enabled - no-op until then).
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
        Write-Host "SARIF upload skipped (code scanning not enabled): $($_.Exception.Message)"
    }
}

# 3) Report findings as a GitHub issue. Keyed on findings.json, not the
#    exit code (see header comment).
$findingsJson = Join-Path $OutDir "findings.json"
if (Test-Path $findingsJson) {
    $findings = @((Get-Content $findingsJson -Raw | ConvertFrom-Json).findings)
    if ($findings.Count -gt 0) {
        $rows = foreach ($f in $findings) {
            $loc = $f.locations[0]
            $where = if ($loc) { "$($loc.path):$($loc.startLine)" } else { "n/a" }
            "| $($f.severity.level) | $($f.title) | $($f.ruleId) | $where |"
        }
        $details = foreach ($f in $findings) {
            $s = $f.summary
            if ($s.Length -gt 500) { $s = $s.Substring(0, 500) + "..." }
            "### $($f.title)`n`n$s`n"
        }
        $date = Get-Date -Format "yyyy-MM-dd HH:mm"
        $table = $rows -join "`n"
        $detailText = $details -join "`n"
        $issueBody = @"
Weekly agentic security scan (cyberseek / DeepSeek) - $date

Exit code: $scanExit (0 clean, 1 findings at/above high, 2 error)

$($findings.Count) finding(s):

| Severity | Title | Rule | Location |
| --- | --- | --- | --- |
$table

$detailText

Full report: $OutDir\report.md
"@
        $payload = @{ title = "Security scan $date - $($findings.Count) finding(s)"; body = $issueBody } |
            ConvertTo-Json -Compress
        $payloadFile = Join-Path $OutDir "issue-body.json"
        [System.IO.File]::WriteAllText(
            $payloadFile, $payload, (New-Object System.Text.UTF8Encoding $false))
        $created = gh api -X POST "repos/$Repo/issues" --input $payloadFile
        Write-Host "Issue created: $created"
    } else {
        Write-Host "No findings - clean scan, no issue opened."
    }
} else {
    Write-Host "No findings.json (scan did not produce artifacts)."
}

Stop-Transcript | Out-Null
Write-Host "Log: $OutDir\run.log"
exit $scanExit
