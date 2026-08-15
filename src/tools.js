import { spawn } from "node:child_process";

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

function runPwsh(script, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PWSH_PATH || "pwsh", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "-"
    ], { stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let killedForSize = false;

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("PowerShell analysis timed out."));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) {
        killedForSize = true;
        child.kill("SIGKILL");
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (Buffer.byteLength(stderr, "utf8") > MAX_OUTPUT_BYTES) {
        killedForSize = true;
        child.kill("SIGKILL");
      }
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (killedForSize) {
        reject(new Error("PowerShell output exceeded the allowed size."));
        return;
      }
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(stderr.trim() || `PowerShell exited with code ${code}.`));
        return;
      }
      resolve({ stdout, stderr, code });
    });

    child.stdin.end(script);
  });
}

function encodeScript(script) {
  return Buffer.from(script, "utf8").toString("base64");
}

export async function getHealth() {
  try {
    const probe = `
$analyzer = [bool](Get-Module -ListAvailable -Name PSScriptAnalyzer | Select-Object -First 1)
[pscustomobject]@{
  ok = $true
  powershell = $PSVersionTable.PSEdition
  version = $PSVersionTable.PSVersion.ToString()
  psscriptAnalyzerAvailable = $analyzer
} | ConvertTo-Json -Compress
`;
    const { stdout } = await runPwsh(probe, 5000);
    return JSON.parse(stdout.trim());
  } catch {
    return {
      ok: false,
      powershell: "",
      version: "",
      psscriptAnalyzerAvailable: false
    };
  }
}

export async function analyzePowerShell(source, includeScriptAnalyzer = true) {
  const encoded = encodeScript(source);
  const ps = `
$ErrorActionPreference = 'Stop'
$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))

$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput(
  $source,
  [ref]$tokens,
  [ref]$parseErrors
)

$commands = @(
  $ast.FindAll(
    { param($n) $n -is [System.Management.Automation.Language.CommandAst] },
    $true
  ) |
  ForEach-Object { $_.GetCommandName() } |
  Where-Object { $_ } |
  Sort-Object -Unique
)

$functions = @(
  $ast.FindAll(
    { param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] },
    $true
  ) |
  ForEach-Object { $_.Name } |
  Sort-Object -Unique
)

$variables = @(
  $ast.FindAll(
    { param($n) $n -is [System.Management.Automation.Language.VariableExpressionAst] },
    $true
  ) |
  ForEach-Object { $_.VariablePath.UserPath } |
  Where-Object { $_ -and $_ -notmatch '^(true|false|null|_|args|input|this|PSItem)$' } |
  Sort-Object -Unique
)

$risky = [System.Collections.Generic.List[object]]::new()

$ast.FindAll(
  { param($n) $n -is [System.Management.Automation.Language.CommandAst] },
  $true
) | ForEach-Object {
  $name = $_.GetCommandName()
  if ($name -in @('Invoke-Expression','iex')) {
    $risky.Add([pscustomobject]@{
      kind = 'DynamicExecution'
      message = 'Invoke-Expression can execute dynamically constructed code. Prefer direct invocation or the call operator when possible.'
      line = $_.Extent.StartLineNumber
    })
  }
  elseif ($name -in @('Remove-Item','Clear-Content','Format-Volume','Stop-Computer','Restart-Computer')) {
    $risky.Add([pscustomobject]@{
      kind = 'PotentiallyDestructiveCommand'
      message = "Command '$name' can change or remove system state. Review parameters and confirmation behavior."
      line = $_.Extent.StartLineNumber
    })
  }
  elseif ($name -in @('Invoke-WebRequest','Invoke-RestMethod')) {
    $risky.Add([pscustomobject]@{
      kind = 'NetworkAccess'
      message = "Command '$name' performs network access. Validate destinations and avoid exposing secrets."
      line = $_.Extent.StartLineNumber
    })
  }
}

$analyzerAvailable = $false
$analyzerFindings = @()

if (${includeScriptAnalyzer ? "$true" : "$false"}) {
  $module = Get-Module -ListAvailable -Name PSScriptAnalyzer | Select-Object -First 1
  if ($module) {
    Import-Module PSScriptAnalyzer -ErrorAction Stop
    $analyzerAvailable = $true
    $analyzerFindings = @(
      Invoke-ScriptAnalyzer -ScriptDefinition $source |
      ForEach-Object {
        [pscustomobject]@{
          ruleName = [string]$_.RuleName
          severity = [string]$_.Severity
          message = [string]$_.Message
          line = [int]$_.Line
          column = [int]$_.Column
        }
      }
    )
  }
}

$result = [pscustomobject]@{
  ok = $true
  parser = "PowerShell AST $($PSVersionTable.PSVersion)"
  syntaxErrors = @(
    $parseErrors | ForEach-Object {
      [pscustomobject]@{
        message = [string]$_.Message
        errorId = [string]$_.ErrorId
        startLine = [int]$_.Extent.StartLineNumber
        startColumn = [int]$_.Extent.StartColumnNumber
        endLine = [int]$_.Extent.EndLineNumber
        endColumn = [int]$_.Extent.EndColumnNumber
      }
    }
  )
  commands = @($commands)
  functions = @($functions)
  variables = @($variables)
  riskyConstructs = @($risky)
  analyzerAvailable = [bool]$analyzerAvailable
  analyzerFindings = @($analyzerFindings)
}

$result | ConvertTo-Json -Depth 8 -Compress
`;
  const { stdout } = await runPwsh(ps);
  return JSON.parse(stdout.trim());
}

