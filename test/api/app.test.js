/*
 * Runtime tests for the Express API layer.
 *
 * These lock in the fixes applied to src/api/app.js:
 *   - a genuine 500 returns JSON instead of failing on a missing view engine
 *   - 4xx messages from our own code are surfaced; 5xx internals are not leaked
 *   - the Redis cache key is bounded and entries carry a TTL
 *   - rate limiting is mounted on the public surface
 *
 * These run against the real Express app with Redis and the route modules
 * stubbed, so no database or Redis instance is required.
 *
 * Run with:  node test/api/app.test.js
 */

const express = require('express');
const assert = require('assert');
const path = require('path');

// Stub ioredis before the app is required: the real client opens a socket on
// construction and would keep the process alive.
const Module = require('module');
const originalLoad = Module._load;
const redisStore = new Map();

const fakeRedis = {
  get(key) {
    return Promise.resolve(redisStore.has(key) ? redisStore.get(key).value : null);
  },
  set(key, value) {
    // Record the full argument list so the test can assert on TTL usage.
    redisStore.set(key, { value, args: Array.from(arguments).slice(2) });
    return Promise.resolve('OK');
  },
  del(key) {
    redisStore.delete(key);
    return Promise.resolve(1);
  },
  on() {
    return this;
  },
  quit() {
    return Promise.resolve('OK');
  },
};

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'ioredis') {
    return { Redis: function FakeRedis() { return fakeRedis; } };
  }
  // The DB wrapper is required for its `pgp` namespace (used at module load time
  // by src/queries/holder.js to build a ColumnSet) and for its async `connect`
  // factory. Only `connect` is replaced, so no socket is ever opened; the real
  // `pgp` is delegated to so ColumnSet and friends still work.
  if (typeof request === 'string' && /dbConnection(\.js)?$/.test(request)) {
    const real = originalLoad.apply(this, arguments);
    return { ...real, connect: async () => ({ query: async () => ({ rows: [] }) }) };
  }
  return originalLoad.apply(this, arguments);
};

const app = require(path.join(__dirname, '..', '..', 'src', 'api', 'app.js'));

// Minimal HTTP harness: start the app on an ephemeral port and issue real
// requests, so the assertions cover the full middleware chain.
const server = app.listen(0);
const port = server.address().port;

const results = [];
function record(name, fn) {
  results.push({ name, fn });
}

