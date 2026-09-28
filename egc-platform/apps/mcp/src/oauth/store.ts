import { and, asc, count, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { getDb, schema } from "@egc/database";

// A grant a signed-in Hub user approved carries that user; the shared login leaves all three null.
export type GrantPrincipal = { principalId: string | null; principalRole: string | null; principalAssertion: string | null };
export type ClientRow = { clientId: string; clientName: string; redirectUris: string[]; createdAt: Date };
export type CodeRow = GrantPrincipal & {
  id: string; codeHash: string; clientId: string; redirectUri: string; codeChallenge: string;
  resource: string; scopes: string[]; expiresAt: Date; usedAt: Date | null;
};
export type TokenCredentials = { accessTokenHash: string; refreshTokenHash: string; accessExpiresAt: Date; refreshExpiresAt: Date };
export type TokenValues = GrantPrincipal & TokenCredentials & { clientId: string; resource: string; scopes: string[] };
export type TokenRow = TokenValues & { id: string; revokedAt: Date | null; createdAt: Date };
// clientLabel is what the Hub approval page shows and signs; bindingHash ties the request to the browser that started it.
export type GrantRequestRow = {
  id: string; nonceHash: string; clientId: string; redirectUri: string; codeChallenge: string;
  resource: string; scopes: string[]; state: string | null; clientLabel: string; bindingHash: string; expiresAt: Date; usedAt: Date | null;
};

/** Every state change the OAuth server makes. Single-use and rotation steps are atomic compare-and-set. */
export interface OAuthStore {
  client(clientId: string): Promise<ClientRow | null>;
  /** The earliest registered client with exactly this name and redirect URI list, if any. */
  clientByMetadata(clientName: string, redirectUris: string[]): Promise<ClientRow | null>;
  insertClient(row: ClientRow): Promise<void>;
  insertCode(row: Omit<CodeRow, "id" | "usedAt">, now: Date): Promise<void>;
  code(codeHash: string): Promise<CodeRow | null>;
  consumeCode(id: string, now: Date): Promise<boolean>;
  insertToken(values: TokenValues, now: Date): Promise<string>;
  tokenByAccess(accessTokenHash: string): Promise<TokenRow | null>;
  tokenByRefresh(refreshTokenHash: string): Promise<TokenRow | null>;
  /** Swaps the presented refresh hash for a claim marker; false when another request already used it or the grant is revoked. */
  claimRefresh(id: string, presentedHash: string, claimHash: string, now: Date): Promise<boolean>;
  /** Installs new credentials only while the grant still holds this claim and is not revoked. */
  rotateToken(id: string, claimHash: string, credentials: TokenCredentials, now: Date): Promise<boolean>;
  revokeToken(id: string, now: Date): Promise<void>;
  insertGrantRequest(row: Omit<GrantRequestRow, "id" | "usedAt">, now: Date): Promise<void>;
  /** Marks an unexpired, unused request used and returns it; null for every other case. */
  consumeGrantRequest(nonceHash: string, now: Date): Promise<GrantRequestRow | null>;
  recordAttempts(buckets: string[], now: Date): Promise<string[]>;
  countAttempts(bucket: string, since: Date): Promise<number>;
  deleteAttempts(ids: string[]): Promise<void>;
}

const RETAIN_ATTEMPTS_MS = 24 * 60 * 60_000;
const RETAIN_REQUESTS_MS = 24 * 60 * 60_000;

export function postgresOAuthStore(db: () => ReturnType<typeof getDb> = getDb): OAuthStore {
  const { oauthClients: clients, oauthAuthorizationCodes: codes, oauthTokens: tokens, oauthGrantRequests: requests, oauthRateLimitEvents: attempts } = schema;
  return {
    async client(clientId) {
      const [row] = await db().select().from(clients).where(eq(clients.clientId, clientId)).limit(1);
      return row ? { clientId: row.clientId, clientName: row.clientName, redirectUris: row.redirectUris, createdAt: row.createdAt } : null;
    },
    async clientByMetadata(clientName, redirectUris) {
      const [row] = await db().select().from(clients)
        .where(and(eq(clients.clientName, clientName), sql`${clients.redirectUris} = ${JSON.stringify(redirectUris)}::jsonb`))
        .orderBy(asc(clients.createdAt)).limit(1);
      return row ? { clientId: row.clientId, clientName: row.clientName, redirectUris: row.redirectUris, createdAt: row.createdAt } : null;
    },
    async insertClient(row) {
      await db().insert(clients).values(row);
    },
    async insertCode(row, now) {
      await db().insert(codes).values({ ...row, createdAt: now });
    },
    async code(codeHash) {
      const [row] = await db().select().from(codes).where(eq(codes.codeHash, codeHash)).limit(1);
      return row ?? null;
    },
    async consumeCode(id, now) {
      const rows = await db().update(codes).set({ usedAt: now })
        .where(and(eq(codes.id, id), isNull(codes.usedAt))).returning({ id: codes.id });
      return rows.length === 1;
    },
    async insertToken(values, now) {
      const [row] = await db().insert(tokens).values({ ...values, revokedAt: null, createdAt: now, updatedAt: now }).returning({ id: tokens.id });
      return row!.id;
    },
    async tokenByAccess(accessTokenHash) {
      const [row] = await db().select().from(tokens).where(eq(tokens.accessTokenHash, accessTokenHash)).limit(1);
      return row ?? null;
    },
    async tokenByRefresh(refreshTokenHash) {
      const [row] = await db().select().from(tokens).where(eq(tokens.refreshTokenHash, refreshTokenHash)).limit(1);
      return row ?? null;
    },
    async claimRefresh(id, presentedHash, claimHash, now) {
      const rows = await db().update(tokens).set({ refreshTokenHash: claimHash, updatedAt: now })
        .where(and(eq(tokens.id, id), eq(tokens.refreshTokenHash, presentedHash), isNull(tokens.revokedAt)))
        .returning({ id: tokens.id });
      return rows.length === 1;
    },
    async rotateToken(id, claimHash, credentials, now) {
      const rows = await db().update(tokens).set({ ...credentials, updatedAt: now })
        .where(and(eq(tokens.id, id), eq(tokens.refreshTokenHash, claimHash), isNull(tokens.revokedAt)))
        .returning({ id: tokens.id });
      return rows.length === 1;
    },
    async revokeToken(id, now) {
      await db().update(tokens).set({ revokedAt: now, updatedAt: now }).where(and(eq(tokens.id, id), isNull(tokens.revokedAt)));
    },
    async insertGrantRequest(row, now) {
      await db().delete(requests).where(lt(requests.expiresAt, new Date(now.valueOf() - RETAIN_REQUESTS_MS)));
      await db().insert(requests).values({ ...row, createdAt: now });
    },
    async consumeGrantRequest(nonceHash, now) {
      const [row] = await db().update(requests).set({ usedAt: now })
        .where(and(eq(requests.nonceHash, nonceHash), isNull(requests.usedAt), gt(requests.expiresAt, now)))
        .returning();
      return row ? { id: row.id, nonceHash: row.nonceHash, clientId: row.clientId, redirectUri: row.redirectUri, codeChallenge: row.codeChallenge, resource: row.resource, scopes: row.scopes, state: row.state, clientLabel: row.clientLabel, bindingHash: row.bindingHash, expiresAt: row.expiresAt, usedAt: row.usedAt } : null;
    },
    async recordAttempts(buckets, now) {
      await db().delete(attempts).where(lt(attempts.occurredAt, new Date(now.valueOf() - RETAIN_ATTEMPTS_MS)));
      if (!buckets.length) return [];
      const rows = await db().insert(attempts).values(buckets.map((bucket) => ({ bucket, occurredAt: now }))).returning({ id: attempts.id });
      return rows.map((row) => row.id);
    },
    async countAttempts(bucket, since) {
      const [row] = await db().select({ value: count() }).from(attempts).where(and(eq(attempts.bucket, bucket), gt(attempts.occurredAt, since)));
      return Number(row?.value ?? 0);
    },
    async deleteAttempts(ids) {
      if (ids.length) await db().delete(attempts).where(inArray(attempts.id, ids));
    }
  };
}
