import {
  AuthorizationError,
  insufficientScope,
  OAuthProvider,
  type OAuthHelpers,
  type OAuthResourceAuth,
} from "@cloudflare/workers-oauth-provider";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "./server.js";
import { LyftaClient } from "./lyfta-client.js";

const ORIGIN = "https://lyfta-mcp.stq11cfwt9q8yriiy8lnhd.workers.dev";
const RESOURCE = `${ORIGIN}/mcp`;
const SCOPES = ["mcp:read", "mcp:write", "offline_access"];

interface AuthProps {
  apiKey: string;
}

interface Env {
  LYFTA_BASE_URL?: string;
  LYFTA_TIMEOUT_MS?: string;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
}

type OAuthContext = ExecutionContext & {
  props: AuthProps;
  auth: OAuthResourceAuth;
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char] ?? char);
}

function html(body: string, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "text/html; charset=utf-8");
  responseHeaders.set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  responseHeaders.set("x-content-type-options", "nosniff");
  return new Response(body, { status, headers: responseHeaders });
}

function page(content: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect Lyfta</title>
<style>
:root{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#101318;color:#f4f5f7}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;box-sizing:border-box}
main{width:min(100%,460px);background:#1a2029;border:1px solid #303947;border-radius:18px;padding:28px;box-sizing:border-box}
h1{font-size:24px;margin:0 0 10px}p{color:#bac3d0;line-height:1.55}
label{display:block;font-size:14px;margin:18px 0 8px}
input[type=password]{width:100%;box-sizing:border-box;background:#10151c;border:1px solid #465365;color:#fff;padding:13px;border-radius:9px;font-size:15px}
.scopes{display:grid;gap:9px;margin:18px 0;color:#dbe2ec;font-size:14px}
button{width:100%;border:0;border-radius:9px;background:#7c9cff;color:#101522;padding:13px;font-weight:700;font-size:15px;cursor:pointer}
small{color:#8996a8}
.error{background:#49282d;color:#ffd7db;padding:11px;border-radius:8px}
</style>
</head>
<body><main>${content}</main></body></html>`;
}

function renderAuthorizeForm(
  clientName: string,
  redirectHost: string,
  handle: string,
  scopes: string[],
  error = "",
): Response {
  const scopeInputs = scopes.map((scope) =>
    `<label><input type="checkbox" name="scope" value="${escapeHtml(scope)}" checked> ${escapeHtml(scope)}</label>`,
  ).join("");
  const warning = error ? `<p class="error">${escapeHtml(error)}</p>` : "";
  const body = `
<h1>Connect Lyfta</h1>
<p><strong>${escapeHtml(clientName)}</strong> is requesting access to your Lyfta account. The authorization response will return to <strong>${escapeHtml(redirectHost)}</strong>.</p>
${warning}
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<label for="apiKey">Lyfta API Key</label>
<input id="apiKey" name="apiKey" type="password" autocomplete="off" required placeholder="Paste your Lyfta API key">
<div class="scopes">${scopeInputs}</div>
<button type="submit" name="decision" value="approve">Connect Lyfta</button>
</form>
<p><small>Your key is validated with Lyfta and stored encrypted with the OAuth grant.</small></p>`;
  return html(page(body));
}

async function authorize(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  if (request.method === "GET") {
    let authRequest;
    try {
      authRequest = await oauth.parseAuthRequest(request);
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectTo) {
        return Response.redirect(error.redirectTo, 302);
      }
      return html(page(`<h1>Authorization error</h1><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`), 400);
    }

    try {
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      consent.headers.set("content-type", "text/html; charset=utf-8");
      // ChatGPT initially asks only for the baseline read scope. Offer write as an
      // explicit opt-in on the same consent screen so the user can create programs.
      const consentScopes = [...new Set([
        ...authRequest.scope.filter((scope) => SCOPES.includes(scope)),
        "mcp:write",
      ])];
      const response = renderAuthorizeForm(
        details.clientName,
        details.redirectHost,
        consent.handle,
        consentScopes,
      );
      const headers = new Headers(response.headers);
      for (const [key, value] of consent.headers) headers.set(key, value);
      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      return html(page(`<h1>Could not start authorization</h1><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`), 400);
    }
  }

  if (request.method === "POST") {
    const form = await request.formData();
    const handle = String(form.get("handle") ?? "");
    const decision = String(form.get("decision") ?? "");
    if (decision !== "approve") {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }

    const apiKey = String(form.get("apiKey") ?? "").trim();
    const scopes = form.getAll("scope").map(String).filter((scope) => SCOPES.includes(scope));
    if (!apiKey) {
      return html(page("<h1>Lyfta API Key required</h1><p>Go back and enter your API key.</p>"), 400);
    }

    try {
      // Verify the supplied key before issuing an OAuth grant.
      await new LyftaClient(apiKey).listWorkoutSummaries({ limit: 1 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not validate the Lyfta API key.";
      return html(page(`<h1>Lyfta connection failed</h1><p>${escapeHtml(message)}</p><p>Return to ChatGPT and start the connection again.</p>`), 401);
    }

    const approved = await oauth.approveConsent(request, handle, { scope: scopes });
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: "lyfta-account",
      metadata: { provider: "Lyfta" },
      scope: approved.request.scope,
      props: { apiKey },
    });
    approved.headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  }

  return new Response("Method not allowed", { status: 405 });
}

const apiHandler = {
  async fetch(request: Request, _env: Env, rawContext: unknown): Promise<Response> {
    const ctx = rawContext as OAuthContext;
    if (request.method === "POST") {
      try {
        const body = await request.clone().json() as {
          method?: string;
          params?: { name?: string };
        };
        if (
          body.method === "tools/call" &&
          ["create_collection", "create_template"].includes(body.params?.name ?? "") &&
          !ctx.auth.scope.includes("mcp:write")
        ) {
          return insufficientScope(ctx.auth, ["mcp:read", "mcp:write"], "Lyfta write access is required.");
        }
      } catch {
        // The MCP transport returns the appropriate protocol error for malformed requests.
      }
    }

    const server = createServer(ctx.props.apiKey);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    try {
      await server.connect(transport);
      return await transport.handleRequest(request);
    } catch {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal error" },
        id: null,
      }), {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    } finally {
      await transport.close();
      await server.close();
    }
  },
};

const provider = new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler,
  defaultHandler: {
    fetch(request, env) {
      const path = new URL(request.url).pathname;
      if (path === "/authorize") return authorize(request, env);
      if (path === "/healthz") return Response.json({ ok: true, service: "lyfta-mcp" });
      return new Response("Not found", { status: 404 });
    },
  },
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  scopesSupported: SCOPES,
  resourceMetadata: {
    resource: RESOURCE,
    authorization_servers: [ORIGIN],
    resource_name: "Lyfta workout manager",
  },
  requiredScopes: ["mcp:read"],
  clientIdMetadataDocumentEnabled: true,
});

export default provider;
