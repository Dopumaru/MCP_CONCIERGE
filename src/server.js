// src/server.js
try { require("dotenv").config(); } catch {}

const express = require("express");
const cors = require("cors");

const app = express();

// CORS bem explícito (inclui Authorization + preflight)
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.options("*", cors());

app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 3000);
const BEARER = process.env.MCP_BEARER_TOKEN || ""; // vazio = sem auth

function isAuthed(req) {
  if (!BEARER) return true;
  const auth = req.headers.authorization || "";
  return auth === `Bearer ${BEARER}`;
}

// ---- Tools (JSON Schema) ----
const tools = {
  ping: {
    description: "Retorna pong (teste de integração)",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      additionalProperties: false,
    },
    handler: async (args = {}) => {
      const msg = typeof args.message === "string" ? args.message : "";
      return {
        content: [{ type: "text", text: `pong${msg ? `: ${msg}` : ""}` }],
      };
    },
  },
  time_now: {
    description: "Retorna a hora ISO do servidor",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: async () => ({
      content: [{ type: "text", text: new Date().toISOString() }],
    }),
  },
};

// Health
app.get("/health", (req, res) => res.json({ ok: true }));

// Alias REST (pra debug)
app.get("/tools", (req, res) => {
  if (!isAuthed(req)) return res.status(401).send("Unauthorized");
  res.json(
    Object.entries(tools).map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: t.inputSchema,
    }))
  );
});

// Alias REST (pra debug)
app.post("/call", async (req, res) => {
  if (!isAuthed(req)) return res.status(401).send("Unauthorized");
  try {
    const { name, arguments: args } = req.body || {};
    const tool = tools[name];
    if (!tool) return res.status(404).json({ ok: false, error: "Tool not found" });
    const result = await tool.handler(args || {});
    res.json({ ok: true, result });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

async function handleMcpRpc(req, res) {
  if (!isAuthed(req)) {
    return res.status(401).json({
      jsonrpc: "2.0",
      id: req.body?.id ?? null,
      error: { message: "Unauthorized" },
    });
  }

  const { method, params, id } = req.body || {};
  const rpcId = id ?? null;

  try {
    if (method === "tools/list") {
      return res.json({
        jsonrpc: "2.0",
        id: rpcId,
        result: {
          tools: Object.entries(tools).map(([name, t]) => ({
            name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        },
      });
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const args = params?.arguments || {};
      const tool = tools[toolName];

      if (!tool) {
        return res.json({
          jsonrpc: "2.0",
          id: rpcId,
          error: { message: "Tool not found" },
        });
      }

      const result = await tool.handler(args);

      return res.json({
        jsonrpc: "2.0",
        id: rpcId,
        result,
      });
    }

    if (method === "initialize") {
      return res.json({
        jsonrpc: "2.0",
        id: rpcId,
        result: { serverInfo: { name: "mcp-concierge", version: "1.0.0" } },
      });
    }

    return res.json({
      jsonrpc: "2.0",
      id: rpcId,
      error: { message: "Method not found" },
    });
  } catch (e) {
    return res.status(400).json({
      jsonrpc: "2.0",
      id: rpcId,
      error: { message: String(e?.message || e) },
    });
  }
}

// ✅ aceita tanto /mcp quanto / (muitos clientes usam root)
app.post("/mcp", handleMcpRpc);
app.post("/", handleMcpRpc);

// só pra browser
app.get("/mcp", (req, res) => res.status(200).send("OK. Use POST /mcp (JSON-RPC)."));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MCP server on 0.0.0.0:${PORT}`);

  // Compatibilidade DigoChat
app.post("/list-tools", (req, res) => {
  if (!isAuthed(req)) return res.status(401).json({ status: "error", error: "Unauthorized" });

  res.json({
    status: "success",
    tools: Object.entries(tools).map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: t.inputSchema
    }))
  });
});

app.post("/mcp/list-tools", (req, res) => {
  if (!isAuthed(req)) return res.status(401).json({ status: "error", error: "Unauthorized" });

  res.json({
    status: "success",
    tools: Object.entries(tools).map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: t.inputSchema
    }))
  });
});

