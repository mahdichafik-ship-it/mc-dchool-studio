import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  clearDesktopReleaseCache,
  createDesktopReleaseHandler,
  fetchDesktopRelease,
  validateGitHubRelease,
} from "../src/lib/desktopRelease";

const repository = "https://github.com/mahdichafik-ship-it/mc-dchool-studio";
const releaseBase = `${repository}/releases/download/v1.0.66`;
const armSha512 = Buffer.alloc(64, 1).toString("base64");
const x64Sha512 = Buffer.alloc(64, 2).toString("base64");

function sha256Digest(value: string) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function asset(
  name: string,
  size: number,
  digest = name === "latest-mac.yml" ? sha256Digest(updaterMetadata()) : sha256Digest(name),
) {
  return {
    name,
    browser_download_url: `${releaseBase}/${name}`,
    size,
    state: "uploaded",
    digest,
  };
}

function architectureAssets(architecture: "arm64" | "x64", size: number) {
  const base = `mc-school-studio-1.0.66-${architecture}`;
  return [
    asset(`${base}.dmg`, size),
    asset(`${base}.dmg.blockmap`, size + 1),
    asset(`${base}.zip`, size + 2),
    asset(`${base}.zip.blockmap`, size + 3),
  ];
}

function updaterMetadata(overrides: {
  version?: string;
  armUrl?: string;
  x64Url?: string;
  armSha?: string;
  x64Sha?: string;
  path?: string;
  preferredSha?: string;
} = {}) {
  const armUrl = overrides.armUrl ?? "mc-school-studio-1.0.66-arm64.zip";
  const x64Url = overrides.x64Url ?? "mc-school-studio-1.0.66-x64.zip";
  const armSha = overrides.armSha ?? armSha512;
  const x64Sha = overrides.x64Sha ?? x64Sha512;
  const preferredPath = overrides.path ?? armUrl;
  const preferredSha = overrides.preferredSha ?? armSha;
  return [
    `version: ${overrides.version ?? "1.0.66"}`,
    "files:",
    `  - url: ${armUrl}`,
    `    sha512: ${armSha}`,
    "    size: 102",
    `  - url: ${x64Url}`,
    `    sha512: ${x64Sha}`,
    "    size: 202",
    `path: ${preferredPath}`,
    `sha512: ${preferredSha}`,
    "releaseDate: '2026-01-15T12:00:00.000Z'",
    "",
  ].join("\n");
}

function release(overrides: Record<string, unknown> = {}) {
  const metadataContent = (overrides.metadataContent as string | undefined) ?? updaterMetadata();
  const { metadataContent: _metadataContent, ...releaseOverrides } = overrides;
  return {
    tag_name: "v1.0.66",
    draft: false,
    prerelease: false,
    published_at: "2026-01-15T12:00:00Z",
    html_url: `${repository}/releases/tag/v1.0.66`,
    assets: [
      asset("latest-mac.yml", 50, sha256Digest(metadataContent)),
      ...architectureAssets("arm64", 100),
      ...architectureAssets("x64", 200),
    ],
    ...releaseOverrides,
  };
}

test("validates both independent macOS DMG assets", () => {
  const result = validateGitHubRelease(release(), updaterMetadata());
  assert.ok(result);
  assert.equal(result.version, "1.0.66");
  assert.deepEqual(result.platforms, ["macos"]);
  assert.equal(result.architectures.arm64?.asset.size, 100);
  assert.equal(result.architectures.x64?.asset.size, 200);
});

test("returns one architecture only when its complete asset set is valid", () => {
  const metadata = updaterMetadata({ x64Url: "unused-x64.zip" });
  const result = validateGitHubRelease(
    release({
      metadataContent: metadata,
      assets: [
        asset("latest-mac.yml", 50, sha256Digest(metadata)),
        ...architectureAssets("arm64", 100),
      ],
    }),
    metadata,
  );
  assert.ok(result);
  assert.ok(result.architectures.arm64);
  assert.equal(result.architectures.x64, undefined);
});

test("requires global updater metadata", () => {
  const result = validateGitHubRelease(
    release({ assets: [...architectureAssets("arm64", 100), ...architectureAssets("x64", 200)] }),
    updaterMetadata(),
  );
  assert.equal(result, null);
});

test("does not advertise an architecture with a missing ZIP or blockmap", () => {
  for (const missingName of [
    "mc-school-studio-1.0.66-arm64.zip",
    "mc-school-studio-1.0.66-arm64.zip.blockmap",
  ]) {
    const incompleteArm64 = architectureAssets("arm64", 100).filter(
      (candidate) => candidate.name !== missingName,
    );
    const result = validateGitHubRelease(
      release({
        assets: [
          asset("latest-mac.yml", 50),
          ...incompleteArm64,
          ...architectureAssets("x64", 200),
        ],
      }),
      updaterMetadata(),
    );
    assert.ok(result);
    assert.equal(result.architectures.arm64, undefined);
    assert.ok(result.architectures.x64);
  }
});

