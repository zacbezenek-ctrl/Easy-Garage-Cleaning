import test from 'node:test';
import assert from 'node:assert/strict';
import { RATE_LIMITS, clientAddressKey, consumeRateLimit, consumeRollingLimit, cleanupExpiredRecords, rateLimitId, releaseRollingLimit } from '../functions/_lib/rate-limit.js';
import { PURPOSES, purposeSign } from '../functions/_lib/purpose-keys.js';
import { memory } from './helpers/customer-login-fixture.mjs';

const NOW = '2026-09-22T12:00:00.000Z';
const env = { HUB_SESSION_SECRET: 'synthetic-rate-limit-secret-0123456789abcdef' };
const rule = { bucket: 'synthetic_bucket', key: 'ip:203.0.113.9', limit: 3, windowMs: 60000 };
const at = ms => new Date(Date.parse(NOW) + ms).toISOString();
const code = expected => error => { assert.equal(error.code, expected); return true; };
const counters = store => [...store.rows].filter(([key]) => key.startsWith(`${RATE_LIMITS}/`));

test('a fixed window allows the limit, denies without writing, then resets on the injected clock', async () => {
  const store = memory({});
  const results = [];
  for (let index = 0; index < 5; index += 1) results.push(await consumeRateLimit(store, env, rule, at(index * 1000)));
  assert.deepEqual(results.map(result => [result.allowed, result.count, result.remaining]), [[true, 1, 2], [true, 2, 1], [true, 3, 0], [false, 3, 0], [false, 3, 0]]);
  assert.equal(results[0].windowStart, NOW); assert.equal(results[0].resetAt, at(60000));
  assert.equal(store.commits.length, 3, 'denied attempts write nothing');
  const [[key, row]] = counters(store);
  assert.equal(key, `${RATE_LIMITS}/${await rateLimitId(env, rule.bucket, rule.key, Date.parse(NOW))}`);
  assert.deepEqual(row, { bucket: 'synthetic_bucket', count: 3, windowStart: NOW, expiresAt: at(60000), createdAt: NOW, updatedAt: at(2000) });
  assert.equal((await consumeRateLimit(store, env, rule, at(59999))).allowed, false, 'still the same window');
  const next = await consumeRateLimit(store, env, rule, at(60000));
  assert.deepEqual([next.allowed, next.count, next.windowStart], [true, 1, at(60000)], 'a new window starts a new counter');
  assert.equal(counters(store).length, 2);
});

test('counter ids are purpose-keyed digests; keys, buckets and windows never collide or leak', async () => {
  const id = await rateLimitId(env, 'synthetic_bucket', 'phone:+19705550101', 1000);
  assert.equal(id, `rl_${await purposeSign(env, PURPOSES.rateLimit, 'synthetic_bucket|phone:+19705550101|1000')}`);
  assert.match(id, /^rl_[A-Za-z0-9_-]{43}$/);
  assert.ok(!id.includes('9705550101'));
  const ids = new Set(await Promise.all([['a', 'k', 0], ['b', 'k', 0], ['a', 'k2', 0], ['a', 'k', 60000]].map(([bucket, key, start]) => rateLimitId(env, bucket, key, start))));
  assert.equal(ids.size, 4);
  assert.notEqual(await rateLimitId({ HUB_PURPOSE_KEY_SECRET: 'another-synthetic-purpose-root-0123456789' }, 'a', 'k', 0), await rateLimitId(env, 'a', 'k', 0), 'the id depends on the server key');
  const store = memory({});
  await consumeRateLimit(store, env, { ...rule, key: 'phone:+19705550101' }, NOW);
  await consumeRateLimit(store, env, { ...rule, bucket: 'other_bucket', key: 'phone:+19705550101' }, NOW);
  assert.equal(counters(store).length, 2, 'the same key counts separately per bucket');
  assert.ok(!JSON.stringify([...store.rows]).includes('9705550101'), 'the key is never stored');
});

