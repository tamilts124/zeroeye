/**
 * validate_single_flight.mjs
 *
 * Deterministic validation script for single-flight token refresh behaviour.
 *
 * Validates:
 *   1. Concurrent success: N concurrent callers share ONE in-flight refresh,
 *      all resolve with the same token object, and only one network request
 *      is made.
 *   2. Concurrent failure: When the refresh request rejects, all concurrent
 *      callers resolve to `null` and the in-flight marker is cleared so a
 *      subsequent call can retry.
 *   3. Sequential retry: After a failed refresh, a new call succeeds normally.
 *
 * Run with:  node frontend/validate_single_flight.mjs
 */

// ---------------------------------------------------------------------------
// Minimal stubs for browser globals used by auth.ts logic
// ---------------------------------------------------------------------------

// We re-implement only the single-flight logic here so this script has zero
// external dependencies and runs in plain Node.js.

// ---------------------------------------------------------------------------
// Simulated single-flight refresh implementation (mirrors auth.ts exactly)
// ---------------------------------------------------------------------------

let _refreshInflight = null;
let networkCallCount = 0;

/**
 * Simulated refreshTokens().
 * @param {() => Promise<{tokens: object}>} networkFn  — the "real" network request
 * @param {object|null} currentTokens
 */
async function refreshTokens(networkFn, currentTokens) {
  if (_refreshInflight !== null) {
    return _refreshInflight;
  }

  if (!currentTokens?.refreshToken) return null;

  _refreshInflight = (async () => {
    try {
      networkCallCount++;
      const response = await networkFn();
      _refreshInflight = null;
      return response.tokens;
    } catch {
      _refreshInflight = null;
      return null;
    }
  })();

  return _refreshInflight;
}

function resetState() {
  _refreshInflight = null;
  networkCallCount = 0;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓  ${message}`);
    passed++;
  } else {
    console.error(`  ✗  ${message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Test 1: Concurrent success — single network call, all callers get same token
// ---------------------------------------------------------------------------

async function testConcurrentSuccess() {
  console.log('\nTest 1: Concurrent success');
  resetState();

  const fakeTokens = { accessToken: 'tok_abc', refreshToken: 'rtok_xyz', expiresIn: 3600, tokenType: 'Bearer' };
  const currentTokens = { refreshToken: 'rtok_xyz' };

  let resolveNetwork;
  const networkFn = () => new Promise((res) => { resolveNetwork = () => res({ tokens: fakeTokens }); });

  // Fire 5 concurrent callers before the network call resolves
  const callers = Array.from({ length: 5 }, () => refreshTokens(networkFn, currentTokens));

  // Let the event loop advance so all callers attach to the same inflight promise
  await Promise.resolve();

  // Now resolve the network request
  resolveNetwork();

  const results = await Promise.all(callers);

  assert(networkCallCount === 1, `Only 1 network request made (got ${networkCallCount})`);
  assert(results.every(r => r === results[0]), 'All callers received the same token object reference');
  assert(results[0] === fakeTokens, 'Resolved token matches the server response');
  assert(_refreshInflight === null, 'In-flight marker cleared after success');
}

// ---------------------------------------------------------------------------
// Test 2: Concurrent failure — all callers get null, marker cleared
// ---------------------------------------------------------------------------

async function testConcurrentFailure() {
  console.log('\nTest 2: Concurrent failure');
  resetState();

  const currentTokens = { refreshToken: 'rtok_xyz' };

  let rejectNetwork;
  const networkFn = () => new Promise((_, rej) => { rejectNetwork = () => rej(new Error('401 Unauthorized')); });

  const callers = Array.from({ length: 5 }, () => refreshTokens(networkFn, currentTokens));

  await Promise.resolve();

  rejectNetwork();

  const results = await Promise.all(callers);

  assert(networkCallCount === 1, `Only 1 network request made on failure (got ${networkCallCount})`);
  assert(results.every(r => r === null), 'All callers received null on failure');
  assert(_refreshInflight === null, 'In-flight marker cleared after failure');
}

// ---------------------------------------------------------------------------
// Test 3: Sequential retry after failure succeeds
// ---------------------------------------------------------------------------

async function testSequentialRetryAfterFailure() {
  console.log('\nTest 3: Sequential retry after failure');
  resetState();

  const fakeTokens = { accessToken: 'tok_new', refreshToken: 'rtok_new', expiresIn: 3600, tokenType: 'Bearer' };
  const currentTokens = { refreshToken: 'rtok_old' };

  // First call: fails
  const failFn = () => Promise.reject(new Error('Network error'));
  const firstResult = await refreshTokens(failFn, currentTokens);

  assert(firstResult === null, 'First (failed) call returns null');
  assert(_refreshInflight === null, 'In-flight marker cleared after first failure');

  const prevCount = networkCallCount;

  // Second call: succeeds
  const successFn = () => Promise.resolve({ tokens: fakeTokens });
  const secondResult = await refreshTokens(successFn, currentTokens);

  assert(networkCallCount === prevCount + 1, 'Retry issues a new network request');
  assert(secondResult === fakeTokens, 'Retry resolves with new tokens');
  assert(_refreshInflight === null, 'In-flight marker cleared after retry success');
}

// ---------------------------------------------------------------------------
// Test 4: No token available returns null without network call
// ---------------------------------------------------------------------------

async function testNoRefreshToken() {
  console.log('\nTest 4: No refresh token available');
  resetState();

  const networkFn = () => Promise.resolve({ tokens: {} });
  const result = await refreshTokens(networkFn, null);

  assert(result === null, 'Returns null when no refresh token');
  assert(networkCallCount === 0, 'No network call made when refresh token absent');
}

// ---------------------------------------------------------------------------
// Run all tests
// ---------------------------------------------------------------------------

(async () => {
  console.log('=== Single-flight token refresh validation ===');

  await testConcurrentSuccess();
  await testConcurrentFailure();
  await testSequentialRetryAfterFailure();
  await testNoRefreshToken();

  console.log(`\n${'='.repeat(46)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('All validation checks passed.');
    process.exit(0);
  }
})();
