export type DesktopArchitecture = "arm64" | "x64";

export type DesktopPlatformDetection = {
  isMac: boolean;
  architecture: DesktopArchitecture | null;
};

type UserAgentData = {
  platform?: string;
  architecture?: string;
  getHighEntropyValues?: (hints: string[]) => Promise<{
    platform?: string;
    architecture?: string;
    bitness?: string;
  }>;
};

function userAgentData(): UserAgentData | undefined {
  if (typeof navigator === "undefined") return undefined;
  return (navigator as Navigator & { userAgentData?: UserAgentData }).userAgentData;
}

function isMacPlatform(platform: string, userAgent: string): boolean {
  return /mac/i.test(platform) || /Macintosh|Mac OS X/i.test(userAgent);
}

function architectureFromValues(
  architecture: string | undefined,
  userAgent: string,
): DesktopArchitecture | null {
  if (architecture && /arm|aarch/i.test(architecture)) return "arm64";
  if (architecture && /x86|x64|amd/i.test(architecture)) return "x64";
  if (/Apple Silicon|arm64|aarch64/i.test(userAgent)) return "arm64";
  // "Intel Mac OS X" is also emitted by Apple Silicon browsers for web
  // compatibility, so it is intentionally not enough to claim Intel.
  if (/x86_64|x64/i.test(userAgent)) return "x64";
  return null;
}

export function detectDesktopPlatform(): DesktopPlatformDetection {
  if (typeof navigator === "undefined") return { isMac: false, architecture: null };
  const data = userAgentData();
  const platform = data?.platform ?? navigator.platform ?? "";
  const userAgent = navigator.userAgent ?? "";
  const isMac = isMacPlatform(platform, userAgent);
  return {
    isMac,
    architecture: isMac ? architectureFromValues(data?.architecture, userAgent) : null,
  };
}

/**
 * UA Client Hints can identify Apple Silicon/Intel where the traditional Mac
 * user agent intentionally cannot. If unavailable, retain the conservative
 * synchronous result rather than guessing.
 */
export async function detectDesktopPlatformBestEffort(): Promise<DesktopPlatformDetection> {
  const detected = detectDesktopPlatform();
  const data = userAgentData();
  if (!data?.getHighEntropyValues) return detected;

  try {
    const highEntropy = await data.getHighEntropyValues(["architecture", "bitness", "platform"]);
    const platform = highEntropy.platform ?? data.platform ?? navigator.platform ?? "";
    const isMac = isMacPlatform(platform, navigator.userAgent ?? "");
    return {
      isMac,
      architecture: isMac
        ? architectureFromValues(highEntropy.architecture, navigator.userAgent ?? "")
        : null,
    };
  } catch {
    return detected;
  }
}
