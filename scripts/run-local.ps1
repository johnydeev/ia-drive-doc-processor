$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location (Split-Path -Parent $root)

$commands = @(
  @{ Name = "dev"; Command = "npm run dev" },
  @{ Name = "schedule"; Command = "npm run schedule" },
  @{ Name = "worker"; Command = "npm run worker" }
)

foreach ($cmd in $commands) {
  Start-Process -FilePath "powershell" -ArgumentList "-NoExit", "-Command", "cd '$pwd'; $($cmd.Command)"
}
