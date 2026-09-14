# macOS release acceptance notes

This record is the final field-acceptance gate for a signed Volume Capture
release. Hosted GitHub Actions runners provide valuable architecture, signing,
Gatekeeper, notarization, and updater coverage, but they are not a substitute
for one supported photographer Mac of each architecture.

## Release under test

| Field | Value |
| --- | --- |
| Release tag | `v__________` |
| Previous signed release | `v__________` |
| Test date (UTC) | `__________` |
| Tester | `__________` |
| GitHub update-smoke run | `__________` |

## Hardware results

Use a real supported photographer Mac for each row. Record the exact macOS
product version and build from `sw_vers -productVersion` and
`sw_vers -buildVersion`. Do not record customer, school, student, or photo
content in this file.

| Check | Intel photographer Mac | Apple-silicon photographer Mac |
| --- | --- | --- |
| Mac model / CPU | `__________` | `__________` |
| macOS version / build | `__________` | `__________` |
| Previous app version installed | `__________` | `__________` |
| Previous signed app opened without Gatekeeper warning | ☐ PASS ☐ FAIL | ☐ PASS ☐ FAIL |
| Existing local project and photo fixture prepared | ☐ PASS ☐ FAIL | ☐ PASS ☐ FAIL |
| In-app updater offered the target release | ☐ PASS ☐ FAIL | ☐ PASS ☐ FAIL |
| Download completed | ☐ PASS ☐ FAIL | ☐ PASS ☐ FAIL |
| App restarted through the updater | ☐ PASS ☐ FAIL | ☐ PASS ☐ FAIL |
| Installed version changed to target | ☐ PASS ☐ FAIL | ☐ PASS ☐ FAIL |
| Existing local projects remained available | ☐ PASS ☐ FAIL | ☐ PASS ☐ FAIL |
| Existing local photos remained intact and readable | ☐ PASS ☐ FAIL | ☐ PASS ☐ FAIL |
| Target app opened without Gatekeeper warning | ☐ PASS ☐ FAIL | ☐ PASS ☐ FAIL |
| Evidence location | `__________` | `__________` |
| Overall outcome | ☐ PASS ☐ FAIL ☐ BLOCKED | ☐ PASS ☐ FAIL ☐ BLOCKED |

## Test procedure

1. Install the previous signed release from the intended release asset, not a
   development build.
2. Open the app once and verify a known local fixture project and at least one
   existing photo are present. Record only counts or non-sensitive fixture
   identifiers in the evidence.
3. From inside the app, check for updates, download the target release, and
   choose **Restart and install** when prompted.
4. Confirm the old process exits and the app relaunches. Verify the installed
   version in the app and in **About This Mac** / the app bundle metadata.
5. Reopen the same project and photo fixture. Confirm the project remains
   available, the photo still opens, and no local data was reset or moved.
6. Quit and launch the updated app once more to confirm the result survives a
   normal restart.
7. Record any security prompt, permission prompt, updater error, or data
   discrepancy as a failure. A hosted smoke pass cannot override a field
   failure.

## Automated evidence

The `Desktop Release` workflow runs `update-smoke-intel` and
`update-smoke-arm64` after publishing the complete signed release. Each
`lifecycle.jsonl` artifact records the runner macOS version, build, CPU
architecture, source version, target version, Gatekeeper checks, download,
restart, relaunch, and post-update signature validation. Attach those
artifacts to the release record, but keep the two real-hardware rows above
separate and explicitly completed.

## Release decision

**Field acceptance:** ☐ PASS — both hardware rows pass  
**Hosted updater smoke:** ☐ PASS — both architecture jobs pass  
**Release accepted:** ☐ YES ☐ NO

Do not mark **Release accepted** as YES while either real-hardware row is
blank, blocked, or failed.