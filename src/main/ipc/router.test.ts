import { describe, expect, it, vi } from 'vitest';
import { ChannelRouter } from './router';
import { makeFakeContext } from '../../test/fakeHost';

describe('ChannelRouter', () => {
  it('lists registered channels with their kind', () => {
    const router = new ChannelRouter();
    router.handle('a:one', () => 1);
    router.on('b:two', () => undefined);
    expect(router.table()).toEqual([
      { channel: 'a:one', kind: 'invoke' },
      { channel: 'b:two', kind: 'send' },
    ]);
    expect(router.has('a:one')).toBe(true);
    expect(router.has('c:three')).toBe(false);
  });

  it('dispatches with the context first, then the args, and returns the result', async () => {
    const router = new ChannelRouter();
    const handler = vi.fn(async (_ctx: unknown, a: number, b: number) => a + b);
    router.handle('math:add', handler);
    const ctx = makeFakeContext();
    await expect(router.dispatch('math:add', ctx, [2, 3])).resolves.toBe(5);
    expect(handler).toHaveBeenCalledWith(ctx, 2, 3);
  });

  it('throws for an unknown channel and for a duplicate registration', () => {
    const router = new ChannelRouter();
    router.handle('a:one', () => 1);
    expect(() => router.dispatch('a:two', makeFakeContext(), [])).toThrow(/No handler/);
    expect(() => router.on('a:one', () => undefined)).toThrow(/twice/);
  });
});
