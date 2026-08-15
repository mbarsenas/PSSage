import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  analyzePowerShell,
  createPesterSkeleton,
  inspectPowerShellError,
  getHealth
} from "./tools.js";

const PORT = Number(process.env.PORT || 8787);

function buildServer() {
  const server = new McpServer(
    {
      name: "pssage",
      version: "0.1.1"
    },
    {
      instructions:
        "PSSage provides deterministic PowerShell parsing and static analysis. Use analyze_powershell before diagnosing or refactoring a script. Never claim that code was executed on the user's computer. Generated test scaffolds are suggestions and should be reviewed before use."
    }
  );

  server.registerTool(
    "analyze_powershell",
    {
      title: "Analyze PowerShell",
      description:
        "Parse PowerShell source code with the PowerShell AST and return syntax errors, commands, functions, variables, risky constructs, and optional PSScriptAnalyzer findings. Use this when the user asks to debug, review, validate, modernize, or understand a PowerShell script.",
      inputSchema: {
        script: z.string().min(1).max(200000).describe("PowerShell source code to analyze."),
        includeScriptAnalyzer: z.boolean().optional().default(true).describe("Run PSScriptAnalyzer when available.")
      },
      outputSchema: {
        ok: z.boolean(),
        parser: z.string(),
        syntaxErrors: z.array(z.object({
          message: z.string(),
          errorId: z.string(),
          startLine: z.number(),
          startColumn: z.number(),
          endLine: z.number(),
          endColumn: z.number()
        })),
        commands: z.array(z.string()),
        functions: z.array(z.string()),
        variables: z.array(z.string()),
        riskyConstructs: z.array(z.object({
          kind: z.string(),
          message: z.string(),
          line: z.number()
        })),
        analyzerAvailable: z.boolean(),
        analyzerFindings: z.array(z.object({
          ruleName: z.string(),
          severity: z.string(),
          message: z.string(),
          line: z.number(),
          column: z.number()
        }))
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async ({ script, includeScriptAnalyzer = true }) => {
      const result = await analyzePowerShell(script, includeScriptAnalyzer);
      return {
        structuredContent: result,
        content: [
          {
            type: "text",
            text: result.ok
              ? `PowerShell analysis completed. Found ${result.syntaxErrors.length} syntax error(s), ${result.commands.length} command(s), ${result.riskyConstructs.length} risky construct(s), and ${result.analyzerFindings.length} analyzer finding(s).`
              : "PowerShell analysis could not complete."
          }
        ]
      };
    }
  );

  server.registerTool(
    "inspect_powershell_error",
    {
      title: "Inspect PowerShell error",
      description:
        "Normalize a PowerShell error message or error record text and extract likely category, command name, exception type, FullyQualifiedErrorId, and actionable clues. Use this when a user pastes a PowerShell failure and wants help diagnosing it.",
      inputSchema: {
        errorText: z.string().min(1).max(100000).describe("The PowerShell error output to inspect.")
      },
      outputSchema: {
        category: z.string(),
        command: z.string(),
        exceptionType: z.string(),
        fullyQualifiedErrorId: z.string(),
        clues: z.array(z.string())
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async ({ errorText }) => {
      const result = inspectPowerShellError(errorText);
      return {
        structuredContent: result,
        content: [{ type: "text", text: `Normalized PowerShell error as category "${result.category}".` }]
      };
    }
  );

  server.registerTool(
    "create_pester_skeleton",
    {
      title: "Create Pester test skeleton",
      description:
        "Parse PowerShell source and create a Pester 5 test skeleton for the functions declared in the script. Use only when the user asks for tests or test scaffolding.",
      inputSchema: {
        script: z.string().min(1).max(200000).describe("PowerShell source code containing one or more functions.")
      },
      outputSchema: {
        functions: z.array(z.string()),
        pester: z.string()
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async ({ script }) => {
      const result = await createPesterSkeleton(script);
      return {
        structuredContent: result,
        content: [{ type: "text", text: `Created Pester scaffolding for ${result.functions.length} function(s).` }]
      };
    }
  );

  server.registerTool(
    "pssage_health",
    {
      title: "Check PSSage health",
      description:
        "Check whether the PSSage backend can locate PowerShell and PSScriptAnalyzer. Use for troubleshooting the plugin service itself.",
      inputSchema: {},
      outputSchema: {
        ok: z.boolean(),
        powershell: z.string(),
        version: z.string(),
        psscriptAnalyzerAvailable: z.boolean()
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async () => {
      const result = await getHealth();
      const publicResult = {
        ok: Boolean(result.ok),
        powershell: String(result.powershell || ""),
        version: String(result.version || ""),
        psscriptAnalyzerAvailable: Boolean(result.psscriptAnalyzerAvailable)
      };
      return {
        structuredContent: publicResult,
        content: [{ type: "text", text: publicResult.ok ? `PSSage is healthy on PowerShell ${publicResult.version}.` : "PSSage cannot locate PowerShell." }]
      };
    }
  );

  return server;
}

const app = express();
app.use(express.json({ limit: "256kb" }));

app.get("/health", async (_req, res) => {
  try {
    res.json(await getHealth());
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

const transports = new Map();

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];

  try {
    let transport;

    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId);
    } else {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport);
        }
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          transports.delete(transport.sessionId);
        }
      };

      const server = buildServer();
      await server.connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP POST error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null
      });
    }
  }
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) {
    res.status(400).send("Missing or invalid MCP session ID.");
    return;
  }
  await transport.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) {
    res.status(400).send("Missing or invalid MCP session ID.");
    return;
  }
  await transport.handleRequest(req, res);
});

app.listen(PORT, () => {
  console.log(`PSSage MCP server listening on http://localhost:${PORT}/mcp`);
});