test('parallel attempts never exceed the limit: every increment is a compare-and-set', async () => {
  const store = memory({});
  const results = await Promise.all(Array.from({ length: 12 }, () => consumeRateLimit(store, env, { ...rule, limit: 5 }, NOW, { attempts: 20 })));
  assert.equal(results.filter(result => result.allowed).length, 5);
  assert.equal(counters(store)[0][1].count, 5);
  const creates = store.commits.flat().filter(write => !write.revision);
  assert.equal(creates.length, 1, 'exactly one writer created the counter');
});

test('sustained contention, malformed counters and lost responses fail closed', async () => {
  const contended = memory({});
  contended.hooks.beforeCommit = () => { throw Object.assign(new Error('Conflict'), { code: 'dispatch_revision_conflict', status: 409 }); };
  const denied = await consumeRateLimit(contended, env, rule, NOW);
  assert.deepEqual([denied.allowed, denied.reason], [false, 'contended']);
  for (const status of [400, 412]) {
    const failing = memory({}); let calls = 0;
    failing.hooks.beforeCommit = () => { calls += 1; if (calls === 1) throw Object.assign(new Error('FAILED_PRECONDITION'), { status }); };
    assert.equal((await consumeRateLimit(failing, env, rule, NOW)).allowed, true, `${status} is retried as a conflict`);
  }
  const id = await rateLimitId(env, rule.bucket, rule.key, Date.parse(NOW));
  for (const bad of [{ bucket: rule.bucket, count: 'many' }, { bucket: rule.bucket, count: -1 }, { bucket: 'other_bucket', count: 0 }, { bucket: rule.bucket, count: 1.5 }]) {
    const store = memory({ [`${RATE_LIMITS}/${id}`]: bad });
    const result = await consumeRateLimit(store, env, rule, NOW);
    assert.deepEqual([result.allowed, result.reason], [false, 'counter_invalid'], JSON.stringify(bad));
    assert.equal(store.commits.length, 0, 'a malformed counter is never overwritten');
  }
  const lost = memory({}); let lose = 1;
  lost.hooks.loseResponse = () => lose-- > 0;
  const first = await consumeRateLimit(lost, env, rule, NOW);
  assert.equal(first.allowed, true, 'a lost response is retried');
  assert.equal(counters(lost)[0][1].count, 2, 'and may only over-count');
  const alwaysLost = memory({});
  alwaysLost.hooks.loseResponse = () => true;
  assert.equal((await consumeRateLimit(alwaysLost, env, rule, NOW)).allowed, false, 'repeatedly lost responses exhaust the window instead of granting more');
  const down = memory({});
  down.hooks.failRead = () => true;
  await assert.rejects(consumeRateLimit(down, env, rule, NOW), code('dispatch_storage_unavailable'));
});

test('invalid rules and clocks are programmer errors', async () => {
  const store = memory({});
  for (const bad of [{ bucket: 'Bad Bucket' }, { key: '' }, { key: 'x'.repeat(600) }, { limit: 0 }, { limit: 1.5 }, { windowMs: 10 }, { windowMs: 8 * 86400000 }]) await assert.rejects(consumeRateLimit(store, env, { ...rule, ...bad }, NOW), code('rate_limit_invalid'), JSON.stringify(bad));
  await assert.rejects(consumeRateLimit(store, env, rule, 'not a time'), code('rate_limit_invalid'));
  await assert.rejects(consumeRateLimit(store, {}, rule, NOW), code('purpose_key_unavailable'), 'no server key, no counter');
});

