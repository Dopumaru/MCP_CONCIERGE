require("dotenv").config();
const express = require("express");
const { z } = require("zod");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 3000);
const BEARER = process.env.MCP_BEARER_TOKEN || ""; // se vazio, sem auth

function checkAuth(req) {
  if (!BEARER) return true;
  const auth = req.headers.authorization || "";
  return auth === `Bearer ${BEARER}`;
}

// Tools registry
const tools = {
  ping: {
    description: "Retorna pong (teste de integração)",
    schema: z.object({ message: z.string().optional() }),
    handler: async ({ message }) => ({
      content: [{ type: "text", text: `pong${message ? `: ${message}` : ""}` }],
    }),
  },
  time_now: {
    description: "Retorna a hora ISO do servidor",
    schema: z.object({}),
    handler: async () => ({
      content: [{ type: "text", text: new Date().toISOString() }],
    }),
  },
};

// Health
app.get("/health", (req, res) => res.json({ ok: true }));

// Lista tools (debug)
app.get("/tools", (req, res) => {
  res.json(
    Object.entries(tools).map(([name, t]) => ({
      name,
      description: t.description,
    }))
  );
});

// Chama tool (debug)
app.post("/call", async (req, res) => {
  if (!checkAuth(req)) return res.status(401).send("Unauthorized");

  try {
    const { name, args } = req.body || {};
    const tool = tools[name];
    if (!tool) return res.status(404).json({ ok: false, error: "Tool not found" });

    const parsed = tool.schema.parse(args || {});
    const result = await tool.handler(parsed);

    res.json({ ok: true, result });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

// ✅ importante pra EasyPanel/Docker: escutar em 0.0.0.0
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server on http://0.0.0.0:${PORT}`);
});
