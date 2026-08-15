import { spawn } from "node:child_process";
import fs from "node:fs";

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

function resolvePwshPath() {
  const configured = process.env.PWSH_PATH?.trim();
  if (configured && fs.existsSync(configured)) {
    return configured;
  }

  const candidates = [];

  if (process.platform === "win32") {
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    candidates.push(`${programFiles}\\PowerShell\\7\\pwsh.exe`);

    const windowsApps = `${programFiles}\\WindowsApps`;
    if (fs.existsSync(windowsApps)) {
      try {
        const matches = fs.readdirSync(windowsApps)
          .filter((name) => /^Microsoft\.PowerShell_7\.[^_]+_x64__8wekyb3d8bbwe$/i.test(name))
          .sort()
          .reverse();
        for (const match of matches) {
          candidates.push(`${windowsApps}\\${match}\\pwsh.exe`);
        }
      } catch {
        // WindowsApps may not be enumerable depending on permissions.
      }
    }
  }

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return "pwsh";
}

function toEncodedCommand(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function runPwsh(script, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const executable = resolvePwshPath();
    const encodedCommand = toEncodedCommand(script);

    const child = spawn(executable, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-OutputFormat",
      "Text",
      "-EncodedCommand",
      encodedCommand
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let killedForSize = false;

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("PowerShell analysis timed out."));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) {
        killedForSize = true;
        child.kill("SIGKILL");
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (Buffer.byteLength(stderr, "utf8") > MAX_OUTPUT_BYTES) {
        killedForSize = true;
        child.kill("SIGKILL");
      }
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Failed to start PowerShell from '${executable}': ${error.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (killedForSize) {
        reject(new Error("PowerShell output exceeded the allowed size."));
        return;
      }

      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `PowerShell exited with code ${code}.`));
        return;
      }

      resolve({ stdout, stderr, code, executable });
    });
  });
}

function parseJsonFromPowerShell(stdout) {
  const text = String(stdout ?? "").replace(/^\uFEFF/, "").trim();
  if (!text) {
    throw new Error("PowerShell returned empty stdout.");
  }

  try {
    return JSON.parse(text);
  } catch {
    const objectStart = text.indexOf("{");
    const objectEnd = text.lastIndexOf("}");
    if (objectStart >= 0 && objectEnd > objectStart) {
      return JSON.parse(text.slice(objectStart, objectEnd + 1));
    }

    const arrayStart = text.indexOf("[");
    const arrayEnd = text.lastIndexOf("]");
    if (arrayStart >= 0 && arrayEnd > arrayStart) {
      return JSON.parse(text.slice(arrayStart, arrayEnd + 1));
    }

    throw new Error(`PowerShell stdout was not valid JSON. Raw stdout: ${JSON.stringify(text.slice(0, 2000))}`);
  }
}

function encodeScript(script) {
  return Buffer.from(script, "utf8").toString("base64");
}

export async function getHealth() {
  try {
    const probe = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$DebugPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$analyzer = [bool](Get-Module -ListAvailable -Name PSScriptAnalyzer | Select-Object -First 1)
[pscustomobject]@{
  ok = $true
  powershell = $PSVersionTable.PSEdition
  version = $PSVersionTable.PSVersion.ToString()
  psscriptAnalyzerAvailable = $analyzer
} | ConvertTo-Json -Compress | Write-Output
`;
    const { stdout, stderr, executable, code } = await runPwsh(probe, 5000);
    const parsed = parseJsonFromPowerShell(stdout);
    return {
      ...parsed,
      executable,
      diagnostics: {
        exitCode: code,
        stderr: stderr.trim()
      }
    };
  } catch (error) {
    return {
      ok: false,
      powershell: "",
      version: "",
      psscriptAnalyzerAvailable: false,
      executable: resolvePwshPath(),
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function analyzePowerShell(source, includeScriptAnalyzer = true) {
  const encoded = encodeScript(source);
  const ps = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$DebugPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
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

$result | ConvertTo-Json -Depth 8 -Compress | Write-Output
`;
  const { stdout } = await runPwsh(ps);
  return parseJsonFromPowerShell(stdout);
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