test('cleanup deletes a bounded batch of expired records with revision preconditions', async () => {
  const calls = [];
  const root = 'projects/egcw-1ec83/databases/(default)/documents';
  const fetcher = async (settings, url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    if (String(url).endsWith(':runQuery')) return Response.json([
      { document: { name: `${root}/rate_limits/rl_old`, updateTime: '2026-09-22T10:00:00.000000Z', fields: {} } },
      { document: { name: `${root}/customer_sessions/cs_wrong_collection`, updateTime: 'x', fields: {} } },
      { document: { name: `${root}/rate_limits/nested/child`, updateTime: 'x', fields: {} } },
      { readTime: '2026-09-22T12:00:00Z' },
    ]);
    return Response.json({});
  };
  assert.equal(await cleanupExpiredRecords(env, RATE_LIMITS, NOW, { fetcher, limit: 25 }), 1);
  const query = calls[0].body.structuredQuery;
  assert.deepEqual(query.from, [{ collectionId: 'rate_limits' }]);
  assert.deepEqual(query.where.fieldFilter, { field: { fieldPath: 'expiresAt' }, op: 'LESS_THAN', value: { stringValue: '2026-09-22T11:00:00.000Z' } });
  assert.equal(query.limit, 25);
  assert.deepEqual(calls[1].body.writes, [{ delete: `${root}/rate_limits/rl_old`, currentDocument: { updateTime: '2026-09-22T10:00:00.000000Z' } }]);
  assert.equal(await cleanupExpiredRecords(env, 'jobs', NOW, { fetcher }), 0, 'only expiring server-only collections');
  assert.equal(calls.length, 2);
  assert.equal(await cleanupExpiredRecords(env, 'customer_sessions', NOW, { fetcher: async () => { throw new Error('offline'); } }), 0, 'best effort never throws');
  assert.equal(await cleanupExpiredRecords(env, 'customer_login_links', NOW, { fetcher: async () => Response.json({}, { status: 500 }) }), 0);
  assert.equal(await cleanupExpiredRecords(env, 'customer_login_links', NOW, { fetcher: async () => Response.json([]) }), 0);
  const capped = []; await cleanupExpiredRecords(env, RATE_LIMITS, NOW, { fetcher: async (s, url, options) => { capped.push(JSON.parse(options.body)); return Response.json([]); }, limit: 5000 });
  assert.equal(capped[0].structuredQuery.limit, 100);
});

test('client address keys: IPv4 as is, IPv6 by its /64, IPv4-mapped as IPv4, anything else one shared key', () => {
  const cases = [
    ['203.0.113.7', 'ip:203.0.113.7'], [' 203.0.113.07 ', 'ip:203.0.113.7'],
    ['2001:db8:1:2:3:4:5:6', 'ip:2001:db8:1:2::/64'], ['2001:DB8:1:2::9', 'ip:2001:db8:1:2::/64'], ['2001:db8:1:2:ffff:ffff:ffff:ffff', 'ip:2001:db8:1:2::/64'],
    ['2001:db8:1:3::1', 'ip:2001:db8:1:3::/64'], ['2001:db8::', 'ip:2001:db8:0:0::/64'], ['2001:0db8:0001:0002::', 'ip:2001:db8:1:2::/64'],
    ['2001:db8:1:2:3:4:192.0.2.1', 'ip:2001:db8:1:2::/64'], ['fe80::1%eth0', 'ip:fe80:0:0:0::/64'],
    ['::ffff:203.0.113.9', 'ip:203.0.113.9'], ['::ffff:cb00:7109', 'ip:203.0.113.9'],
  ];
  for (const [ip, key] of cases) assert.equal(clientAddressKey(ip), key, ip);
  for (const bad of ['', '   ', 'unknown', '256.1.1.1', '1.2.3', '1:2:3:4:5:6:7:8:9', '1:::2', ':1', '1::2::3', '2001:db8::1.2.3.999', 'x'.repeat(80), undefined, null, 42]) assert.equal(clientAddressKey(bad), 'ip:unknown', String(bad));
});