test("requires the exact updater metadata URL", () => {
  const result = validateGitHubRelease(
    release({
      assets: [
        {
          ...asset("latest-mac.yml", 50),
          browser_download_url: `${repository}/releases/download/v1.0.66/latest-mac.yml?download=1`,
        },
        ...architectureAssets("arm64", 100),
      ],
    }),
    updaterMetadata(),
  );
  assert.equal(result, null);
});

test("requires lowercase SHA-256 digests on metadata and installer assets", () => {
  const missingMetadataDigest = release();
  delete (missingMetadataDigest.assets[0] as Record<string, unknown>).digest;
  assert.equal(validateGitHubRelease(missingMetadataDigest, updaterMetadata()), null);

  const malformedInstallerDigest = release();
  for (const index of [1, 5]) {
    (malformedInstallerDigest.assets[index] as Record<string, unknown>).digest =
      `sha256:${"A".repeat(64)}`;
  }
  assert.equal(validateGitHubRelease(malformedInstallerDigest, updaterMetadata()), null);
});

test("rejects metadata version, preferred path, and checksum mismatches", () => {
  const wrongVersionMetadata = updaterMetadata({ version: "1.0.65" });
  assert.equal(
    validateGitHubRelease(release({ metadataContent: wrongVersionMetadata }), wrongVersionMetadata),
    null,
  );
  const wrongPreferredMetadata = updaterMetadata({
    path: "mc-school-studio-1.0.66-x64.zip",
    preferredSha: armSha512,
  });
  assert.equal(
    validateGitHubRelease(
      release({ metadataContent: wrongPreferredMetadata }),
      wrongPreferredMetadata,
    ),
    null,
  );
  const wrongChecksumMetadata = updaterMetadata({ armSha: "not-a-sha512" });
  assert.equal(
    validateGitHubRelease(release({ metadataContent: wrongChecksumMetadata }), wrongChecksumMetadata),
    null,
  );
});

test("rejects a preferred ZIP outside the tag-derived architecture names", () => {
  const metadata = updaterMetadata({ armUrl: "other-arm.zip" });
  const result = validateGitHubRelease(
    release({ metadataContent: metadata }),
    metadata,
  );
  assert.equal(result, null);
});

test("coalesces concurrent cold lookups and throttles failures", async () => {
  clearDesktopReleaseCache();
  let calls = 0;
  let resolveFetch: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    resolveFetch = resolve;
  });
  const fakeFetch = async (url: string) => {
    calls += 1;
    await gate;
    return url.endsWith("latest-mac.yml")
      ? new Response(updaterMetadata(), { status: 200 })
      : new Response(JSON.stringify(release()), { status: 200 });
  };
  const first = fetchDesktopRelease(fakeFetch);
  const second = fetchDesktopRelease(fakeFetch);
  assert.equal(calls, 1);
  resolveFetch?.();
  await Promise.all([first, second]);
  clearDesktopReleaseCache();

  let failureCalls = 0;
  const failingFetch = async () => {
    failureCalls += 1;
    return new Response("unavailable", { status: 503 });
  };
  await assert.rejects(fetchDesktopRelease(failingFetch), /returned 503/);
  await assert.rejects(fetchDesktopRelease(failingFetch), /returned 503/);
  assert.equal(failureCalls, 1);
});

test("aborts a stalled GitHub API body and caches the failure", async (t) => {
  clearDesktopReleaseCache();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  let aborted = false;
  const stalledFetch = async (_url: string, init?: RequestInit) => {
    calls += 1;
    return new Response(
      new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            controller.error(new Error("aborted"));
          }, { once: true });
        },
      }),
      { status: 200 },
    );
  };
  try {
    const pending = fetchDesktopRelease(stalledFetch);
    await Promise.resolve();
    t.mock.timers.tick(5_000);
    await assert.rejects(pending, /aborted|Desktop release lookup failed/);
    assert.equal(aborted, true);
    await assert.rejects(fetchDesktopRelease(stalledFetch));
    assert.equal(calls, 1);
  } finally {
    t.mock.timers.reset();
    clearDesktopReleaseCache();
  }
});

test("cache reset clears successful and failure state", async () => {
  clearDesktopReleaseCache();
  let calls = 0;
  const fakeFetch = async (url: string) => {
    calls += 1;
    return url.endsWith("latest-mac.yml")
      ? new Response(updaterMetadata(), { status: 200 })
      : new Response(JSON.stringify(release()), { status: 200 });
  };
  await fetchDesktopRelease(fakeFetch);
  clearDesktopReleaseCache();
  await fetchDesktopRelease(fakeFetch);
  assert.equal(calls, 4);
});

test("cache reset does not let an old in-flight lookup overwrite newer state", async () => {
  clearDesktopReleaseCache();
  let resolveFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    resolveFirst = resolve;
  });
  const first = fetchDesktopRelease(async (url: string) => {
    await firstGate;
    return url.endsWith("latest-mac.yml")
      ? new Response(updaterMetadata(), { status: 200 })
      : new Response(JSON.stringify(release()), { status: 200 });
  });
  clearDesktopReleaseCache();
  await fetchDesktopRelease(async (url: string) =>
    url.endsWith("latest-mac.yml")
      ? new Response(updaterMetadata(), { status: 200 })
      : new Response(JSON.stringify(release()), { status: 200 }),
  );
  resolveFirst?.();
  await first;
  await assert.doesNotReject(
    fetchDesktopRelease(async () => {
      throw new Error("newer cached release should be retained");
    }),
  );
});

