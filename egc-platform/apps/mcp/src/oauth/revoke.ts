import express, { type Express } from "express";
import { guarded, hash, oauthError, text, type OAuthContext } from "./common.js";

/**
 * RFC 7009. Revoking either the access or the refresh token revokes the whole grant, so
 * neither works afterwards. Unknown, expired or already revoked tokens are not an error.
 */
export function registerRevocation(app: Express, ctx: OAuthContext) {
  app.post("/oauth/revoke", express.urlencoded({ extended: false, limit: "8kb" }), guarded(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const token = text(req.body?.token), clientId = text(req.body?.client_id);
    if (!token || token.length > 512) {
      oauthError(res, 400, "invalid_request", "The token parameter is required.");
      return;
    }
    const digest = hash(token);
    const record = await ctx.store.tokenByAccess(digest) ?? await ctx.store.tokenByRefresh(digest);
    if (record) {
      if (clientId && clientId !== record.clientId) {
        oauthError(res, 400, "invalid_client", "The token was not issued to this client.");
        return;
      }
      if (!record.revokedAt) await ctx.store.revokeToken(record.id, ctx.now());
    }
    res.status(200).end();
  }));
}