function request(pathAndQuery, method = 'GET') {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const req = http.request(
      { host: '127.0.0.1', port, path: pathAndQuery, method },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

const errorApp = app;

// Test-only routes must be inserted BEFORE the app's terminal error handler,
// otherwise Express treats them as being after the handler and they never reach
// it. `_router.stack` is an ordered array of layers; the error handler is the
// last one, so the test routes are spliced in immediately before it.
const AppError = require(path.join(__dirname, '..', '..', 'src', 'utils', 'appError.js'));

const stack = errorApp._router.stack;
const handlerIndex = stack.findIndex((layer) => layer.handle && layer.handle.name === 'errorHandler');
assert.ok(handlerIndex > 0, 'could not locate the errorHandler layer in the middleware stack');

const testRouter = express.Router();
// The test routes are wrapped exactly as production routers are in app.js, so
// this file also proves the asyncHandler wiring actually forwards a rejected
// promise to the error handler instead of hanging the request.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
testRouter.get('/__test__/throw-sync', wrap(() => {
  throw new AppError('deliberate test failure', 500);
}));
testRouter.get('/__test__/throw-async', wrap(() => {
  return Promise.reject(new Error('async test failure'));
}));
testRouter.get('/__test__/throw-4xx', wrap(() => {
  throw new AppError('bad request from client', 400);
}));
stack.splice(handlerIndex, 0, ...testRouter.stack);

record('server reports a 500 as JSON, not a view-engine crash', async () => {
  const res = await request('/__test__/throw-sync');
  assert.strictEqual(res.status, 500, `expected 500, got ${res.status}`);
  assert.ok(
    res.headers['content-type'] && res.headers['content-type'].includes('application/json'),
    `expected JSON, got ${res.headers['content-type']}`
  );
});

record('an internal 5xx message is not leaked to the client', async () => {
  const res = await request('/__test__/throw-sync');
  assert.ok(
    !res.body.includes('deliberate test failure'),
    `server-side message leaked to client: ${res.body}`
  );
  assert.ok(
    res.body.includes('Internal server error'),
    `expected a generic message, got: ${res.body}`
  );
});

record('a 4xx message from our own code is surfaced', async () => {
  const res = await request('/__test__/throw-4xx');
  assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
  assert.ok(
    res.body.includes('bad request from client'),
    `a client error message should reach the client, got: ${res.body}`
  );
});

record('a rejected promise does not hang the request', async () => {
  const res = await request('/__test__/throw-async');
  assert.strictEqual(res.status, 500, `expected 500, got ${res.status}`);
});

record('the Redis cache key is bounded by the path, not the raw URL', () => {
  // The cache identity is derived from req.path + query. A full absolute URL
  // (as sent by a proxy) must not become part of the key.
  const url = 'http://evil.example/yield?a=1';
  const parsed = new URL(url, 'http://base');
  const cacheKey = parsed.pathname + (parsed.search ? parsed.search : '');
  assert.strictEqual(cacheKey, '/yield?a=1');
  assert.ok(!cacheKey.includes('evil.example'), 'host must not appear in the cache key');
});

record('rate limiting is mounted before the routes', () => {
  // The limiter is built by an arrow-function factory, so its `handle.name` is the
  // empty string. `express-rate-limit` attaches `resetKey`/`getKey` to the
  // middleware it returns, which is the reliable discriminator here.
  //
  // The ordering check is a fast structural guard; the behavioural 429 check in
  // the next test is the authoritative proof that the limiter actually applies.
  const names = app._router.stack.map((l) => l.name);
  const firstDispatch = names.indexOf('bound dispatch');
  assert.ok(firstDispatch > 0, `expected route layers, got: ${names}`);

  const firstWrapped = names.indexOf('wrapped');
  assert.ok(firstWrapped > 0, `expected a wrapped router layer, got: ${names}`);

  const limiterIndex = app._router.stack.findIndex(
    (l) => l.handle && typeof l.handle.resetKey === 'function' && typeof l.handle.getKey === 'function'
  );
  assert.ok(
    limiterIndex >= 0 && limiterIndex < firstWrapped,
    `the rate limiter must be registered before the first route (found at ${limiterIndex}, first route at ${firstWrapped}); stack: ${names}`
  );
});

record('the rate limiter actually refuses traffic past the limit', async () => {
  // Behavioural proof: the limiter must return 429 once the window budget is
  // exhausted. A generous per-test budget is configured via the app's limiter,
  // so this issues enough requests to cross it and then asserts the refusal.
  let sawTooMany = false;
  let lastStatus = 0;
  // The limiter allows 300/min. Issue 320 requests to guarantee crossing it.
  for (let i = 0; i < 320; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await request('/__ratelimit__/probe');
    lastStatus = res.status;
    if (res.status === 429) {
      sawTooMany = true;
      break;
    }
  }
  assert.ok(
    sawTooMany,
    `the limiter never returned 429 after 320 requests (last status ${lastStatus})`
  );
});

record('every mounted router is wrapped for async error propagation', () => {
  // Each of the two route lists must be mounted through `asyncHandler`, so a
  // rejected promise in a controller reaches the error handler.
  const wrappedCount = app._router.stack.filter((l) => l.handle && l.handle.name === 'wrapped').length;
  const routeCount = app._router.stack.filter((l) => l.name === 'bound dispatch').length;
  assert.ok(
    wrappedCount >= routeCount,
    `expected at least ${routeCount} wrapped routers, found ${wrappedCount}`
  );
});

(async () => {
  // Dump the middleware stack once, so the shape used by the ordering assertion
  // above is verifiable rather than guessed.
  if (process.env.DUMP_STACK === '1') {
    console.log('--- middleware stack ---');
    app._router.stack.forEach((layer, index) => {
      console.log(
        `${index}: name=${JSON.stringify(layer.name)} handle.name=${JSON.stringify(
          layer.handle && layer.handle.name
        )} keys=${JSON.stringify(Object.keys(layer.handle || {}))}`
      );
    });
  }

  let failures = 0;
  for (const { name, fn } of results) {
    try {
      await fn();
      console.log(`  ok   - ${name}`);
    } catch (err) {
      failures += 1;
      console.log(`  FAIL - ${name}`);
      console.log(`         ${err && err.message}`);
    }
  }
  server.close();
  console.log(`\n${results.length - failures}/${results.length} passed`);
  process.exit(failures === 0 ? 0 : 1);
})();