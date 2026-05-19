import { expect, test } from 'vite-plus/test';
import { DifftStore, type DifftEntry, type DifftRunResult } from './difftStore.ts';

type Deferred = {
  promise: Promise<DifftRunResult>;
  reject(error: unknown): void;
  resolve(value: DifftRunResult): void;
};

const defer = (): Deferred => {
  let resolve!: (value: DifftRunResult) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<DifftRunResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
};

const entry = (sectionId: string): DifftEntry => ({
  newContents: '',
  newName: sectionId,
  oldContents: '',
  oldName: sectionId,
  path: sectionId,
  sectionId,
});

const makeStore = (maxInflight = 2, maxQueue = 3) => {
  const pending: Array<Deferred> = [];
  const runner = () => {
    const d = defer();
    pending.push(d);
    return d.promise;
  };
  const store = new DifftStore({ maxInflight, maxQueue, runner });
  return { pending, store };
};

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test('DifftStore.ensureRequested dispatches up to maxInflight runners immediately', () => {
  const { pending, store } = makeStore(2, 3);
  store.ensureRequested(entry('a'));
  store.ensureRequested(entry('b'));
  store.ensureRequested(entry('c'));
  expect(pending).toHaveLength(2);
  expect(store.getStatus('a')).toBe('pending');
  expect(store.getStatus('b')).toBe('pending');
  expect(store.getStatus('c')).toBe('pending');
});

test('DifftStore drains the queue after each completion', async () => {
  const { pending, store } = makeStore(2, 3);
  store.ensureRequested(entry('a'));
  store.ensureRequested(entry('b'));
  store.ensureRequested(entry('c'));
  pending[0].resolve({ json: '{"chunks":[]}' });
  await tick();
  expect(pending).toHaveLength(3);
  expect(store.getStatus('a')).toBe('succeeded');
  expect(store.getStatus('c')).toBe('pending');
});

test('DifftStore.ensureRequested is idempotent for already in-flight sections', () => {
  const { pending, store } = makeStore(2, 3);
  store.ensureRequested(entry('a'));
  store.ensureRequested(entry('a'));
  expect(pending).toHaveLength(1);
});

test('DifftStore evicts the oldest pending entry when queue is full', () => {
  const { pending, store } = makeStore(1, 2);
  store.ensureRequested(entry('inflight'));
  store.ensureRequested(entry('q1'));
  store.ensureRequested(entry('q2'));
  store.ensureRequested(entry('q3'));
  // queue can hold 2; q1 was evicted to make room for q3.
  expect(pending).toHaveLength(1);
  pending[0].resolve({ json: '{"chunks":[]}' });
  return tick().then(() => {
    // q2 dispatched next (q1 evicted).
    expect(pending[1]).toBeDefined();
  });
});

test('DifftStore.getJson and getStatus reflect resolved results', async () => {
  const { pending, store } = makeStore();
  store.ensureRequested(entry('a'));
  pending[0].resolve({ json: '{"x":1}' });
  await tick();
  expect(store.getJson('a')).toBe('{"x":1}');
  expect(store.getStatus('a')).toBe('succeeded');
});

test('DifftStore.getStatus returns errored when the runner returns error', async () => {
  const { pending, store } = makeStore();
  store.ensureRequested(entry('a'));
  pending[0].resolve({ error: 'boom' });
  await tick();
  expect(store.getStatus('a')).toBe('errored');
  expect(store.getJson('a')).toBeNull();
});

test('DifftStore.prune drops results and queue entries; leaves in-flight alone', async () => {
  const { pending, store } = makeStore(1, 3);
  store.ensureRequested(entry('done'));
  store.ensureRequested(entry('inflight'));
  store.ensureRequested(entry('queued1'));
  store.ensureRequested(entry('queued2'));
  pending[0].resolve({ json: '{}' });
  await tick();
  // done → result, inflight → running, queued1+queued2 → queued
  expect(store.getStatus('done')).toBe('succeeded');
  store.prune(new Set(['inflight', 'queued2']));
  expect(store.getStatus('done')).toBe('idle');
  // in-flight is intentionally left alone even when 'live' (no cancel API)
  expect(store.getStatus('inflight')).toBe('pending');
  // queued1 was in queue, not in liveSectionIds → dropped
  expect(store.getStatus('queued1')).toBe('idle');
  expect(store.getStatus('queued2')).toBe('pending');
});

test('DifftStore.subscribe fires on enqueue and on completion', async () => {
  const { pending, store } = makeStore();
  let calls = 0;
  const unsubscribe = store.subscribe(() => {
    calls += 1;
  });
  store.ensureRequested(entry('a'));
  const callsAfterEnqueue = calls;
  pending[0].resolve({ json: '{}' });
  await tick();
  expect(callsAfterEnqueue).toBeGreaterThan(0);
  expect(calls).toBeGreaterThan(callsAfterEnqueue);
  unsubscribe();
});

test('DifftStore.getSnapshot returns identity-stable sets between mutations', () => {
  const { pending, store } = makeStore();
  const a = store.getSnapshot();
  const b = store.getSnapshot();
  expect(a).toBe(b);
  store.ensureRequested(entry('s'));
  const c = store.getSnapshot();
  expect(c).not.toBe(a);
  expect(c.has('s')).toBe(true);
  pending[0].resolve({ json: '{}' });
});

test('DifftStore invokes onError when a runner errors', async () => {
  const errors: Array<[string, string]> = [];
  const pending: Array<Deferred> = [];
  const runner = () => {
    const d = defer();
    pending.push(d);
    return d.promise;
  };
  const store = new DifftStore({
    maxInflight: 1,
    maxQueue: 1,
    onError: (path, reason) => errors.push([path, reason]),
    runner,
  });
  store.ensureRequested(entry('boom'));
  pending[0].resolve({ error: 'oh no' });
  await tick();
  expect(errors).toEqual([['boom', 'oh no']]);
});
