// src/server.js
try { require("dotenv").config(); } catch {}

const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 3000);
const BEARER = process.env.MCP_BEARER_TOKEN || "";

function isAuthed(req) {
  if (!BEARER) return true;
  const auth = req.headers.authorization || "";
  return auth === `Bearer ${BEARER}`;
}

// ---- Tools ----
const tools = {
  ping: {
    description: "Retorna pong",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      additionalProperties: false,
    },
    handler: async (args = {}) => ({
      content: [{ type: "text", text: `pong${args.message || ""}` }],
    }),
  },
  time_now: {
    description: "Hora atual ISO",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => ({
      content: [{ type: "text", text: new Date().toISOString() }],
    }),
  },
};

// Health
app.get("/health", (req, res) => res.json({ ok: true }));

// -----------------------------
// 🔥 SSE ENDPOINT (DigoChat)
// -----------------------------
app.get("/mcp", (req, res) => {
  if (!isAuthed(req)) return res.status(401).end();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // envia lista de tools automaticamente
  const payload = {
    type: "tools",
    tools: Object.entries(tools).map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  };

  res.write(`data: ${JSON.stringify(payload)}\n\n`);
});

// -----------------------------
// JSON-RPC fallback
// -----------------------------
app.post("/mcp", async (req, res) => {
  if (!isAuthed(req)) {
    return res.status(401).json({
      jsonrpc: "2.0",
      id: req.body?.id ?? null,
      error: { message: "Unauthorized" },
    });
  }

  const { method, params, id } = req.body || {};

  if (method === "tools/list") {
    return res.json({
      jsonrpc: "2.0",
      id,
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
    const tool = tools[params?.name];
    if (!tool) {
      return res.json({
        jsonrpc: "2.0",
        id,
        error: { message: "Tool not found" },
      });
    }

    const result = await tool.handler(params?.arguments || {});
    return res.json({ jsonrpc: "2.0", id, result });
  }

  res.json({
    jsonrpc: "2.0",
    id,
    error: { message: "Method not found" },
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MCP server running on port ${PORT}`);
});
