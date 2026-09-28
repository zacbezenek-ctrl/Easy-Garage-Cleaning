import { randomUUID } from "node:crypto";
import type { ClientRow, CodeRow, GrantRequestRow, OAuthStore, TokenRow } from "../src/oauth/store.js";

/** In-memory OAuthStore with the Postgres store's single-use and compare-and-set semantics (test/oauth-postgres.check.mjs covers the SQL). */
export function memoryOAuthStore() {
  const clients = new Map<string, ClientRow>(), codes = new Map<string, CodeRow>(), tokens = new Map<string, TokenRow>(), requests = new Map<string, GrantRequestRow>();
  const attempts = new Map<string, { bucket: string; occurredAt: Date }>();
  const copy = <T>(value: T | undefined) => value === undefined ? null : structuredClone(value);
  const store: OAuthStore = {
    async client(clientId) { return copy(clients.get(clientId)); },
    async clientByMetadata(clientName, redirectUris) {
      return copy([...clients.values()].find((row) => row.clientName === clientName && JSON.stringify(row.redirectUris) === JSON.stringify(redirectUris)));
    },
    async insertClient(row) {
      if (clients.has(row.clientId)) throw new Error("duplicate client");
      clients.set(row.clientId, structuredClone(row));
    },
    async insertCode(row) {
      if ([...codes.values()].some((code) => code.codeHash === row.codeHash)) throw new Error("duplicate code");
      const id = randomUUID();
      codes.set(id, { ...structuredClone(row), id, usedAt: null });
    },
    async code(codeHash) { return copy([...codes.values()].find((code) => code.codeHash === codeHash)); },
    async consumeCode(id, now) {
      const code = codes.get(id);
      if (!code || code.usedAt) return false;
      code.usedAt = now;
      return true;
    },
    async insertToken(values, now) {
      const id = randomUUID();
      tokens.set(id, { ...structuredClone(values), id, revokedAt: null, createdAt: now });
      return id;
    },
    async tokenByAccess(hash) { return copy([...tokens.values()].find((token) => token.accessTokenHash === hash)); },
    async tokenByRefresh(hash) { return copy([...tokens.values()].find((token) => token.refreshTokenHash === hash)); },
    async claimRefresh(id, presentedHash, claimHash) {
      const token = tokens.get(id);
      if (!token || token.revokedAt || token.refreshTokenHash !== presentedHash) return false;
      token.refreshTokenHash = claimHash;
      return true;
    },
    async rotateToken(id, claimHash, credentials) {
      const token = tokens.get(id);
      if (!token || token.revokedAt || token.refreshTokenHash !== claimHash) return false;
      Object.assign(token, structuredClone(credentials));
      return true;
    },
    async revokeToken(id, now) {
      const token = tokens.get(id);
      if (token && !token.revokedAt) token.revokedAt = now;
    },
    async insertGrantRequest(row) {
      const id = randomUUID();
      requests.set(id, { ...structuredClone(row), id, usedAt: null });
    },
    async consumeGrantRequest(nonceHash, now) {
      const request = [...requests.values()].find((row) => row.nonceHash === nonceHash);
      if (!request || request.usedAt || request.expiresAt.valueOf() <= now.valueOf()) return null;
      request.usedAt = now;
      return structuredClone(request);
    },
    async recordAttempts(buckets, now) {
      return buckets.map((bucket) => { const id = randomUUID(); attempts.set(id, { bucket, occurredAt: now }); return id; });
    },
    async countAttempts(bucket, since) {
      return [...attempts.values()].filter((row) => row.bucket === bucket && row.occurredAt.valueOf() > since.valueOf()).length;
    },
    async deleteAttempts(ids) { for (const id of ids) attempts.delete(id); }
  };
  return { store, clients, codes, tokens, requests, attempts };
}
