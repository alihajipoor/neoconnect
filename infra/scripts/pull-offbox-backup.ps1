# Pulls the panel host's newest finished nightly backup off the box, as a
# database-only file, onto the machine this runs on. Windows PowerShell 5.1.
#
# The nightly tarball (infra/scripts/backup.sh) also carries infra/.env and
# the gateway TLS key. This script never copies those: on the host it
# extracts only database.dump into a root-only temp directory, proves the
# archive reads end to end with pg_restore (to /dev/null, no database is
# touched), hashes it, and this side copies that one file and checks the
# hash before anything is rotated. The temp directory is removed either way.
#
# The host is never named here. It comes from a private config file outside
# the repo (default below), one `Key = value` per line:
#
#   SshTarget    = <ssh config alias, or user@host>
#   IdentityFile = C:\Users\<you>\.ssh\<key>        (optional with an alias)
#   RemoteDir    = /var/backups/neoxify             (optional)
#   Dest         = D:\somewhere\db-backups          (optional)
#
# Keeps the newest copy of each of the last 7 days that have one, plus the
# newest of each of the 4 ISO weeks before those. Writes a log next to the
# copies. Exits 0 on success, 1 on any failure (nothing is rotated then),
# and 1 when the host's newest backup is older than -MaxAgeHours (a dead
# nightly; the verified copy is kept and rotated as usual).
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File pull-offbox-backup.ps1
#   ... -ConfigFile <file> -Dest <dir>
#
# Run it after the host's 03:00 backup has finished (03:15 UTC or later).
# Registering it as a scheduled task is a separate, deliberate step; see
# docs/backup-restore.md.
[CmdletBinding()]
param(
  [string]$ConfigFile = (Join-Path $env:USERPROFILE 'Claude\neoxify-private\offbox-backup.conf'),
  [string]$Dest,
  [int]$KeepDaily = 7,
  [int]$KeepWeekly = 4,
  [int]$MinAgeMinutes = 10,
  # The host's newest finished backup older than this means its nightly has
  # stopped: the copy is still pulled and kept, but the run exits 1, so a
  # dead nightly cannot hide behind "already have it".
  [int]$MaxAgeHours = 30
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

$script:LogFile = $null
function Write-Log([string]$msg) {
  $line = '{0} {1}' -f (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'), $msg
  Write-Output $line
  if ($script:LogFile) { Add-Content -LiteralPath $script:LogFile -Value $line -Encoding UTF8 }
}

function Read-Config([string]$path) {
  $cfg = @{}
  if (-not (Test-Path -LiteralPath $path)) { throw "config file not found: $path" }
  foreach ($raw in Get-Content -LiteralPath $path) {
    $l = $raw.Trim()
    if ($l -eq '' -or $l.StartsWith('#')) { continue }
    $i = $l.IndexOf('=')
    if ($i -lt 1) { throw "bad config line (want Key = value): $l" }
    $cfg[$l.Substring(0, $i).Trim()] = $l.Substring($i + 1).Trim()
  }
  return $cfg
}

# Runs a bash script on the host. The script travels base64-encoded inside
# a single argument, so no quoting survives or breaks on the way through
# PowerShell 5.1's native-argument handling.
function Invoke-Remote([string[]]$sshBase, [string]$body) {
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($body -replace "`r", '')))
  # stderr is merged so the script's own `ERR ...` reasons reach the log.
  # Under 'Stop', PS 5.1 would turn any stderr line into a terminating
  # NativeCommandError, so this one call runs under 'Continue'. Only ERR
  # lines are kept: ssh's own errors can name the host.
  $eap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $all = @(& ssh.exe @sshBase "echo $b64 | base64 -d | bash -s" 2>&1); $code = $LASTEXITCODE }
  finally { $ErrorActionPreference = $eap }
  $out = @($all | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] } | ForEach-Object { "$_" })
  $err = @($all | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] } | ForEach-Object { "$_" } | Where-Object { $_ -like 'ERR *' })
  if ($code -ne 0) { throw ("remote step failed (ssh exit {0}){1}" -f $code, $(if ($err.Count) { ': ' + ($err -join '; ') } else { '' })) }
  return $out
}

