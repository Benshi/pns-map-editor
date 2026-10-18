import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('./sw.js', import.meta.url), 'utf8');
const cacheName = source.match(/const CACHE = '([^']+)'/)[1];

function createWorker(active = null) {
  const listeners = new Map();
  const state = { skipped: 0, claimed: 0, deleted: [], cached: [] };
  const self = {
    location: { origin: 'https://example.test' },
    registration: { scope: 'https://example.test/app/', active },
    clients: { claim: async () => { state.claimed++; } },
    addEventListener: (name, listener) => listeners.set(name, listener),
    skipWaiting: async () => { state.skipped++; },
  };
  const caches = {
    open: async name => ({
      addAll: async requests => { state.cached.push({ name, requests }); },
    }),
    keys: async () => ['pns-map-editor-old', 'unrelated-cache', cacheName],
    delete: async name => { state.deleted.push(name); },
    match: async () => null,
  };
  vm.runInNewContext(source, { self, caches, URL, Request, Promise });
  return { listeners, state, cacheName };
}

test('first installation activates so an offline-capable page can take control', async () => {
  const worker = createWorker();
  let completion;
  worker.listeners.get('install')({ waitUntil: promise => { completion = promise; } });
  await completion;
  assert.equal(worker.state.skipped, 1);
  assert.equal(worker.state.cached[0].name, worker.cacheName);
});

test('an update waits for user approval before activating', async () => {
  const worker = createWorker({ state: 'activated' });
  let completion;
  worker.listeners.get('install')({ waitUntil: promise => { completion = promise; } });
  await completion;
  assert.equal(worker.state.skipped, 0);

  worker.listeners.get('message')({
    data: { type: 'SKIP_WAITING' },
    waitUntil: promise => { completion = promise; },
  });
  await completion;
  assert.equal(worker.state.skipped, 1);
});

test('activation removes only older application caches and claims clients', async () => {
  const worker = createWorker();
  let completion;
  worker.listeners.get('activate')({ waitUntil: promise => { completion = promise; } });
  await completion;
  assert.deepEqual(worker.state.deleted, ['pns-map-editor-old']);
  assert.equal(worker.state.claimed, 1);
});
