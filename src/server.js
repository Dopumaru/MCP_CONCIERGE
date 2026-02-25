// src/server.js
try { require("dotenv").config(); } catch {}

const express = require("express");
const cors = require("cors");

const app = express();

// CORS explícito (inclui Authorization + preflight)
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept"],
  })
);
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
      return { content: [{ type: "text", text: `pong${msg ? `: ${msg}` : ""}` }] };
    },
  },
  time_now: {
    description: "Retorna a hora ISO do servidor",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => ({
      content: [{ type: "text", text: new Date().toISOString() }],
    }),
  },
};

function listToolsArray() {
  return Object.entries(tools).map(([name, t]) => ({
    name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

// ---------- SSE helpers ----------
function wantsSSE(req) {
  const accept = String(req.headers.accept || "");
  return accept.includes("text/event-stream");
}

function sseHeaders(res) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // evita buffer em proxy
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (typeof res.flushHeaders === "function") res.flushHeaders();
}

function sseSend(res, dataObj) {
  res.write(`data: ${JSON.stringify(dataObj)}\n\n`);
}

function handleListTools(req, res) {
  if (!isAuthed(req)) {
    // DigoChat gosta de JSON
    return res.status(401).json({ status: "error", error: "Unauthorized" });
  }

  // Se alguém pedir SSE, entregamos SSE
  if (wantsSSE(req) && req.method === "GET") {
    sseHeaders(res);

    // payload MCP-ish (mas SSE)
    sseSend(res, { status: "success", tools: listToolsArray() });

    const timer = setInterval(() => {
      res.write(`: ping\n\n`);
    }, 15000);

    req.on("close", () => clearInterval(timer));
    return;
  }

  // Default: JSON normal (isso é o que o DigoChat está tentando consumir via XHR)
  return res.json({ status: "success", tools: listToolsArray() });
}

// Health
app.get("/health", (req, res) => res.json({ ok: true }));

// ✅ DigoChat (XHR)
app.get("/list-tools", handleListTools);
app.post("/list-tools", handleListTools);
app.get("/mcp/list-tools", handleListTools);
app.post("/mcp/list-tools", handleListTools);

// (debug) lista tools
app.get("/tools", (req, res) => {
  if (!isAuthed(req)) return res.status(401).send("Unauthorized");
  res.json(listToolsArray());
});

// ---------- MCP JSON-RPC ----------
app.post("/mcp", async (req, res) => {
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
        result: { tools: listToolsArray() },
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
      return res.json({ jsonrpc: "2.0", id: rpcId, result });
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
});

// root
app.get("/", (req, res) => {
  if (wantsSSE(req)) return handleListTools(req, res);
  res.status(200).send("OK. Use /list-tools (JSON) ou POST /mcp (JSON-RPC).");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MCP server on 0.0.0.0:${PORT}`);
});
