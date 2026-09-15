type FailureBucket = {
  failures: number[];
  blockedUntil: number;
};

export class FailureRateLimiter {
  private readonly buckets = new Map<string, FailureBucket>();

  constructor(
    private readonly maxFailures: number,
    private readonly windowMs: number,
    private readonly blockMs: number,
  ) {}

  isBlocked(key: string, now = Date.now()): boolean {
    const bucket = this.currentBucket(key, now);
    return bucket ? bucket.blockedUntil > now : false;
  }

  recordFailure(key: string, now = Date.now()): void {
    const bucket = this.currentBucket(key, now) ?? { failures: [], blockedUntil: 0 };
    bucket.failures.push(now);
    if (bucket.failures.length >= this.maxFailures) {
      bucket.blockedUntil = Math.max(bucket.blockedUntil, now + this.blockMs);
    }
    this.buckets.set(key, bucket);
    this.prune(now);
  }

  private currentBucket(key: string, now: number): FailureBucket | null {
    const bucket = this.buckets.get(key);
    if (!bucket) return null;
    bucket.failures = bucket.failures.filter((attempt) => attempt > now - this.windowMs);
    if (bucket.blockedUntil <= now && bucket.failures.length === 0) {
      this.buckets.delete(key);
      return null;
    }
    return bucket;
  }

  private prune(now: number): void {
    if (this.buckets.size < 10_000) return;
    for (const key of this.buckets.keys()) this.currentBucket(key, now);
  }
}