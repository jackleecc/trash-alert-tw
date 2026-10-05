import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchGroupMemberCount } from '../lib/lineClient.js';

test('fetchGroupMemberCount - returns count when LINE API responds 200', async () => {
  const customFetch = async (url, options) => {
    assert.equal(url, 'https://api.line.me/v2/bot/group/C123/members/count');
    assert.equal(options.headers.Authorization, 'Bearer mock-ty-token');
    return {
      ok: true,
      status: 200,
      json: async () => ({ count: 9 }),
    };
  };

  const count = await fetchGroupMemberCount('C123', {
    token: 'mock-ty-token',
    fetchFn: customFetch,
  });

  assert.equal(count, 9);
});

test('fetchGroupMemberCount - returns fallback (default 1) when LINE API returns 404', async () => {
  const customFetch = async () => ({
    ok: false,
    status: 404,
    text: async () => 'Not found',
  });

  const count = await fetchGroupMemberCount('C_NOT_FOUND', {
    token: 'mock-token',
    fetchFn: customFetch,
    fallbackCount: 1,
  });

  assert.equal(count, 1);
});

test('fetchGroupMemberCount - returns custom fallback when network throws', async () => {
  const customFetch = async () => {
    throw new Error('Network timeout');
  };

  const count = await fetchGroupMemberCount('C_TIMEOUT', {
    token: 'mock-token',
    fetchFn: customFetch,
    fallbackCount: 3,
  });

  assert.equal(count, 3);
});