test("fails when updater metadata cannot be fetched or redirects unexpectedly", async () => {
  clearDesktopReleaseCache();
  let metadataCalls = 0;
  await assert.rejects(
    fetchDesktopRelease(async (url: string) => {
      if (url.endsWith("latest-mac.yml")) {
        metadataCalls += 1;
        return new Response("unavailable", { status: 503 });
      }
      return new Response(JSON.stringify(release()), { status: 200 });
    }),
    /Updater metadata returned 503/,
  );
  assert.equal(metadataCalls, 1);
  clearDesktopReleaseCache();
  await assert.rejects(
    fetchDesktopRelease(async (url: string) => {
      if (!url.endsWith("latest-mac.yml")) return new Response(JSON.stringify(release()), { status: 200 });
      const response = new Response(updaterMetadata(), { status: 200 });
      Object.defineProperty(response, "url", { value: "https://evil.example/latest-mac.yml" });
      return response;
    }),
    /unexpected host/,
  );
  clearDesktopReleaseCache();
  await assert.rejects(
    fetchDesktopRelease(async (url: string) => {
      if (!url.endsWith("latest-mac.yml")) return new Response(JSON.stringify(release()), { status: 200 });
      return new Response("x".repeat(256 * 1024 + 1), { status: 200 });
    }),
    /too large/,
  );
  clearDesktopReleaseCache();
  const mismatchedMetadata = updaterMetadata({ armUrl: "different-arm.zip" });
  await assert.rejects(
    fetchDesktopRelease(async (url: string) => {
      if (!url.endsWith("latest-mac.yml")) return new Response(JSON.stringify(release()), { status: 200 });
      return new Response(mismatchedMetadata, { status: 200 });
    }),
    /digest did not match/,
  );
});

test("public handler returns 200 or explicit 503", async () => {
  let status = 200;
  let body: unknown;
  const response = {
    json(value: unknown) {
      body = value;
      return this;
    },
    status(value: number) {
      status = value;
      return this;
    },
  };
  await createDesktopReleaseHandler(async () => ({ version: "1.0.66" } as never))({} as never, response as never);
  assert.equal(status, 200);
  assert.deepEqual(body, { version: "1.0.66" });
  await createDesktopReleaseHandler(async () => {
    throw new Error("provider unavailable");
  })({} as never, response as never);
  assert.equal(status, 503);
  assert.deepEqual(body, { error: "A current desktop release is unavailable." });
});

test("rejects malformed tag, repository URL, filename, and unusable assets", () => {
  for (const overrides of [
    { tag_name: "1.0.66" },
    { html_url: "https://github.com/other/repo/releases/tag/v1.0.66" },
    {
      assets: [
        {
          name: "mc-school-studio-1.0.66-arm64.zip",
          browser_download_url: `${repository}/releases/download/v1.0.66/mc-school-studio-1.0.66-arm64.zip`,
          size: 100,
          state: "uploaded",
        },
      ],
    },
    {
      assets: [
        {
          name: "mc-school-studio-1.0.66-arm64.dmg",
          browser_download_url: "https://evil.example/download.dmg",
          size: 100,
          state: "uploaded",
        },
      ],
    },
    {
      assets: [
        {
          name: "mc-school-studio-1.0.66-arm64.dmg",
          browser_download_url: `${repository}/releases/download/v1.0.66/mc-school-studio-1.0.66-arm64.dmg`,
          size: 0,
          state: "uploaded",
        },
      ],
    },
  ]) {
    assert.equal(validateGitHubRelease(release(overrides), updaterMetadata()), null);
  }
});

test("rejects draft, prerelease, and invalid release metadata", () => {
  assert.equal(validateGitHubRelease(release({ draft: true }), updaterMetadata()), null);
  assert.equal(validateGitHubRelease(release({ prerelease: true }), updaterMetadata()), null);
  assert.equal(validateGitHubRelease(release({ published_at: "not-a-date" }), updaterMetadata()), null);
  assert.equal(validateGitHubRelease(release({ assets: [null] }), updaterMetadata()), null);
});

test("uses a successful cache and never requires live GitHub in tests", async () => {
  clearDesktopReleaseCache();
  let calls = 0;
  const fakeFetch = async (url: string) => {
    calls += 1;
    return url.endsWith("latest-mac.yml")
      ? new Response(updaterMetadata(), { status: 200 })
      : new Response(JSON.stringify(release()), { status: 200 });
  };
  const first = await fetchDesktopRelease(fakeFetch);
  const second = await fetchDesktopRelease(async () => {
    throw new Error("provider should not be called while cache is fresh");
  });
  assert.equal(calls, 2);
  assert.deepEqual(second, first);
  clearDesktopReleaseCache();
  await assert.rejects(
    fetchDesktopRelease(async () => new Response("unavailable", { status: 503 })),
    /GitHub Releases API returned 503/,
  );
});
