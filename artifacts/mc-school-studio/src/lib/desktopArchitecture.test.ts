import { strict as assert } from "node:assert";
import test from "node:test";
import { detectDesktopPlatform } from "./desktopArchitecture.ts";

function withNavigator(value: Record<string, unknown>, callback: () => void): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value,
  });
  try {
    callback();
  } finally {
    if (previous) Object.defineProperty(globalThis, "navigator", previous);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
}

test("detects an explicit Apple Silicon user agent", () => {
  withNavigator(
    { platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh; arm64 Mac OS X 14_0)" },
    () => assert.deepEqual(detectDesktopPlatform(), { isMac: true, architecture: "arm64" }),
  );
});

test("does not guess hardware from the compatibility Intel Mac user agent", () => {
  withNavigator(
    { platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
    () => assert.deepEqual(detectDesktopPlatform(), { isMac: true, architecture: null }),
  );
});

test("uses an explicit UA Client Hints architecture", () => {
  withNavigator(
    {
      platform: "macOS",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      userAgentData: { platform: "macOS", architecture: "x86" },
    },
    () => assert.deepEqual(detectDesktopPlatform(), { isMac: true, architecture: "x64" }),
  );
});

test("identifies non-Mac browsers without advertising an architecture", () => {
  withNavigator(
    { platform: "Win32", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    () => assert.deepEqual(detectDesktopPlatform(), { isMac: false, architecture: null }),
  );
});
