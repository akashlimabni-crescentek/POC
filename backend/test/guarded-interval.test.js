import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createGuardedInterval } = require('../lib/guarded-interval');

describe('createGuardedInterval', () => {
  let warnSpy;
  let errorSpy;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs fn and returns without throwing on success', async () => {
    const fn = vi.fn().mockResolvedValue(42);
    const { guarded } = createGuardedInterval('test-worker', fn, 1000);

    await expect(guarded()).resolves.toBeUndefined();
    expect(fn).toHaveBeenCalledOnce();
  });

  it('skips overlapping runs', async () => {
    let resolveFirst;
    const fn = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        })
    );

    const { guarded } = createGuardedInterval('overlap-worker', fn, 1000);

    const first = guarded();
    await guarded();

    expect(fn).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      '[overlap-worker] previous run still in progress — skipping'
    );

    resolveFirst(10);
    await first;
  });

  it('logs error on failure without throwing', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('boom'));
    const { guarded } = createGuardedInterval('err-worker', fn, 1000);

    await expect(guarded()).resolves.toBeUndefined();
    expect(errorSpy.mock.calls[0]).toEqual(['[err-worker] failed:', 'boom']);
  });
});
