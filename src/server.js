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

  // padrão: Authorization: Bearer xxx
  const auth = String(req.headers.authorization || "");
  if (auth === `Bearer ${BEARER}`) return true;

  // (extra) aceitar ?token=xxx
  const qToken = String(req.query?.token || "");
  if (qToken && qToken === BEARER) return true;

  // (extra) aceitar header alternativo
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

  // importante em proxy (nginx/easypanel) pra não bufferizar SSE
  res.setHeader("X-Accel-Buffering", "no");

  // CORS no stream também
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
  if (!isAuthed(req)) {
    // pra SSE, dá pra responder 401 normal
    return res.status(401).end("Unauthorized");
  }

  sseHeaders(res);

  // DigoChat costuma ler "tools" e o objeto { tools: [...] }
  sseSend(res, "tools", { tools: listToolsPayload() });

  // keep-alive (evita timeout)
  const timer = setInterval(() => {
    res.write(`: ping\n\n`);
  }, 15000);

  req.on("close", () => clearInterval(timer));
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

// ------------------- DigoChat: LIST-TOOLS (SSE) -------------------
// DigoChat (pelo seu print) faz POST list-tools. Então suportamos GET e POST.
app.get("/list-tools", handleSseListTools);
app.post("/list-tools", handleSseListTools);

app.get("/mcp/list-tools", handleSseListTools);
app.post("/mcp/list-tools", handleSseListTools);

// alguns tentam bater no root esperando SSE
app.get("/", (req, res) => {
  res.status(200).send("OK. Use GET/POST /list-tools (SSE) ou POST /mcp (JSON-RPC).");
});

// debug JSON (sem SSE)
app.get("/tools", (req, res) => {
  if (!isAuthed(req)) return res.status(401).send("Unauthorized");
  res.json(listToolsPayload());
});

// ------------------- JSON-RPC (fallback) -------------------
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
        result: { tools: listToolsPayload() },
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

// opcional: evitar "Cannot GET /mcp"
app.get("/mcp", (req, res) => res.status(200).send("OK. Use POST /mcp (JSON-RPC) ou GET/POST /list-tools (SSE)."));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MCP server on 0.0.0.0:${PORT}`);
});
