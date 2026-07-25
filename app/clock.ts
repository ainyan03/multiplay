// Shared room time. Peers each run their own wall clock, so anything derived
// from a timestamp -- a bomb fuse, a block regrowing -- would fire at different
// moments on different devices. Nudging every client toward the median observed
// clock keeps those schedules aligned without a server or an elected leader.

export type SkewStore = Map<string, number[]>;

const SKEW_WINDOW = 120;

// The smallest observed difference is the one with the least transit delay
// mixed in, so it is the closest estimate of the raw clock offset.
export function observeSkew(store: SkewStore, peerId: string, senderTs: number, localNow: number, window = SKEW_WINDOW) {
  if (!Number.isFinite(senderTs)) return;
  const samples = store.get(peerId) ?? [];
  samples.push(localNow - senderTs);
  // A bounded window lets an old outlier expire instead of pinning the estimate.
  if (samples.length > window) samples.splice(0, samples.length - window);
  store.set(peerId, samples);
}

export function peerSkews(store: SkewStore): number[] {
  const result: number[] = [];
  for (const samples of store.values()) {
    if (samples.length) result.push(Math.min(...samples));
  }
  return result;
}

// Our own zero is always part of the sample set, so a single wildly wrong clock
// cannot drag the whole room with it.
export function correctedRoomNow(localNow: number, observedSkews: number[]) {
  const samples = [0, ...observedSkews.filter(Number.isFinite)].sort((first, second) => first - second);
  const middle = samples.length >> 1;
  const median = samples.length % 2 === 1
    ? samples[middle]!
    : (samples[middle - 1]! + samples[middle]!) / 2;
  return localNow - median;
}