export async function createPesterSkeleton(source) {
  const analysis = await analyzePowerShell(source, false);
  const functions = analysis.functions;

  if (!functions.length) {
    return {
      functions: [],
      pester: "# No function definitions were found in the supplied script."
    };
  }

  const blocks = functions.map((name) => `Describe '${name}' {
    It 'has a test case' {
        # Arrange

        # Act
        # $result = ${name}

        # Assert
        # $result | Should -Be $expected
        Set-ItResult -Skipped -Because 'Replace this scaffold with a real test.'
    }
}`).join("\n\n");

  return {
    functions,
    pester: `# Requires -Modules Pester\n\n${blocks}\n`
  };
}

export function inspectPowerShellError(errorText) {
  const text = String(errorText);

  const commandMatch =
    text.match(/At .*?\\([^\\:\r\n]+\.ps1):\d+/i) ||
    text.match(/(?:CommandNotFoundException|ObjectNotFound):\s*\(([^:)]+)/i);

  const fqidMatch = text.match(/FullyQualifiedErrorId\s*:\s*([^\r\n]+)/i);
  const categoryMatch = text.match(/CategoryInfo\s*:\s*([^\r\n]+)/i);
  const exceptionMatch =
    text.match(/([A-Za-z0-9_.]+Exception)\b/) ||
    text.match(/Exception\s*:\s*([^\r\n]+)/i);

  let category = "Unclassified";
  if (/CommandNotFoundException/i.test(text)) category = "CommandNotFound";
  else if (/ParameterBinding/i.test(text)) category = "ParameterBinding";
  else if (/UnauthorizedAccess|AccessDenied|permission|forbidden/i.test(text)) category = "Authorization";
  else if (/ParserError|Unexpected token|Missing .*? terminator/i.test(text)) category = "Parser";
  else if (/ItemNotFound|PathNotFound/i.test(text)) category = "PathOrItemNotFound";
  else if (/WebException|HttpRequestException|status code|404|401|403|429|5\d\d/i.test(text)) category = "NetworkOrAPI";

  const clues = [];
  if (/not recognized as the name of a cmdlet/i.test(text)) {
    clues.push("The command may be misspelled, unavailable in the current session, or provided by a module that is not installed/imported.");
  }
  if (/cannot bind parameter/i.test(text)) {
    clues.push("A parameter value does not match the target parameter type or accepted pipeline binding.");
  }
  if (/running scripts is disabled/i.test(text)) {
    clues.push("PowerShell execution policy is blocking script execution.");
  }
  if (/401|unauthorized/i.test(text)) {
    clues.push("Authentication failed or the credential/token is missing, expired, or invalid.");
  }
  if (/403|forbidden|access denied/i.test(text)) {
    clues.push("The caller is authenticated but may lack required authorization.");
  }
  if (/429|too many requests/i.test(text)) {
    clues.push("The remote service is throttling requests; retry/backoff may be required.");
  }

  return {
    category,
    command: commandMatch?.[1] || "",
    exceptionType: exceptionMatch?.[1] || "",
    fullyQualifiedErrorId: fqidMatch?.[1]?.trim() || "",
    clues: categoryMatch ? [categoryMatch[1].trim(), ...clues] : clues
  };
}
