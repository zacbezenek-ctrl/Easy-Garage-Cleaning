#!/usr/bin/env node
/**
 * Makes a new VAPID key pair for crew-chat phone alerts (EGC_CREW_CHAT_PUSH, functions/_lib/web-push.js).
 *   node scripts/generate-vapid-keys.mjs
 * Prints EGC_VAPID_PUBLIC_KEY and EGC_VAPID_PRIVATE_KEY to this terminal only: paste them into Cloudflare Pages
 * (the public key as a variable, the private key as a secret) and never commit, paste or share the private key.
 * Nothing is written to disk. A new pair makes every phone subscribe again on its next Hub load.
 */
import { base64UrlEncode, vapidKeys } from '../functions/_lib/web-push.js';

const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const publicKey = base64UrlEncode(await crypto.subtle.exportKey('raw', pair.publicKey));
const privateKey = (await crypto.subtle.exportKey('jwk', pair.privateKey)).d;
if (!vapidKeys({ EGC_VAPID_PUBLIC_KEY: publicKey, EGC_VAPID_PRIVATE_KEY: privateKey })) throw new Error('The generated key pair did not check out; run the script again.');
process.stdout.write(`EGC_VAPID_PUBLIC_KEY=${publicKey}\nEGC_VAPID_PRIVATE_KEY=${privateKey}\n`);
