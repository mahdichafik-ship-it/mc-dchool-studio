import { strict as assert } from "node:assert";
import test from "node:test";
import { FailureRateLimiter } from "../src/lib/failureRateLimiter";
import { browserOriginIsTrusted, requireTrustedMutationOrigin, trustedBrowserOrigins } from "../src/lib/trustedOrigins";

test("allows only configured browser origins in production", () => {
  const env = {
    NODE_ENV: "production",
    PUBLIC_APP_URL: "https://volumecapture.net/some/path",
    REPLIT_DOMAINS: "preview-a.example,preview-b.example",
  } as NodeJS.ProcessEnv;
  assert.deepEqual([...trustedBrowserOrigins(env)].sort(), [
    "https://preview-a.example",
    "https://preview-b.example",
    "https://volumecapture.net",
  ]);
  assert.equal(browserOriginIsTrusted("https://volumecapture.net", env), true);
  assert.equal(browserOriginIsTrusted("https://attacker.example", env), false);
  assert.equal(browserOriginIsTrusted("not-a-url", env), false);
});

test("blocks a failure bucket until its cooldown expires", () => {
  const limiter = new FailureRateLimiter(2, 1_000, 5_000);
  limiter.recordFailure("ip:one", 100);
  assert.equal(limiter.isBlocked("ip:one", 200), false);
  limiter.recordFailure("ip:one", 300);
  assert.equal(limiter.isBlocked("ip:one", 400), true);
  assert.equal(limiter.isBlocked("ip:one", 5_301), false);
});

test("rejects cross-site browser mutations even when Origin is omitted", () => {
  let status = 0;
  let nextCalled = false;
  requireTrustedMutationOrigin(
    {
      method: "POST",
      header: (name: string) => name === "sec-fetch-site" ? "cross-site" : undefined,
    } as never,
    {
      status(code: number) {
        status = code;
        return this;
      },
      json() {
        return this;
      },
    } as never,
    () => {
      nextCalled = true;
    },
  );
  assert.equal(status, 403);
  assert.equal(nextCalled, false);
});