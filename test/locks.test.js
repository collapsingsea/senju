import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LockManager } from '../src/index.js';
import { tick } from './helpers.js';

test('grants in FIFO order', async () => {
  const locks = new LockManager();
  const order = [];
  const a = await locks.acquire(['pc'], 'a');
  const pb = locks.acquire(['pc'], 'b').then((l) => { order.push('b'); return l; });
  const pc = locks.acquire(['pc'], 'c').then((l) => { order.push('c'); return l; });
  await tick();
  assert.deepEqual(order, []);
  a.release();
  const b = await pb;
  assert.deepEqual(order, ['b']);
  b.release();
  (await pc).release();
  assert.deepEqual(order, ['b', 'c']);
  assert.deepEqual(locks.holders(), {});
});

test('overlapping sets do not deadlock (sorted acquisition)', async () => {
  const locks = new LockManager();
  const run = async (owner, names) => {
    const l = await locks.acquire(names, owner);
    await tick(1);
    l.release();
    return owner;
  };
  const done = await Promise.race([
    Promise.all([run('x', ['a', 'b']), run('y', ['b', 'a']), run('z', ['a', 'b'])]),
    tick(500).then(() => 'deadlock'),
  ]);
  assert.deepEqual(done, ['x', 'y', 'z']);
});

test('abort removes the waiter and releases partial holds', async () => {
  const locks = new LockManager();
  const holdB = await locks.acquire(['b'], 'other');
  const ac = new AbortController();
  const p = locks.acquire(['a', 'b'], 'me', ac.signal); // gets a, waits on b
  await tick();
  assert.equal(locks.holders().a, 'me');
  ac.abort(new Error('stop'));
  await assert.rejects(p, /stop/);
  assert.equal(locks.holders().a, undefined);
  holdB.release();
  assert.deepEqual(locks.holders(), {});
});

test('release is idempotent and reports wait time', async () => {
  const locks = new LockManager();
  const a = await locks.acquire(['r'], 'a');
  setTimeout(() => a.release(), 20);
  const b = await locks.acquire(['r'], 'b');
  assert.ok(b.waitedMs >= 15, `waited ${b.waitedMs}`);
  a.release(); // second release of a must not free b's hold
  assert.equal(locks.holders().r, 'b');
  b.release();
});
