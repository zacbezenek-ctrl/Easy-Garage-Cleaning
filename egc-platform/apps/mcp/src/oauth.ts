import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import express from "express";
import { and, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "@egc/database";

const CHATGPT_CLIENT_ID = "https://chatgpt.com/oauth/client.json";
const CHATGPT_REDIRECT_URI = "https://chatgpt.com/connector_platform_oauth_redirect";
const READ_SCOPE = "egc:read";
const ACCESS_TOKEN_TTL_MS = 60 * 60_000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;
const AUTH_CODE_TTL_MS = 5 * 60_000;

function publicOrigin() {
  const configured = process.env.MCP_PUBLIC_ORIGIN?.trim();
  if (!configured) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("MCP_PUBLIC_ORIGIN is required in production");
    }
    return "http://localhost:4200";
  }

  const url = new URL(configured);
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("MCP_PUBLIC_ORIGIN must use https in production");
  }
  return url.origin;
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function secureEqual(actual: string, expected: string) {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requestedScopes(value: unknown) {
  const scopes = String(value ?? READ_SCOPE)
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);

  if (!scopes.includes(READ_SCOPE)) scopes.push(READ_SCOPE);
  return [...new Set(scopes.filter((scope) => scope === READ_SCOPE || scope === "offline_access"))];
}

function oauthError(res: Response, status: number, error: string, description: string) {
  res.status(status)
    .set("Cache-Control", "no-store")
    .json({ error, error_description: description });
}