test('a rolling window never allows more than the limit in any window, even across a fixed-window edge', async () => {
  const store = memory({}), day = { bucket: 'synthetic_rolling', key: 'customer:customer-a', limit: 3, windowMs: 86400000 };
  const hour = 3600000, results = [];
  // Three attempts just before a midnight UTC fixed-window edge, then more just after it.
  for (const offset of [0, hour, 2 * hour, 2 * hour + 1000, 13 * hour]) results.push(await consumeRollingLimit(store, env, day, at(offset)));
  assert.deepEqual(results.map(result => [result.allowed, result.count, result.remaining]), [[true, 1, 2], [true, 2, 1], [true, 3, 0], [false, 3, 0], [false, 3, 0]]);
  assert.equal(results[2].resetAt, at(86400000), 'the next attempt opens when the oldest counted one leaves the window');
  assert.equal(store.commits.length, 3, 'denied attempts write nothing');
  const [[key, row]] = counters(store);
  assert.equal(key, `${RATE_LIMITS}/${await rateLimitId(env, day.bucket, day.key, 'rolling')}`);
  assert.deepEqual(row, { bucket: 'synthetic_rolling', hits: [NOW, at(hour), at(2 * hour)], windowMs: 86400000, createdAt: NOW, updatedAt: at(2 * hour), expiresAt: at(2 * hour + 86400000) });
  assert.ok(!JSON.stringify(row).includes('customer-a'), 'the key is never stored');
  assert.equal((await consumeRollingLimit(store, env, day, at(86400000 - 1))).allowed, false, 'one millisecond early');
  const reopened = await consumeRollingLimit(store, env, day, at(86400000));
  assert.deepEqual([reopened.allowed, reopened.count], [true, 3], 'exactly one day after the first attempt, one slot reopens');
  assert.deepEqual(counters(store)[0][1].hits, [at(hour), at(2 * hour), at(86400000)], 'expired attempts are dropped from the record');
  assert.equal((await consumeRollingLimit(store, env, day, at(86400000 + 1000))).allowed, false);
});

test('rolling limits compare-and-set under contention and fail closed on unreadable records', async () => {
  const store = memory({}), rolling = { ...rule, bucket: 'synthetic_rolling', limit: 4 };
  const results = await Promise.all(Array.from({ length: 10 }, () => consumeRollingLimit(store, env, rolling, NOW, { attempts: 20 })));
  assert.equal(results.filter(result => result.allowed).length, 4);
  assert.equal(counters(store)[0][1].hits.length, 4);
  const id = await rateLimitId(env, rolling.bucket, rolling.key, 'rolling');
  for (const broken of [{ hits: 'x' }, { hits: ['not a time'] }, { hits: [NOW], bucket: 'other_bucket' }, { hits: Array(51).fill(NOW) }]) {
    const bad = memory({ [`${RATE_LIMITS}/${id}`]: { bucket: rolling.bucket, ...broken } });
    const denied = await consumeRollingLimit(bad, env, rolling, NOW);
    assert.deepEqual([denied.allowed, denied.reason], [false, 'counter_invalid'], JSON.stringify(broken).slice(0, 40));
    assert.equal(bad.commits.length, 0);
  }
  // A time in the future (a skewed writer) still counts against the window.
  const skewed = memory({ [`${RATE_LIMITS}/${id}`]: { bucket: rolling.bucket, hits: [at(3600000), at(3600000), at(3600000), at(3600000)] } });
  assert.equal((await consumeRollingLimit(skewed, env, rolling, NOW)).allowed, false);
  const contended = memory({});
  contended.hooks.beforeCommit = () => { throw Object.assign(new Error('Conflict'), { code: 'dispatch_revision_conflict', status: 409 }); };
  assert.deepEqual(await consumeRollingLimit(contended, env, rolling, NOW).then(result => [result.allowed, result.reason]), [false, 'contended']);
  await assert.rejects(consumeRollingLimit(store, env, { ...rolling, limit: 51 }, NOW), code('rate_limit_invalid'));
  await assert.rejects(consumeRollingLimit(store, env, rolling, 'not a time'), code('rate_limit_invalid'));
});

