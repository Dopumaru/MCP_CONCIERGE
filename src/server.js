try { require("dotenv").config(); } catch {}

const express = require("express");
const { z } = require("zod");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.MCP_BEARER_TOKEN || "";

/* Tools */
const tools = {
  ping: {
    description: "Retorna pong",
    schema: z.object({ message: z.string().optional() }),
    handler: async ({ message }) => ({
      content: [{ type: "text", text: `pong${message ? `: ${message}` : ""}` }]
    })
  },
  time_now: {
    description: "Retorna hora ISO",
    schema: z.object({}),
    handler: async () => ({
      content: [{ type: "text", text: new Date().toISOString() }]
    })
  }
};

/* MCP endpoint */
app.post("/mcp", async (req, res) => {
  if (TOKEN) {
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${TOKEN}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  const { method, params, id } = req.body;

  if (method === "tools/list") {
    return res.json({
      jsonrpc: "2.0",
      id,
      result: {
        tools: Object.entries(tools).map(([name, t]) => ({
          name,
          description: t.description,
          input_schema: t.schema
        }))
      }
    });
  }

  if (method === "tools/call") {
    const tool = tools[params.name];
    if (!tool) {
      return res.json({
        jsonrpc: "2.0",
        id,
        error: { message: "Tool not found" }
      });
    }

    const parsed = tool.schema.parse(params.arguments || {});
    const result = await tool.handler(parsed);

    return res.json({
      jsonrpc: "2.0",
      id,
      result
    });
  }

  res.json({
    jsonrpc: "2.0",
    id,
    error: { message: "Method not found" }
  });
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, "0.0.0.0", () => {
  console.log("MCP Server running on port", PORT);
});