$exit = 1
$stage = $null
$sshBase = $null
try {
  $cfg = Read-Config $ConfigFile
  if (-not $cfg.ContainsKey('SshTarget')) { throw "SshTarget missing from $ConfigFile" }
  if (-not $Dest) { $Dest = if ($cfg.ContainsKey('Dest')) { $cfg['Dest'] } else { Join-Path $env:USERPROFILE 'Claude\neoxify-private\db-backups' } }
  $remoteDir = if ($cfg.ContainsKey('RemoteDir')) { $cfg['RemoteDir'] } else { '/var/backups/neoxify' }
  if ($remoteDir -notmatch '^/[A-Za-z0-9._/-]+$') { throw "RemoteDir has unexpected characters" }

  New-Item -ItemType Directory -Force -Path $Dest | Out-Null
  $script:LogFile = Join-Path $Dest 'offbox-pull.log'
  Write-Log "start: dest=$Dest"

  $sshBase = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=30')
  if ($cfg.ContainsKey('IdentityFile')) { $sshBase += @('-i', $cfg['IdentityFile'], '-o', 'IdentitiesOnly=yes') }
  $sshOpts = $sshBase
  $sshBase = $sshBase + @($cfg['SshTarget'])

  # 1. On the host: newest tarball at least MinAgeMinutes old (so a backup
  #    still being written is never taken), gzip -t, database.dump only.
  $remote = @"
set -euo pipefail
umask 077
T=`$(find '$remoteDir' -maxdepth 1 -name 'neoxify-backup-*.tar.gz' -type f -mmin +$MinAgeMinutes -printf '%T@ %p\n' | sort -rn | head -1 | cut -d' ' -f2-)
[ -n "`$T" ] || { echo 'ERR no finished backup found' >&2; exit 3; }
gzip -t "`$T"
D=`$(mktemp -d /root/offbox-stage.XXXXXX)
OK=0
trap '[ "`$OK" = 1 ] || rm -rf -- "`$D"' EXIT
echo "STAGE `$D"
B=`$(basename "`$T" .tar.gz).database.dump
tar -xzf "`$T" -C "`$D" ./database.dump
mv "`$D/database.dump" "`$D/`$B"
[ "`$(head -c 5 "`$D/`$B")" = PGDMP ] || { echo 'ERR not a pg_dump custom archive' >&2; exit 4; }
docker exec -i neoxify-postgres-1 pg_restore -f /dev/null < "`$D/`$B"
echo "NAME `$B"
echo "AGE `$(( `$(date +%s) - `$(stat -c%Y "`$T") ))"
echo "SIZE `$(stat -c%s "`$D/`$B")"
echo "SHA256 `$(sha256sum "`$D/`$B" | cut -c1-64)"
OK=1
"@
  $lines = Invoke-Remote $sshBase $remote
  $info = @{}
  foreach ($l in $lines) { $p = "$l".Split(' ', 2); if ($p.Count -eq 2) { $info[$p[0]] = $p[1].Trim() } }
  if ($info.ContainsKey('STAGE')) { $stage = $info['STAGE'] }
  foreach ($k in 'STAGE', 'NAME', 'SIZE', 'SHA256', 'AGE') { if (-not $info.ContainsKey($k)) { throw "host did not report $k" } }
  if ($stage -notmatch '^/root/offbox-stage\.[A-Za-z0-9]{6}$') { throw "unexpected stage path" }
  if ($info['NAME'] -notmatch '^neoxify-backup-\d{8}-\d{6}\.database\.dump$') { throw "unexpected file name" }
  Write-Log ("host: {0} {1} bytes sha256 {2}; gzip -t and pg_restore full read ok" -f $info['NAME'], $info['SIZE'], $info['SHA256'])

  $final = Join-Path $Dest $info['NAME']
  if ((Test-Path -LiteralPath $final) -and ((Get-FileHash -LiteralPath $final -Algorithm SHA256).Hash -eq $info['SHA256'].ToUpper())) {
    Write-Log "already have $($info['NAME']) with the same hash; not pulling again"
  } else {
    # 2. Copy to a .partial name, verify, then rename into place.
    # Leftovers of any earlier interrupted copy (PC shut down mid-scp) go
    # too; they never count as backups, but each is a full dump's size.
    $partial = "$final.partial"
    Get-ChildItem -LiteralPath $Dest -Filter 'neoxify-backup-*.database.dump.partial' -File | Remove-Item -Force
    $src = '{0}:{1}/{2}' -f $cfg['SshTarget'], $stage, $info['NAME']
    & scp.exe -q @sshOpts $src $partial
    if ($LASTEXITCODE -ne 0) { throw "scp failed (exit $LASTEXITCODE)" }
    $len = (Get-Item -LiteralPath $partial).Length
    $hash = (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash
    if ("$len" -ne $info['SIZE'] -or $hash -ne $info['SHA256'].ToUpper()) {
      Remove-Item -LiteralPath $partial -Force
      throw "verification failed: local $len bytes $hash"
    }
    Move-Item -LiteralPath $partial -Destination $final -Force
    Write-Log "pulled and verified: $final ($len bytes, sha256 matches host)"
  }

  # 3. Rotation, only after a verified copy is in place.
  $files = @(Get-ChildItem -LiteralPath $Dest -Filter 'neoxify-backup-*.database.dump' -File | ForEach-Object {
    if ($_.Name -match '^neoxify-backup-(\d{8})-(\d{6})\.database\.dump$') {
      $t = [datetime]::ParseExact($Matches[1] + $Matches[2], 'yyyyMMddHHmmss', [Globalization.CultureInfo]::InvariantCulture)
      [pscustomobject]@{ File = $_; Time = $t; Day = $t.Date; Week = $t.Date.AddDays(-(([int]$t.DayOfWeek + 6) % 7)) }
    }
  } | Sort-Object Time -Descending)
  $keep = @{}
  $days = @($files | Group-Object Day | Sort-Object { $_.Group[0].Time } -Descending | Select-Object -First $KeepDaily)
  foreach ($g in $days) { $keep[$g.Group[0].File.FullName] = $true }
  if ($days.Count -gt 0) {
    $oldestDay = ($days | Select-Object -Last 1).Group[0].Day
    $weeks = @($files | Where-Object { $_.Day -lt $oldestDay } | Group-Object Week | Sort-Object { $_.Group[0].Time } -Descending | Select-Object -First $KeepWeekly)
    foreach ($g in $weeks) { $keep[$g.Group[0].File.FullName] = $true }
  }
  foreach ($f in $files) {
    if (-not $keep.ContainsKey($f.File.FullName)) {
      Remove-Item -LiteralPath $f.File.FullName -Force
      Write-Log "rotated out: $($f.File.Name)"
    }
  }
  Write-Log ("done: {0} copies kept" -f $keep.Count)
  $ageH = [math]::Round([double]$info['AGE'] / 3600, 1)
  if ($ageH -gt $MaxAgeHours) { throw "host's newest finished backup is $ageH h old (limit $MaxAgeHours h): its nightly backup has stopped" }
  $exit = 0
} catch {
  Write-Log "FAILED: $($_.Exception.Message)"
} finally {
  if ($stage -and $sshBase -and $stage -match '^/root/offbox-stage\.[A-Za-z0-9]{6}$') {
    try { Invoke-Remote $sshBase "rm -rf -- '$stage'" | Out-Null; Write-Log "removed host temp dir" }
    catch { Write-Log "WARNING: could not remove host temp dir $stage"; $exit = 1 }
  }
}
exit $exit
