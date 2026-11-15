import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "./server.js";

interface Env {
  LYFTA_BASE_URL?: string;
  LYFTA_TIMEOUT_MS?: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function cors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "POST, GET, OPTIONS");
  headers.set("access-control-allow-headers", "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version");
  headers.set("access-control-expose-headers", "Mcp-Session-Id, Mcp-Protocol-Version");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }

    if (url.pathname === "/healthz" && request.method === "GET") {
      return cors(json({ ok: true }));
    }

    if (url.pathname !== "/mcp") {
      return cors(json({ error: "Not found" }, 404));
    }

    if (request.method !== "POST") {
      return cors(json({ error: "Method not allowed" }, 405));
    }

    const match = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "");
    const apiKey = match?.[1]?.trim();
    if (!apiKey) {
      return cors(json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Missing 'Authorization: Bearer <lyfta-key>' header." },
        id: null,
      }, 401));
    }

    const server = createServer(apiKey);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    try {
      await server.connect(transport);
      const response = await transport.handleRequest(request);
      return cors(response);
    } catch {
      return cors(json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal error" },
        id: null,
      }, 500));
    } finally {
      await transport.close();
      await server.close();
    }
  },
};
