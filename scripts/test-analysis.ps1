param(
    [string]$BaseUrl = "http://localhost:8787"
)

$health = Invoke-RestMethod "$BaseUrl/health"
$health | Format-List

if (-not $health.ok) {
    throw "PSSage health check failed. Ensure pwsh is available to the Node server."
}
