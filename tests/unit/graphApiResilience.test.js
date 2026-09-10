'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const GraphApiClient = require('../../app/graphApi/index.js');

// Tests drive makeRequest() through stubbed acquireToken/fetch and an instant
// _sleep, so no Electron runtime or network is involved. The recorded sleep
// delays double as assertions on the backoff behavior.

function makeClient() {
  const client = new GraphApiClient({ graphApi: { enabled: true } });
  client.enabled = true;
  client.mainWindow = { webContents: {} }; // acquireToken is stubbed; shape only
  client.delays = [];
  client._sleep = async (ms) => {
    client.delays.push(ms);
  };
  return client;
}

function jsonResponse(status, body = {}, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === null ? '' : JSON.stringify(body)),
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  };
}

function tokenSuccess(token = 'tok') {
  return { success: true, token, expiry: new Date(Date.now() + 3600_000).toISOString() };
}

describe('GraphApiClient retry behavior', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns the successful response without retries', async () => {
    const client = makeClient();
    client.acquireToken = async () => tokenSuccess();
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return jsonResponse(200, { value: [1] });
    };

    const result = await client.makeRequest('/me');

    assert.deepStrictEqual(result, { success: true, data: { value: [1] } });
    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(client.delays, []);
  });

  it('retries 429 honoring Retry-After seconds and succeeds', async () => {
    const client = makeClient();
    client.acquireToken = async () => tokenSuccess();
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse(429, { error: { message: 'throttled' } }, { 'retry-after': '2' })
        : jsonResponse(200, { ok: true });
    };

    const result = await client.makeRequest('/me/messages');

    assert.strictEqual(result.success, true);
    assert.strictEqual(calls, 2);
    assert.deepStrictEqual(client.delays, [2000]);
  });

  it('parses a Retry-After HTTP-date into a delay', async () => {
    const client = makeClient();
    client.acquireToken = async () => tokenSuccess();
    const retryAt = new Date(Date.now() + 1000);
    globalThis.fetch = async () =>
      jsonResponse(429, {}, { 'retry-after': retryAt.toUTCString() });

    const result = await client.makeRequest('/me');

    // Persistent 429 exhausts the retry budget: initial + 3 retries.
    assert.strictEqual(result.success, false);
    assert.strictEqual(client.delays.length, 3);
    for (const delay of client.delays) {
      assert.ok(delay >= 0 && delay <= 1000, `delay ${delay} should come from the HTTP-date, not exponential backoff`);
    }
  });

  it('uses exponential backoff when Retry-After is absent', async () => {
    const client = makeClient();
    client.acquireToken = async () => tokenSuccess();
    globalThis.fetch = async () => jsonResponse(429, {});

    const result = await client.makeRequest('/me');

    // GET is idempotent, so 429 attempts exhaust: initial + 3 retries.
    assert.strictEqual(result.success, false);
    assert.strictEqual(client.delays.length, 3);
    assert.deepStrictEqual(client.delays, [500, 1000, 2000]);
  });

  it('caps the backoff delay', async () => {
    const client = makeClient();
    client.acquireToken = async () => tokenSuccess();
    // Make the request always return 429 and force a tiny Retry-After so the
    // exponential path is what grows: patch _retryDelayMs's base via attempt
    // count is not possible, so instead assert the cap directly on the helper.
    globalThis.fetch = async () => jsonResponse(429, {});

    const delay = client._retryDelayMs(
      { headers: { get: () => null } },
      30,
    );

    assert.strictEqual(delay, 8000);
  });

  it('retries 5xx only for idempotent methods', async () => {
    const client = makeClient();
    client.acquireToken = async () => tokenSuccess();

    let getCalls = 0;
    globalThis.fetch = async () => {
      getCalls += 1;
      return jsonResponse(503, {});
    };
    const getResult = await client.makeRequest('/me');
    assert.strictEqual(getResult.success, false);
    assert.strictEqual(getCalls, 4);

    let postCalls = 0;
    globalThis.fetch = async () => {
      postCalls += 1;
      return jsonResponse(503, {});
    };
    const postResult = await client.makeRequest('/me/calendar/events', {
      method: 'POST',
      body: { subject: 'x' },
    });
    assert.strictEqual(postResult.success, false);
    assert.strictEqual(postCalls, 1);
  });

  it('retries a 5xx request that then succeeds', async () => {
    const client = makeClient();
    client.acquireToken = async () => tokenSuccess();
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return calls === 1 ? jsonResponse(502, {}) : jsonResponse(200, { fine: true });
    };

    const result = await client.makeRequest('/me');
    assert.strictEqual(result.success, true);
    assert.strictEqual(calls, 2);
  });

  it('refreshes the token once on 401 and retries', async () => {
    const client = makeClient();
    let tokenCalls = 0;
    const seenTokens = [];
    client.acquireToken = async (forceRefresh) => {
      tokenCalls += 1;
      seenTokens.push(forceRefresh ? 'fresh' : 'stale');
      return tokenSuccess(forceRefresh ? 'fresh' : 'stale');
    };
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
      calls += 1;
      const auth = init.headers.Authorization;
      return auth === 'Bearer fresh'
        ? jsonResponse(200, { ok: true })
        : jsonResponse(401, { error: { message: 'invalid token' } });
    };

    const result = await client.makeRequest('/me');

    assert.strictEqual(result.success, true);
    assert.strictEqual(calls, 2);
    // The second attempt must carry the refreshed token (forceRefresh=true).
    assert.deepStrictEqual(seenTokens, ['stale', 'fresh']);
  });

  it('does not loop on repeated 401s — fails after one refresh', async () => {
    const client = makeClient();
    client.acquireToken = async () => tokenSuccess('always-bad');
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return jsonResponse(401, {});
    };

    const result = await client.makeRequest('/me');

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.status, 401);
    assert.strictEqual(calls, 2);
  });

  it('does not retry a permanent 4xx failure', async () => {
    const client = makeClient();
    client.acquireToken = async () => tokenSuccess();
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return jsonResponse(403, { error: { message: 'forbidden' } });
    };

    const result = await client.makeRequest('/me/presence');

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.status, 403);
    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(client.delays, []);
  });

  it('stops retrying once attempts are exhausted and reports failure', async () => {
    const client = makeClient();
    client.acquireToken = async () => tokenSuccess();
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return jsonResponse(429, { error: { message: 'still throttled' } });
    };

    const result = await client.makeRequest('/me');

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, 'still throttled');
    assert.strictEqual(calls, 4);
  });

  it('does not retry when token acquisition fails', async () => {
    const client = makeClient();
    client.acquireToken = async () => ({ success: false, error: 'no window' });
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return jsonResponse(200);
    };

    const result = await client.makeRequest('/me');

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, 'Failed to acquire token');
    assert.strictEqual(calls, 0);
  });
});

describe('GraphApiClient _parseRetryAfterMs', () => {
  const client = makeClient();

  it('parses delay-seconds', () => {
    assert.strictEqual(client._parseRetryAfterMs('3'), 3000);
  });

  it('returns 0 for a zero delay and null for junk', () => {
    assert.strictEqual(client._parseRetryAfterMs('0'), 0);
    assert.strictEqual(client._parseRetryAfterMs('soon'), null);
    assert.strictEqual(client._parseRetryAfterMs(''), null);
    assert.strictEqual(client._parseRetryAfterMs(undefined), null);
  });

  it('parses an HTTP-date in the past as zero', () => {
    assert.strictEqual(client._parseRetryAfterMs('Wed, 21 Oct 2015 07:28:00 GMT'), 0);
  });
});