function htmlEscape(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function validateAuthorizeParams(params: URLSearchParams) {
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const responseType = params.get("response_type") ?? "";
  const codeChallenge = params.get("code_challenge") ?? "";
  const codeChallengeMethod = params.get("code_challenge_method") ?? "";
  const resource = params.get("resource") ?? "";
  const expectedResource = publicOrigin();

  if (clientId !== CHATGPT_CLIENT_ID) return "Unsupported OAuth client.";
  if (redirectUri !== CHATGPT_REDIRECT_URI) return "Invalid redirect URI.";
  if (responseType !== "code") return "Only authorization code flow is supported.";
  if (!codeChallenge) return "PKCE code challenge is required.";
  if (codeChallengeMethod !== "S256") return "Only PKCE S256 is supported.";
  if (resource !== expectedResource) return "Invalid OAuth resource.";
  return null;
}

function authorizationPage(params: URLSearchParams, error?: string) {
  const hidden = [
    "client_id",
    "redirect_uri",
    "response_type",
    "code_challenge",
    "code_challenge_method",
    "resource",
    "scope",
    "state"
  ].map((key) => {
    const value = params.get(key);
    return value === null
      ? ""
      : `<input type="hidden" name="${key}" value="${htmlEscape(value)}">`;
  }).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Easy Garage Cleaning</title>
<style>
body{font-family:Inter,system-ui,sans-serif;background:#f5f5f3;color:#151515;margin:0;min-height:100vh;display:grid;place-items:center;padding:20px}
main{width:min(440px,100%);background:#fff;border:1px solid #deded8;border-radius:20px;padding:28px;box-shadow:0 18px 60px rgba(0,0,0,.08)}
h1{margin:0 0 8px;font-size:26px;letter-spacing:-.04em}p{color:#666;line-height:1.5}.error{color:#b42318;background:#fef3f2;padding:10px;border-radius:10px}
label{display:block;font-size:13px;font-weight:700;margin:16px 0 6px}input[type=text],input[type=password]{width:100%;box-sizing:border-box;padding:12px;border:1px solid #cfcfc8;border-radius:10px;font:inherit}
button{width:100%;margin-top:20px;padding:13px;border:0;border-radius:11px;background:#111;color:#fff;font:inherit;font-weight:800;cursor:pointer}
small{display:block;color:#777;margin-top:14px}
</style>
</head>
<body>
<main>
<h1>Connect EGC Ops</h1>
<p>Authorize ChatGPT to use the read-only Easy Garage Cleaning MCP. This connection can read synchronized EGC operational data but cannot send messages, alter pricing, issue refunds, or delete records.</p>
${error ? `<p class="error">${htmlEscape(error)}</p>` : ""}
<form method="post" action="/oauth/authorize">
${hidden}
<label for="username">Username</label>
<input id="username" name="username" type="text" autocomplete="username" required>
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Authorize ChatGPT</button>
</form>
<small>Scope: ${htmlEscape(params.get("scope") ?? READ_SCOPE)}</small>
</main>
</body>
</html>`;
}

async function issueTokens(input: {
  clientId: string;
  resource: string;
  scopes: string[];
  existingTokenId?: string;
}) {
  const db = getDb();
  const accessToken = `egc_at_${randomToken(32)}`;
  const refreshToken = `egc_rt_${randomToken(40)}`;
  const now = new Date();
  const accessExpiresAt = new Date(now.valueOf() + ACCESS_TOKEN_TTL_MS);
  const refreshExpiresAt = new Date(now.valueOf() + REFRESH_TOKEN_TTL_MS);

  const values = {
    accessTokenHash: hash(accessToken),
    refreshTokenHash: hash(refreshToken),
    clientId: input.clientId,
    resource: input.resource,
    scopes: input.scopes,
    accessExpiresAt,
    refreshExpiresAt,
    revokedAt: null,
    updatedAt: now
  };

  if (input.existingTokenId) {
    await db.update(schema.oauthTokens)
      .set(values)
      .where(eq(schema.oauthTokens.id, input.existingTokenId));
  } else {
    await db.insert(schema.oauthTokens).values({
      ...values,
      createdAt: now
    });
  }

  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    refresh_token: refreshToken,
    scope: input.scopes.join(" ")
  };
}

export function oauthSecurityMetadata() {
  const schemes = [{ type: "oauth2" as const, scopes: [READ_SCOPE] }];
  return {
    securitySchemes: schemes,
    _meta: { securitySchemes: schemes }
  };
}

export function registerOauthRoutes(app: Express) {
  const origin = publicOrigin();
  const resourceMetadataUrl = `${origin}/.well-known/oauth-protected-resource`;

  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.set("Cache-Control", "public, max-age=300").json({
      resource: origin,
      authorization_servers: [origin],
      scopes_supported: [READ_SCOPE, "offline_access"],
      resource_documentation: `${origin}/mcp-info`
    });
  });

  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.set("Cache-Control", "public, max-age=300").json({
      issuer: origin,
      authorization_response_iss_parameter_supported: true,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      client_id_metadata_document_supported: true,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [READ_SCOPE, "offline_access"]
    });
  });

  app.get("/mcp-info", (_req, res) => {
    res.type("text/plain").send(
      "Easy Garage Cleaning read-only MCP. OAuth scope: egc:read. Endpoint: /mcp."
    );
  });

  app.get("/oauth/authorize", (req, res) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(req.query)) {
      if (typeof value === "string") params.set(key, value);
    }

    const validationError = validateAuthorizeParams(params);
    if (validationError) {
      res.status(400).type("html").send(authorizationPage(params, validationError));
      return;
    }

    res.set("Cache-Control", "no-store").type("html").send(authorizationPage(params));
  });

  app.post(
    "/oauth/authorize",
    express.urlencoded({ extended: false, limit: "32kb" }),
    async (req, res) => {
      const params = new URLSearchParams();
      for (const key of [
        "client_id",
        "redirect_uri",
        "response_type",
        "code_challenge",
        "code_challenge_method",
        "resource",
        "scope",
        "state"
      ]) {
        const value = req.body?.[key];
        if (typeof value === "string") params.set(key, value);
      }

      const validationError = validateAuthorizeParams(params);
      if (validationError) {
        res.status(400).type("html").send(authorizationPage(params, validationError));
        return;
      }

      const configuredUser = process.env.MCP_OAUTH_USER ?? "";
      const configuredPassword = process.env.MCP_OAUTH_PASSWORD ?? "";
      const username = typeof req.body?.username === "string" ? req.body.username : "";
      const password = typeof req.body?.password === "string" ? req.body.password : "";

      if (
        configuredUser.length < 1 ||
        configuredPassword.length < 20 ||
        !secureEqual(username, configuredUser) ||
        !secureEqual(password, configuredPassword)
      ) {
        res.status(401).type("html").send(authorizationPage(params, "Invalid EGC MCP credentials."));
        return;
      }

      const code = `egc_ac_${randomToken(32)}`;
      const scopes = requestedScopes(params.get("scope"));
      const db = getDb();

      await db.insert(schema.oauthAuthorizationCodes).values({
        codeHash: hash(code),
        clientId: CHATGPT_CLIENT_ID,
        redirectUri: CHATGPT_REDIRECT_URI,
        codeChallenge: params.get("code_challenge")!,
        resource: origin,
        scopes,
        expiresAt: new Date(Date.now() + AUTH_CODE_TTL_MS)
      });

      const redirect = new URL(CHATGPT_REDIRECT_URI);
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("iss", origin);
      const state = params.get("state");
      if (state) redirect.searchParams.set("state", state);

      res.set("Cache-Control", "no-store").redirect(302, redirect.toString());
    }
  );

  app.post(
    "/oauth/token",
    express.urlencoded({ extended: false, limit: "32kb" }),
    async (req, res) => {
      res.set("Cache-Control", "no-store");
      const grantType = typeof req.body?.grant_type === "string" ? req.body.grant_type : "";
      const clientId = typeof req.body?.client_id === "string" ? req.body.client_id : "";

      if (clientId !== CHATGPT_CLIENT_ID) {
        oauthError(res, 400, "invalid_client", "Unsupported OAuth client.");
        return;
      }

      if (grantType === "authorization_code") {
        const code = typeof req.body?.code === "string" ? req.body.code : "";
        const redirectUri = typeof req.body?.redirect_uri === "string" ? req.body.redirect_uri : "";
        const verifier = typeof req.body?.code_verifier === "string" ? req.body.code_verifier : "";
        const resource = typeof req.body?.resource === "string" ? req.body.resource : "";

        if (!code || redirectUri !== CHATGPT_REDIRECT_URI || !verifier || resource !== origin) {
          oauthError(res, 400, "invalid_grant", "Authorization code request is invalid.");
          return;
        }

        const db = getDb();
        const [record] = await db.select().from(schema.oauthAuthorizationCodes)
          .where(eq(schema.oauthAuthorizationCodes.codeHash, hash(code)))
          .limit(1);

        if (
          !record ||
          record.usedAt ||
          record.expiresAt.valueOf() <= Date.now() ||
          record.clientId !== clientId ||
          record.redirectUri !== redirectUri ||
          record.resource !== resource
        ) {
          oauthError(res, 400, "invalid_grant", "Authorization code is expired or invalid.");
          return;
        }

        const expectedChallenge = createHash("sha256").update(verifier).digest("base64url");
        if (!secureEqual(expectedChallenge, record.codeChallenge)) {
          oauthError(res, 400, "invalid_grant", "PKCE verification failed.");
          return;
        }

        const [consumed] = await db.update(schema.oauthAuthorizationCodes)
          .set({ usedAt: new Date() })
          .where(and(
            eq(schema.oauthAuthorizationCodes.id, record.id),
            isNull(schema.oauthAuthorizationCodes.usedAt)
          ))
          .returning({ id: schema.oauthAuthorizationCodes.id });

        if (!consumed) {
          oauthError(res, 400, "invalid_grant", "Authorization code was already used.");
          return;
        }

        res.json(await issueTokens({
          clientId,
          resource,
          scopes: record.scopes
        }));
        return;
      }

      if (grantType === "refresh_token") {
        const refreshToken = typeof req.body?.refresh_token === "string" ? req.body.refresh_token : "";
        const resource = typeof req.body?.resource === "string" ? req.body.resource : origin;
        if (!refreshToken || resource !== origin) {
          oauthError(res, 400, "invalid_grant", "Refresh token request is invalid.");
          return;
        }

        const db = getDb();
        const [record] = await db.select().from(schema.oauthTokens)
          .where(eq(schema.oauthTokens.refreshTokenHash, hash(refreshToken)))
          .limit(1);

        if (
          !record ||
          record.revokedAt ||
          record.refreshExpiresAt.valueOf() <= Date.now() ||
          record.clientId !== clientId ||
          record.resource !== resource
        ) {
          oauthError(res, 400, "invalid_grant", "Refresh token is expired or invalid.");
          return;
        }

        res.json(await issueTokens({
          existingTokenId: record.id,
          clientId,
          resource,
          scopes: record.scopes
        }));
        return;
      }

      oauthError(res, 400, "unsupported_grant_type", "Supported grants are authorization_code and refresh_token.");
    }
  );

  return {
    origin,
    resourceMetadataUrl,
    scope: READ_SCOPE
  };
}

export function requireMcpAuth(resourceMetadataUrl: string) {
  return async function mcpAuth(req: Request, res: Response, next: NextFunction) {
    const authorization = req.header("authorization");
    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : "";

    const serviceToken = process.env.MCP_BEARER_TOKEN ?? "";
    if (
      token &&
      serviceToken.length >= 32 &&
      secureEqual(token, serviceToken)
    ) {
      next();
      return;
    }

    if (token) {
      const db = getDb();
      const [record] = await db.select().from(schema.oauthTokens)
        .where(eq(schema.oauthTokens.accessTokenHash, hash(token)))
        .limit(1);

      if (
        record &&
        !record.revokedAt &&
        record.accessExpiresAt.valueOf() > Date.now() &&
        record.scopes.includes(READ_SCOPE)
      ) {
        next();
        return;
      }
    }

    res.status(401)
      .set("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl}", scope="${READ_SCOPE}"`)
      .set("Cache-Control", "no-store")
      .json({ error: "unauthorized" });
  };
}
