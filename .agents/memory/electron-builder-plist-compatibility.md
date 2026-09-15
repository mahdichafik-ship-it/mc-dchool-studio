---
name: Electron Builder plist compatibility
description: Safe remediation rule for xmldom advisories in the macOS packaging toolchain.
---

Do not force `@xmldom/xmldom` 0.9.12 underneath Electron Builder's `plist`
consumers. Resolve the compatible `plist` parent to the unaffected xmldom 0.8
line unless upstream has explicitly added xmldom 0.9.12 support.

**Why:** xmldom 0.9.12 requires a valid MIME type in `DOMParser.parseFromString`,
while the current plist parser calls it without one. A direct security override
therefore causes macOS packaging to fail while parsing Electron's Info.plist.

**How to apply:** After changing Electron Builder, plist, or xmldom, generate at
least one macOS identity bundle and confirm Info.plist parsing succeeds. Prefer
a compatible parent resolution over a leaf override that violates the parent's
tested API range.