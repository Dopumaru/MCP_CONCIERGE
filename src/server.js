// src/server.js
try { require("dotenv").config(); } catch {}

const express = require("express");
const cors = require("cors");

const app = express();

// CORS explícito (inclui Authorization + preflight)
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
function wantsSSE(req) {
  const accept = String(req.headers.accept || "");
  return accept.includes("text/event-stream");
}

function sseHeaders(res) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  // MUITO importante em proxies (nginx / easypanel) pra não bufferizar SSE
  res.setHeader("X-Accel-Buffering", "no");
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

  // manda a lista de ferramentas
  sseSend(res, "tools", { tools: listToolsPayload() });

  // keep-alive ping (pra não cair por timeout)
  const timer = setInterval(() => {
    res.write(`: ping\n\n`);
  }, 15000);

  req.on("close", () => clearInterval(timer));
}

// Health
app.get("/health", (req, res) => res.json({ ok: true }));

// ✅ Rotas SSE que o DigoChat pode chamar
app.get("/list-tools", (req, res) => handleSseListTools(req, res));
app.get("/mcp/list-tools", (req, res) => handleSseListTools(req, res));
app.get("/mcp", (req, res) => handleSseListTools(req, res));

// (extra) se o DigoChat usar outro path com SSE, ainda funciona
app.get("/tools", (req, res) => {
  if (wantsSSE(req)) return handleSseListTools(req, res);
  if (!isAuthed(req)) return res.status(401).send("Unauthorized");
  res.json(listToolsPayload());
});
app.get("/", (req, res) => {
  if (wantsSSE(req)) return handleSseListTools(req, res);
  res.status(200).send("OK. Use SSE (GET /list-tools) ou JSON-RPC (POST /mcp).");
});

// ---------- JSON-RPC (fallback) ----------
app.post("/mcp", async (req, res) => {
  if (!isAuthed(req)) {
    return res.status(401).json({
      jsonrpc: "2.0",
      id: req.body?.id ?? null,
      error: { message: "Unauthorized" },
    });
  }

  const { method, params, id } = req.body || {};

  try {
    if (method === "tools/list") {
      return res.json({
        jsonrpc: "2.0",
        id: id ?? null,
        result: { tools: listToolsPayload() },
      });
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const args = params?.arguments || {};
      const tool = tools[toolName];

      if (!tool) {
        return res.json({ jsonrpc: "2.0", id: id ?? null, error: { message: "Tool not found" } });
      }

      const result = await tool.handler(args);
      return res.json({ jsonrpc: "2.0", id: id ?? null, result });
    }

    if (method === "initialize") {
      return res.json({
        jsonrpc: "2.0",
        id: id ?? null,
        result: { serverInfo: { name: "mcp-concierge", version: "1.0.0" } },
      });
    }

    return res.json({ jsonrpc: "2.0", id: id ?? null, error: { message: "Method not found" } });
  } catch (e) {
    return res.status(400).json({
      jsonrpc: "2.0",
      id: id ?? null,
      error: { message: String(e?.message || e) },
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MCP server on 0.0.0.0:${PORT}`);
});
