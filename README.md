# PSSage

PSSage is a community-focused ChatGPT plugin backed by an MCP server that gives ChatGPT deterministic PowerShell tooling instead of relying only on language-model guesses.

## V0.1 tools

- `analyze_powershell` — parses a script with PowerShell's AST and optionally runs PSScriptAnalyzer.
- `inspect_powershell_error` — normalizes common PowerShell error output and extracts diagnostic clues.
- `create_pester_skeleton` — discovers PowerShell functions and creates Pester 5 test scaffolding.
- `pssage_health` — verifies that PowerShell and PSScriptAnalyzer are available on the server.

PSSage **does not execute user scripts**. It parses and statically analyzes supplied source code. This is intentional for the first public version.

## Local development

Requirements:

- Node.js 20+
- PowerShell 7 (`pwsh`)
- Optional: `PSScriptAnalyzer`

Install dependencies:

```bash
npm install
```

Optional analyzer:

```powershell
Install-Module PSScriptAnalyzer -Scope CurrentUser
```

Run:

```bash
npm start
```

The MCP endpoint is:

```text
http://localhost:8787/mcp
```

Health endpoint:

```text
http://localhost:8787/health
```

## Test with MCP Inspector

```bash
npx @modelcontextprotocol/inspector@latest
```

Choose **Streamable HTTP** and connect to:

```text
http://localhost:8787/mcp
```

## Connect to ChatGPT during development

ChatGPT requires a publicly reachable HTTPS MCP endpoint.

1. Run PSSage locally.
2. Expose port `8787` with an HTTPS tunnel such as ngrok.
3. In ChatGPT, enable Developer mode.
4. Create a plugin connection using:

```text
https://YOUR-HOST/mcp
```

## Docker

```bash
docker build -t pssage .
docker run --rm -p 8787:8787 pssage
```

## Safety model

Version 0.1 is intentionally read-only:

- no arbitrary script execution
- no local-device control
- no credential collection
- no filesystem writes
- no remote system changes

All public tools are annotated as read-only and non-destructive.

## Suggested starter prompts

- "Use PSSage to analyze this PowerShell script for syntax and quality problems."
- "Use PSSage to inspect this PowerShell error and tell me the likely cause."
- "Use PSSage to create a Pester test skeleton for these functions."
- "Use PSSage to identify risky constructs in this PowerShell script."

## Roadmap

### 0.2
- richer AST metrics
- command/module dependency inventory
- cross-platform compatibility checks
- improved security rules
- test fixtures

### 0.3
- optional UI results card
- script-diff recommendations
- module manifest analysis

### Later
An optional user-installed local bridge may be explored for approved command execution. It is intentionally outside the first public plugin.

## License

MIT
