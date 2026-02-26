// src/server.js
try { require("dotenv").config(); } catch {}

const express = require("express");
const cors = require("cors");

const app = express();

// ----- CORS (inclui Authorization + preflight) -----
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.options("*", cors());

// body JSON
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 3000);
const BEARER = process.env.MCP_BEARER_TOKEN || ""; // vazio = sem auth

function isAuthed(req) {
  if (!BEARER) return true;

  const auth = String(req.headers.authorization || "");
  if (auth === `Bearer ${BEARER}`) return true;

  // fallback opcional
  const qToken = String(req.query?.token || "");
  if (qToken && qToken === BEARER) return true;

  const xToken = String(req.headers["x-api-key"] || "");
  if (xToken && xToken === BEARER) return true;

  return false;
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

function listToolsPayload() {
  return Object.entries(tools).map(([name, t]) => ({
    name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

// ---------- SSE helpers ----------
function sseHeaders(res) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // importante em proxy

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (typeof res.flushHeaders === "function") res.flushHeaders();
}

function sseSend(res, event, dataObj) {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(dataObj)}\n\n`);
}

function handleSseListTools(req, res) {
  if (!isAuthed(req)) return res.status(401).end("Unauthorized");

  sseHeaders(res);
  sseSend(res, "tools", { tools: listToolsPayload() });

  const timer = setInterval(() => {
    res.write(`: ping\n\n`);
  }, 15000);

  req.on("close", () => clearInterval(timer));
}

function looksLikeJsonRpc(body) {
  if (!body || typeof body !== "object") return false;
  // JSON-RPC típico tem method e/ou jsonrpc
  return typeof body.method === "string" || body.jsonrpc === "2.0";
}

// ------------------- Rotas básicas -------------------
app.get("/health", (req, res) => res.json({ ok: true }));

// alguns clientes chamam /token antes
app.get("/token", (req, res) => {
  if (!isAuthed(req)) return res.status(401).json({ status: "error", error: "Unauthorized" });
  res.json({ status: "success" });
});
app.post("/token", (req, res) => {
  if (!isAuthed(req)) return res.status(401).json({ status: "error", error: "Unauthorized" });
  res.json({ status: "success" });
});

// ------------------- SSE list-tools (DigoChat) -------------------
app.get("/list-tools", handleSseListTools);
app.post("/list-tools", handleSseListTools);

app.get("/mcp/list-tools", handleSseListTools);
app.post("/mcp/list-tools", handleSseListTools);

// root também pode servir SSE (alguns clientes usam isso)
app.get("/", (req, res) => {
  res.status(200).send("OK. Use /list-tools (SSE) ou POST /mcp (JSON-RPC).");
});
app.post("/", (req, res) => handleSseListTools(req, res));

// ------------------- /mcp: SSE (se NÃO for JSON-RPC), senão JSON-RPC -------------------
app.get("/mcp", (req, res) => handleSseListTools(req, res));

app.post("/mcp", async (req, res) => {
  // se não parece JSON-RPC, tratamos como SSE list-tools (isso evita o erro do DigoChat)
  if (!looksLikeJsonRpc(req.body)) {
    return handleSseListTools(req, res);
  }

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
        result: { tools: listToolsPayload() },
      });
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const args = params?.arguments || {};
      const tool = tools[toolName];

      if (!tool) {
        return res.json({ jsonrpc: "2.0", id: rpcId, error: { message: "Tool not found" } });
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

    return res.json({ jsonrpc: "2.0", id: rpcId, error: { message: "Method not found" } });
  } catch (e) {
    return res.status(400).json({
      jsonrpc: "2.0",
      id: rpcId,
      error: { message: String(e?.message || e) },
    });
  }
});

// debug JSON (sem SSE)
app.get("/tools", (req, res) => {
  if (!isAuthed(req)) return res.status(401).send("Unauthorized");
  res.json(listToolsPayload());
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MCP server on 0.0.0.0:${PORT}`);
  console.log(`Auth: ${BEARER ? "ON (Bearer)" : "OFF"}`);
});
