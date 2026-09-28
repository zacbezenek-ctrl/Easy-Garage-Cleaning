import { createHash } from "node:crypto";
import type { OAuthStore } from "./store.js";

export type RateRule = { bucket: string; max: number; windowMs: number };
export type Attempt = { allowed: boolean; refused: string[]; ids: string[]; retryAfterSeconds: number };
export const LOGIN_WINDOW_MS = 15 * 60_000;
export const LOGIN_MAX_FAILURES_PER_ACCOUNT = 5;
export const LOGIN_MAX_FAILURES_TOTAL = 30;
export const REGISTER_WINDOW_MS = 60 * 60_000;
export const REGISTER_MAX = 20;
export const HUB_START_WINDOW_MS = 15 * 60_000;
export const HUB_START_MAX = 300;

const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);

// One bucket per submitted username (so spraying other names cannot lock the real one out)
// plus a server-wide ceiling. Usernames are stored only as a truncated digest. The account
// bucket locks that username; the server-wide one only changes how failures are answered
// (429 instead of 401) and never refuses the right username and password.
export const loginRules = (username: string): [RateRule, RateRule] => [
  { bucket: `login:account:${digest(username.trim().toLowerCase())}`, max: LOGIN_MAX_FAILURES_PER_ACCOUNT, windowMs: LOGIN_WINDOW_MS },
  { bucket: "login:all", max: LOGIN_MAX_FAILURES_TOTAL, windowMs: LOGIN_WINDOW_MS }
];
export const registrationRules = (): RateRule[] => [{ bucket: "register:all", max: REGISTER_MAX, windowMs: REGISTER_WINDOW_MS }];
// Each "Continue with Employee Hub" stores a grant request before anyone has signed in, so starts
// are capped server-wide; this bounds the unauthenticated writes, not who may approve.
export const hubStartRules = (): RateRule[] => [{ bucket: "hub:start:all", max: HUB_START_MAX, windowMs: HUB_START_WINDOW_MS }];

/**
 * Records the attempt BEFORE counting, so concurrent attempts cannot all pass one stale
 * count, and reports every bucket that now holds more than `max` attempts in its window.
 */
export async function beginAttempt(store: OAuthStore, rules: RateRule[], now: Date): Promise<Attempt> {
  const ids = await store.recordAttempts(rules.map((rule) => rule.bucket), now);
  const refused: RateRule[] = [];
  for (const rule of rules) {
    if (await store.countAttempts(rule.bucket, new Date(now.valueOf() - rule.windowMs)) > rule.max) refused.push(rule);
  }
  return { allowed: refused.length === 0, refused: refused.map((rule) => rule.bucket), ids, retryAfterSeconds: Math.max(0, ...refused.map((rule) => Math.ceil(rule.windowMs / 1000))) };
}

/**
 * An attempt refused before anything was checked is removed again, so only checks that ran
 * count and a lockout ends one window after the last counted failure, however often the
 * locked door is tried. A successful sign-in is not a failure either.
 */
export async function discardAttempt(store: OAuthStore, ids: string[]) {
  await store.deleteAttempts(ids);
}
export const attemptSucceeded = discardAttempt;
