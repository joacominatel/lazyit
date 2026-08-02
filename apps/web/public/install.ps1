<#
.SYNOPSIS
  lazyit reporting agent installer for Windows (ADR-0074 §6, issue #1144).

.DESCRIPTION
  Served PUBLICLY from your own lazyit instance (same-origin, TLS-fronted). It carries NO secret:
  you pass the Service Account token (infra:report) yourself. It downloads the matching agent
  executable from your instance, installs it under %ProgramFiles%, writes
  C:\ProgramData\lazyit-agent\config with an ACL restricted to SYSTEM + Administrators, and registers
  a Scheduled Task so the host keeps itself current in lazyit's PENDING tray.

  A SCHEDULED TASK, NOT A SERVICE. That preserves the one-shot design of ADR-0074 §7 exactly: the
  agent runs, gathers, POSTs and exits. A service would force a daemon rewrite for zero benefit, and
  the fixed-tick / server-cadence inversion of #1140 was designed so the same semantics hold under
  Task Scheduler as under systemd.

  IT RUNS AS NT AUTHORITY\SYSTEM, never a domain service account. SYSTEM has local WMI/CIM rights
  with NO credential stored anywhere on the host; a domain account would mean a password in a config
  file on every machine in the estate and a standing pen-test finding.

  THE TASK TICKS EVERY 5 MINUTES AND THAT NEVER CHANGES (#1140). It is not the reporting cadence:
  the agent checks whether it is due and exits immediately when it is not. CADENCE is set centrally
  in lazyit (Settings -> Instance -> Reporting agents) and picked up on the next report, so changing
  it never rewrites a task, never needs a reboot and never needs an RDP session.

  UNSIGNED, ON PURPOSE, FOR NOW. The executable this installs is not code-signed, so SmartScreen and
  some AV heuristics will flag it. That is an accepted, DELIBERATE state for internal validation
  inside the organisation that builds lazyit — own domain, own policies, own machines. An OV/EV
  code-signing certificate is an explicit GATE before any third party installs this, not a detail to
  discover later. The code is identical either way; only the signing step differs.

.PARAMETER Url
  Your lazyit instance base URL, e.g. https://lazyit.example.com

.PARAMETER Token
  A Service Account token holding the infra:report permission. Prefer -TokenFile or the
  LAZYIT_TOKEN environment variable: a token passed here is visible in the PowerShell session's
  history and, briefly, to anything reading process arguments.

.PARAMETER TokenFile
  Read the token from a file instead. Mutually exclusive with -Token.

.PARAMETER CaFile
  A PEM bundle to trust instead of trusting your internal CA machine-wide. Used for THIS script's
  downloads and written into the agent's config so the agent uses it too.

.PARAMETER Baseline
  Install the pre-AVX2 x86-64 build. Windows exposes no equivalent of /proc/cpuinfo's flag list, so
  unlike install.sh this cannot be auto-detected — pass it for a pre-Haswell host, or for a cluster
  whose EVC/processor-compatibility baseline masks AVX2 and may live-migrate onto older silicon.

.PARAMETER RequireChecksum
  Fail if this instance publishes no sha256 for the executable.

.PARAMETER Uninstall
  Stop and remove the agent, its task, its state and its token.

.PARAMETER KeepConfig
  With -Uninstall: keep this host's own limits for a later re-install. The token is destroyed either
  way.

.EXAMPLE
  # Run from an ELEVATED PowerShell. The pipe form of `irm | iex` cannot take parameters, so the
  # script block form is the one that works:
  & ([scriptblock]::Create((irm https://lazyit.example.com/install.ps1))) -Url https://lazyit.example.com -Token lzit_sa_xxx

.EXAMPLE
  # Keeping the token out of the session history:
  $env:LAZYIT_TOKEN = 'lzit_sa_xxx'
  .\install.ps1 -Url https://lazyit.example.com

.EXAMPLE
  .\install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [string] $Url,
  [string] $Token,
  [string] $TokenFile,
  [string] $CaFile,
  # Accepted for symmetry with install.sh and IGNORED for the same reason: the reporting cadence is
  # a server-side setting since #1140. Recorded in the config file only so an operator who passed it
  # can see what happened to it.
  [string] $Interval,
  [switch] $Baseline,
  [switch] $RequireChecksum,
  [switch] $Uninstall,
  [switch] $KeepConfig
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# The FIXED tick, matching AGENT_POLICY_TICK_SECONDS. Deliberately not configurable: the whole point
# of #1140 is that the schedule is one unchanging thing on every platform while the cadence is a
# server-side setting.
$TickMinutes = 5
# Per-elapse de-phasing, the RandomizedDelaySec analogue. Hosts that came back from a patch window
# together would otherwise POST a full inventory in the same second and run into the per-token report
# limit (#1134).
$RandomDelay = New-TimeSpan -Seconds 60
# The outer bound on one run, the RuntimeMaxSec analogue. The agent bounds each collector itself
# (#1133), but a child stuck in a kernel wait can outlive a kill; Task Scheduler reaps the job.
$ExecutionTimeLimit = New-TimeSpan -Minutes 5

$TaskName   = 'lazyit-agent'
$InstallDir = Join-Path $env:ProgramFiles 'lazyit-agent'
$BinPath    = Join-Path $InstallDir 'lazyit-agent.exe'
$ConfigDir  = Join-Path $env:ProgramData 'lazyit-agent'
$ConfigFile = Join-Path $ConfigDir 'config'
$StateDir   = Join-Path $ConfigDir 'state'

function Die([string] $Message) {
  Write-Error "lazyit-agent install: $Message"
  exit 1
}

function Say([string] $Message) {
  Write-Host "lazyit-agent install: $Message"
}

# --- elevation -------------------------------------------------------------
# The analogue of install.sh's `id -u` check, and it must run before ANY path below: writing to
# %ProgramFiles%, setting an ACL and registering a task as SYSTEM all need Administrator.
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Die 'must run from an ELEVATED PowerShell (installs to Program Files, sets an ACL and registers a SYSTEM task). Right-click PowerShell -> Run as administrator.'
}

# --- uninstall -------------------------------------------------------------
# "I will not deploy something I can't cleanly remove" is a reasonable position. Everything below is
# idempotent and never fails on a partial install.
if ($Uninstall) {
  # Disarm FIRST. Deleting the executable out from under a registered task does not stop the task; it
  # turns every tick into a failed run and an event-log entry, on a host somebody believes is clean.
  try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop | Out-Null }
  catch { }
  Remove-Item -LiteralPath $BinPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
  # The policy + last-success cache (#1140). Local to the host and meaningless without the agent.
  Remove-Item -LiteralPath $StateDir -Recurse -Force -ErrorAction SilentlyContinue

  # THE TOKEN NEVER SURVIVES AN UNINSTALL. It is a working credential for your instance, and leaving
  # it on a host somebody just decommissioned is the one outcome this path must not have. Revoking
  # the Service Account in lazyit is still the complete answer; this is the half the operator can do
  # from the host.
  #
  # -KeepConfig is for the operator re-imaging a host that will get the agent back: it keeps the
  # LOCAL VETO (LAZYIT_COLLECT_*=false, LAZYIT_MIN_INTERVAL, ...), which is the host owner's setting
  # and is genuinely painful to lose, while still stripping the token and the URL.
  if ($KeepConfig -and (Test-Path -LiteralPath $ConfigFile)) {
    $kept = Get-Content -LiteralPath $ConfigFile | Where-Object { $_ -notmatch '^\s*LAZYIT_(TOKEN|URL)=' }
    [IO.File]::WriteAllLines($ConfigFile, $kept, (New-Object Text.UTF8Encoding($false)))
    Say "kept $ConfigFile without its token or URL (-KeepConfig)."
  }
  else {
    Remove-Item -LiteralPath $ConfigFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $ConfigDir -Recurse -Force -ErrorAction SilentlyContinue
  }

  Say "uninstalled — the executable, the scheduled task, $StateDir and the token are gone."
  Write-Host 'This host stops reporting immediately. Its entry in lazyit is untouched: discard it there if you'
  Write-Host 'want it off the map, and revoke the Service Account token if no other host uses it.'
  exit 0
}

if ($KeepConfig) { Die '-KeepConfig only means something with -Uninstall' }

# --- token -----------------------------------------------------------------
if ($TokenFile) {
  if ($Token) { Die '-Token and -TokenFile are mutually exclusive — pass one' }
  if (-not (Test-Path -LiteralPath $TokenFile)) { Die "cannot read the token file: $TokenFile" }
  $Token = (Get-Content -LiteralPath $TokenFile -Raw).Trim()
  if (-not $Token) { Die 'the token file is empty — nothing to authenticate with' }
  # A Service Account token is one opaque word. Anything with whitespace in it is not one, and saying
  # which mistake it is costs one test.
  if ($Token -match '\s') { Die "what was read from $TokenFile is not a token (it contains whitespace)." }
}
# The environment is the third safe form: not in the session history.
if (-not $Token) { $Token = $env:LAZYIT_TOKEN }
if (-not $Url)   { $Url   = $env:LAZYIT_URL }

if (-not $Url)   { Die '-Url is required (your lazyit instance, e.g. https://lazyit.example.com)' }
if (-not $Token) { Die 'a token is required — pass -Token, -TokenFile, or set $env:LAZYIT_TOKEN (needs infra:report)' }
$Url = $Url.TrimEnd('/')

# TLS 1.2 explicitly. Windows PowerShell 5.1 defaults its ServicePointManager to SSL3/TLS1.0 on
# older builds, which a modern Caddy front refuses — the symptom is an opaque "underlying connection
# was closed" that reads like a certificate problem and is not.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# --- the private CA, if there is one ---------------------------------------
if ($CaFile) {
  if (-not (Test-Path -LiteralPath $CaFile)) { Die "cannot read -CaFile: $CaFile" }
  $CaFile = (Resolve-Path -LiteralPath $CaFile).Path
}

# --- arch ------------------------------------------------------------------
# There is no bun-windows-arm64 target, so an ARM64 host has no artifact and saying so plainly beats
# downloading an x64 executable that WOW64 might or might not emulate acceptably.
$machine = $env:PROCESSOR_ARCHITECTURE
if ($machine -ne 'AMD64') {
  Die "unsupported architecture: $machine (only x64 Windows is built; there is no ARM64 target)"
}
$arch = if ($Baseline) { 'x64-baseline' } else { 'x64' }

# --- download the executable (token-gated) ---------------------------------
Say "downloading agent (windows/$arch) from $Url ..."
$tmpBin = Join-Path ([IO.Path]::GetTempPath()) ("lazyit-agent-" + [guid]::NewGuid().ToString('N') + '.exe')
$headers = @{ Authorization = "Bearer $Token" }

#
# -CaFile AND THIS DOWNLOAD: what it does and what it does not. On Linux, `--ca-file` is passed to
# curl for the installer's own download AND written into the config for the agent. On Windows only
# the SECOND half happens: `Invoke-WebRequest` validates against the machine's certificate stores and
# offers no per-request CA bundle. So an instance behind a private CA needs that CA in the Local
# Machine "Trusted Root Certification Authorities" store for THIS SCRIPT to download — which on
# Windows is the ordinary way to do it and what Group Policy already pushes — while the AGENT still
# uses the bundle explicitly, machine trust untouched. Stated rather than glossed: an installer that
# quietly did less than its Linux sibling would be found out on a LAN instance, at install time.
function Invoke-LazyitDownload([string] $Path, [string] $OutFile) {
  $request = @{
    Uri             = "$Url$Path"
    Headers         = $headers
    # A 3xx must be a hard failure, not a followed redirect (issue #980): if -Url points at an origin
    # with no /api routing, the request 302s to /login and we must not save that HTML as an
    # executable. -MaximumRedirection 0 makes PowerShell throw on the redirect.
    MaximumRedirection = 0
    UseBasicParsing = $true
    ErrorAction     = 'Stop'
  }
  if ($OutFile) { $request.OutFile = $OutFile }
  Invoke-WebRequest @request
}

try {
  Invoke-LazyitDownload "/api/agent/download?os=windows&arch=$arch" $tmpBin | Out-Null
}
catch {
  if ($arch -eq 'x64-baseline') {
    # Deliberately NOT falling back to the ordinary x64 build. The baseline build was chosen because
    # -Baseline said so, and the x64 build would take an illegal-instruction fault on such a host —
    # trading a clear install error now for a crash later is a bad trade.
    Die 'download failed for the baseline x86-64 build, and this installer will not substitute the ordinary x64 build (it needs AVX2 and would crash on a host that asked for baseline). An instance that predates the Windows artifact does not carry it: upgrade lazyit, then re-run.'
  }
  Die "download failed — check the URL, the token (needs infra:report), and that the Windows binary is bundled in this build. $($_.Exception.Message)"
}
if (-not (Test-Path -LiteralPath $tmpBin) -or (Get-Item -LiteralPath $tmpBin).Length -eq 0) {
  Die 'downloaded an empty file — aborting'
}

# Belt-and-braces: require the download to actually be a Windows PE executable (magic 4D 5A, 'MZ')
# before installing and registering a task. This is the ELF-magic check of install.sh, one platform
# over: it catches anything that arrived as a 200 but is an HTML or JSON error page.
# Two bytes off the front, not the whole file: the artifact is ~100 MB and ReadAllBytes would put
# all of it in memory to look at the header.
$magic = New-Object byte[] 2
$stream = [IO.File]::OpenRead($tmpBin)
try { $null = $stream.Read($magic, 0, 2) } finally { $stream.Dispose() }
if ($magic[0] -ne 0x4D -or $magic[1] -ne 0x5A) {
  Remove-Item -LiteralPath $tmpBin -Force -ErrorAction SilentlyContinue
  Die 'downloaded file is not a Windows executable (no MZ header) — is -Url your lazyit HTTPS origin (the reverse proxy), not the raw web port :3000?'
}

# --- integrity: the digest the instance published --------------------------
# TLS plus two bytes of PE magic answers "did the bytes arrive intact from the origin I dialled". It
# does not answer "are these the bytes the build produced" — and this file becomes SYSTEM on every
# host in the estate. STATED HONESTLY: this is a checksum, not a signature. Anyone who can write both
# files in the API container defeats it, and it is not meant to survive that.
$expected = ''
try {
  $response = Invoke-LazyitDownload "/api/agent/checksum?os=windows&arch=$arch" $null
  $expected = ($response.Content | Out-String).Trim()
}
catch { $expected = '' }
if ($expected -notmatch '^[0-9a-f]{64}$') { $expected = '' }

if ($expected) {
  $actual = (Get-FileHash -LiteralPath $tmpBin -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) {
    Remove-Item -LiteralPath $tmpBin -Force -ErrorAction SilentlyContinue
    Die "checksum mismatch — the executable this instance served is not the one it published a digest for (expected $expected, got $actual). Nothing installed. Re-run; if it persists, treat the instance as suspect."
  }
  Say 'sha256 verified.'
}
elseif ($RequireChecksum) {
  Remove-Item -LiteralPath $tmpBin -Force -ErrorAction SilentlyContinue
  Die "-RequireChecksum was passed but this instance published no sha256 for windows/$arch (an instance older than this installer does not)"
}
else {
  Write-Warning "lazyit-agent install: this instance published no sha256 for the executable, so TLS and the MZ check are the only integrity check. Pass -RequireChecksum to make this fatal."
}

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
Move-Item -LiteralPath $tmpBin -Destination $BinPath -Force

# --- can this host actually RUN it? ----------------------------------------
# `--help` prints and exits: no network, no config, no state. It fails exactly when the host cannot
# start the executable — an unsupported build, a missing OS component, or (the common one on Windows)
# an AV product that quarantined an UNSIGNED binary between the download and now.
#
# This runs BEFORE the task is registered, because the alternative is the failure mode it replaces: a
# host that LOOKS installed, has a task armed, and silently never reports.
$startable = $false
try {
  & $BinPath --help > $null 2>&1
  $startable = ($LASTEXITCODE -eq 0)
}
catch { $startable = $false }
if (-not $startable) {
  Remove-Item -LiteralPath $BinPath -Force -ErrorAction SilentlyContinue
  Die "the agent executable will not start on this host. The most common cause is antivirus or SmartScreen quarantining it — this build is UNSIGNED (see the Manual). Run '$BinPath --help' by hand to see the message. Nothing has been installed and no task was registered."
}

# --- config (ACL: SYSTEM + Administrators only — it holds the token) -------
New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
New-Item -ItemType Directory -Path $StateDir -Force | Out-Null

# THE `chmod 600` ANALOGUE, and the one place a Windows installer is easiest to get wrong. A fresh
# directory under %ProgramData% inherits an ACE granting Users read access — so a config file holding
# a live Service Account token would be readable by every interactive user on the host. Inheritance
# is DISABLED (not merely edited: an inherited ACE cannot be removed while inheritance is on) and the
# ACL is rebuilt with exactly two principals. The state directory and the config file inherit it.
$acl = Get-Acl -LiteralPath $ConfigDir
$acl.SetAccessRuleProtection($true, $false)   # protect from inheritance, and DISCARD what was inherited
foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRule($rule) | Out-Null }
foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {   # NT AUTHORITY\SYSTEM, BUILTIN\Administrators
  $account = New-Object Security.Principal.SecurityIdentifier($sid)
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
    $account,
    [Security.AccessControl.FileSystemRights]::FullControl,
    [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
    [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Allow)))
}
$acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
Set-Acl -LiteralPath $ConfigDir -AclObject $acl

# CARRY THIS HOST'S OWN SETTINGS ACROSS A RE-INSTALL (#1140). Re-running the installer is the
# documented upgrade path and it rewrites this file — but the file is also the ONLY place the host's
# local VETO lives (LAZYIT_COLLECT_*=false, LAZYIT_MIN_INTERVAL, LAZYIT_SOFTWARE_MAX, LAZYIT_EXCLUDE_*)
# and, since #1137, its proxy and CA. Truncating it would silently re-enable collection the host's
# owner turned off — or cut a proxied host off the network — on the upgrade path, with nothing on
# screen to say so. So everything is carried over EXCEPT the keys the installer owns.
#
# The pattern is deliberately wider than LAZYIT_*: HTTPS_PROXY, HTTP_PROXY and NO_PROXY live here too,
# under the names every other tool uses, and BOTH CASES, because the agent reads both — a pattern that
# matched only the uppercase half would silently delete a working proxy on the upgrade path.
$owned = if ($CaFile) { '^\s*(LAZYIT_(URL|TOKEN|INTERVAL|CA_FILE)|lazyit_ca_file)=' } else { '^\s*LAZYIT_(URL|TOKEN|INTERVAL)=' }
$preserved = @()
if (Test-Path -LiteralPath $ConfigFile) {
  $preserved = Get-Content -LiteralPath $ConfigFile |
    Where-Object { $_ -match '^\s*(LAZYIT_[A-Z0-9_]+|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|lazyit_ca_file)=' } |
    Where-Object { $_ -notmatch $owned }
}

$lines = New-Object Collections.Generic.List[string]
$lines.Add('# lazyit reporting agent config (ADR-0074). Holds your instance URL + SA token.')
$lines.Add('# ACL: SYSTEM + Administrators only. Do not relax it — this file holds a live credential.')
$lines.Add("LAZYIT_URL=$Url")
$lines.Add("LAZYIT_TOKEN=$Token")
if ($CaFile) { $lines.Add("LAZYIT_CA_FILE=$CaFile") }
if ($Interval) {
  $lines.Add("# -Interval $Interval was passed and IGNORED: reporting cadence is set in lazyit")
  $lines.Add('# (Settings -> Instance -> Reporting agents), not here. To make THIS host report LESS often than')
  $lines.Add('# lazyit asks, uncomment LAZYIT_MIN_INTERVAL below — a floor, never a shorter interval.')
}
if ($preserved.Count -gt 0) {
  $lines.Add("# --- kept from this host's previous config (its own limits — the installer does not own these) ---")
  foreach ($line in $preserved) { $lines.Add($line) }
  $lines.Add('# --- end kept ---')
}
$lines.Add('#')
$lines.Add('# What this HOST refuses to do, whatever lazyit''s policy says (#1140). These VETO the server''s')
$lines.Add('# policy and can never widen it: a collector switched off here cannot be switched back on remotely.')
$lines.Add('# Uncomment what you need — re-running this installer keeps whatever you set here.')
$lines.Add('#LAZYIT_COLLECT_HARDWARE=false')
$lines.Add('#LAZYIT_COLLECT_DISKS=false')
$lines.Add('#LAZYIT_COLLECT_NICS=false')
$lines.Add('#LAZYIT_COLLECT_SOFTWARE=false')
$lines.Add('#LAZYIT_COLLECT_CONTAINERS=false')
$lines.Add('#LAZYIT_MIN_INTERVAL=3600')
$lines.Add('#LAZYIT_SOFTWARE_MAX=500')
$lines.Add('#LAZYIT_EXCLUDE_NICS=vEthernet*,Loopback*')
$lines.Add('#LAZYIT_EXCLUDE_SOFTWARE=Microsoft Visual C++*')
$lines.Add('#')
$lines.Add('# How this host reaches your instance (#1137). A Scheduled Task running as SYSTEM inherits')
$lines.Add('# SYSTEM''s environment, not the logged-on operator''s, so a proxy set in a user profile does NOT')
$lines.Add('# reach the task — set it here. LAZYIT_CA_FILE is a PEM bundle the AGENT trusts, instead of')
$lines.Add('# trusting your internal CA machine-wide. Kept across a re-install like everything else above.')
$lines.Add('#HTTPS_PROXY=http://proxy.example.com:3128')
$lines.Add('#NO_PROXY=lazyit.example.com,.internal')
$lines.Add('#LAZYIT_CA_FILE=C:\ProgramData\lazyit-agent\internal-root.pem')
# UTF-8 with NO byte-order mark. The agent parses this file as UTF-8, and both obvious alternatives
# are wrong on Windows PowerShell 5.1: `-Encoding UTF8` writes a BOM, which makes the FIRST key of
# the file unparseable, and `-Encoding ASCII` would mangle a non-ASCII proxy host or certificate path.
[IO.File]::WriteAllLines($ConfigFile, $lines, (New-Object Text.UTF8Encoding($false)))

# --- the scheduled task ----------------------------------------------------
# The systemd timer, one platform over. Every piece has a direct counterpart:
#   AtStartup + Delay 2min      <- OnBootSec=2min
#   RepetitionInterval 5min     <- OnUnitActiveSec=5min  (the TICK, not the cadence)
#   RandomDelay 60s             <- RandomizedDelaySec=60s
#   StartWhenAvailable          <- Persistent=true (catch up a tick missed while powered off)
#   ExecutionTimeLimit 5min     <- RuntimeMaxSec=120, one layer out
#   RunLevel Highest + SYSTEM   <- the unit running as root
$action = New-ScheduledTaskAction -Execute $BinPath -Argument 'report --once'
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = 'PT2M'
# A repetition attached to the startup trigger, so ONE trigger both catches a reboot and keeps
# ticking. `RepetitionDuration` of [TimeSpan]::MaxValue is how Task Scheduler spells "indefinitely".
$repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes $TickMinutes) `
  -RepetitionDuration ([TimeSpan]::MaxValue)).Repetition
$trigger.Repetition = $repetition

$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -RandomDelay $RandomDelay `
  -ExecutionTimeLimit $ExecutionTimeLimit `
  -MultipleInstances IgnoreNew `
  -DontStopOnIdleEnd `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries
# A laptop is most of this estate, and a task that will not start on battery would leave every
# roaming endpoint reporting only when it happens to be docked. The run is a few seconds of work at
# idle priority, once per cadence.

$taskPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName $TaskName `
  -Action $action -Trigger $trigger -Settings $settings -Principal $taskPrincipal `
  -Description 'lazyit reporting agent — one-shot inventory report. Ticks every 5 minutes; the REPORTING CADENCE is set centrally in lazyit and enforced by the agent, so this task never has to change.' `
  -Force | Out-Null

# --- one immediate report --------------------------------------------------
# --force, because the agent would otherwise honour the interval it just cached and a re-install
# would print nothing useful. An installer that cannot tell you whether the token works is worse than
# one that reports once more than strictly necessary.
Say 'sending the first report ...'
$reported = $false
try {
  & $BinPath report --once --force
  $reported = ($LASTEXITCODE -eq 0)
}
catch { $reported = $false }
if (-not $reported) {
  Die "the first report failed — check the URL/token; the task is registered and will retry. '$BinPath test' says which part failed."
}

Write-Host ''
Say "done. The task ticks every $TickMinutes minutes; how often this host actually reports is set"
Write-Host 'centrally in lazyit (Settings -> Instance -> Reporting agents) and picked up on the next report.'
Write-Host "This host now appears in lazyit's infra topology PENDING tray — confirm it there to track it as an asset."
Write-Host "Diagnostics: '$BinPath test' checks the URL, token and network; '$BinPath show' prints"
Write-Host 'the report it would send. Removal: re-run this script with -Uninstall.'