test('a rolling attempt is given back once, by compare-and-set; a give-back that cannot be confirmed leaves the count', async () => {
  const day = { bucket: 'synthetic_rolling', key: 'customer:customer-a', limit: 3, windowMs: 86400000 };
  const id = await rateLimitId(env, day.bucket, day.key, 'rolling'), record = store => store.get(`${RATE_LIMITS}/${id}`);
  const store = memory({});
  for (const offset of [0, 0, 60000]) assert.equal((await consumeRollingLimit(store, env, day, at(offset))).allowed, true);
  assert.equal((await consumeRollingLimit(store, env, day, at(120000))).allowed, false);
  const { expiresAt } = record(store);
  assert.equal(await releaseRollingLimit(store, env, day, NOW, at(120000)), true);
  assert.deepEqual([record(store).hits, record(store).updatedAt, record(store).expiresAt], [[NOW, at(60000)], at(120000), expiresAt], 'one of two identical times is removed');
  assert.ok(store.commits.at(-1)[0].revision, 'conditioned on the revision that was read');
  assert.equal((await consumeRollingLimit(store, env, day, at(180000))).allowed, true, 'the slot is free again');
  assert.equal(await releaseRollingLimit(store, env, day, at(5000), at(200000)), false, 'a time that was never counted');
  assert.equal(await releaseRollingLimit(store, env, { ...day, key: 'customer:customer-b' }, NOW, at(200000)), false, 'no record');
  assert.equal(await releaseRollingLimit(store, env, day, 'not a time', at(200000)), false);
  await assert.rejects(releaseRollingLimit(store, env, { ...day, bucket: 'Bad Bucket' }, NOW), code('rate_limit_invalid'));
  assert.deepEqual(record(store).hits, [NOW, at(60000), at(180000)]);
  // A definite conflict is retried on a fresh read.
  let conflicts = 1;
  store.hooks.beforeCommit = () => { if (conflicts-- > 0) throw Object.assign(new Error('Conflict'), { code: 'dispatch_revision_conflict', status: 409 }); };
  assert.equal(await releaseRollingLimit(store, env, day, at(180000), at(200000)), true);
  assert.deepEqual(record(store).hits, [NOW, at(60000)]);
  // Sustained contention, an outage or a malformed record: nothing is given back and nothing throws.
  store.hooks.beforeCommit = () => { throw Object.assign(new Error('Conflict'), { code: 'dispatch_revision_conflict', status: 409 }); };
  assert.equal(await releaseRollingLimit(store, env, day, NOW, at(200000)), false);
  store.hooks.beforeCommit = () => { throw Object.assign(new Error('Synthetic outage'), { code: 'dispatch_storage_unavailable', status: 503 }); };
  assert.equal(await releaseRollingLimit(store, env, day, NOW, at(200000)), false);
  store.hooks.beforeCommit = null;
  store.hooks.failRead = () => true;
  assert.equal(await releaseRollingLimit(store, env, day, NOW, at(200000)), false);
  store.hooks.failRead = null;
  assert.deepEqual(record(store).hits, [NOW, at(60000)]);
  for (const broken of [{ hits: 'x' }, { hits: [NOW, 'not a time'] }, { hits: [NOW], bucket: 'other_bucket' }]) {
    const bad = memory({ [`${RATE_LIMITS}/${id}`]: { bucket: day.bucket, ...broken } });
    assert.equal(await releaseRollingLimit(bad, env, day, NOW, at(200000)), false, JSON.stringify(broken));
    assert.equal(bad.commits.length, 0, 'an unreadable record is never rewritten');
  }
  // A lost commit response is not retried: a retry could remove a second, identical time.
  const lost = memory({});
  for (const offset of [0, 0]) await consumeRollingLimit(lost, env, day, at(offset));
  lost.hooks.loseResponse = () => true;
  assert.equal(await releaseRollingLimit(lost, env, day, NOW, at(200000)), false);
  assert.deepEqual(record(lost).hits, [NOW], 'exactly one time was removed');
});
