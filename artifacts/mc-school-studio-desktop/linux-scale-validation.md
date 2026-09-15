# Linux desktop scale validation

This is the Linux portion of the 2,500-subject desktop validation requested for
task #156. It is an engineering check of deterministic roster data and the
desktop source; it is not photographer-Mac acceptance.

## Run record

| Field | Result |
| --- | --- |
| Run date (UTC) | 2026-09-14T17:37:23Z |
| Local branch | `release/v1.0.62` |
| Git base revision at validation | `1b508a1` |
| Task-specific branch found locally | No |
| Platform | Linux workspace |
| Physical Mac acceptance | **Not run / not claimed** |
| Publish or release tag action | **Not performed** |

## Deterministic 2,500-subject check

The `test:project-scale` suite now creates exactly 2,500 deterministic subjects
in one project and exercises 100 passes of the desktop roster path:

* case-insensitive first-name, last-name, and generated-ID filtering;
* keyboard next-subject resolution against the visible roster;
* group-member selection checks for a 2,500-subject roster.

The Linux gate is deliberately based on a deterministic work budget rather
than wall-clock time. Each pass accounts for one full 2,500-row filter scan,
one worst-case 2,500-row selector scan, and one 2,500-row membership pass:
`2,500 × 100 × 3 = 750,000` work units. The test requires exactly that bounded
modeled work set for the three production stages. This is a deterministic
algorithmic gate, not a claim that it instruments every renderer operation or
paint. It avoids turning loaded CI scheduling into a flaky acceptance decision;
wall-clock measurements remain diagnostic evidence only.

Focused commands:

```text
pnpm --filter @workspace/mc-school-studio-desktop run test:project-scale
  repeated runs: 6 passed, 0 failed each
  deterministic work gate: 750000 units (max 750000)
  wall-clock diagnostics: 399.5ms, 90.7ms, 919.8ms

pnpm --filter @workspace/mc-school-studio-desktop run test:roster-shortcuts
  8 passed, 0 failed

pnpm --filter @workspace/mc-school-studio-desktop run typecheck
  passed (main and renderer TypeScript projects)
```

## Concrete bottleneck fixed

The scale test calls the production `filterRosterStudents`,
`resolveRosterShortcut`, and `createGroupMemberStudentIdSet` functions rather
than reimplementing their logic in the test. `ProjectView` uses those same
helpers for live roster filtering and group membership rendering.

`GroupDetail` previously called
`group.memberStudentIds.includes(student.id)` while rendering every roster
row. With 2,500 members this can require up to 3,126,250 linear comparisons in
a single render. The renderer now builds one `Set` per group-detail render and
uses `Set.has`, keeping membership checks linear in the roster size. The scale
test asserts that the old per-row lookup is absent.

The 2,500-person project query-count checks also remain fixed: class listing
uses one class query plus one grouped student-count query, and student listing
uses one joined roster query plus one grouped capture-count query. Project
upload status reads remain bulk-loaded rather than issuing one query per subject
or capture.

## Linux boundary

This run does not prove Electron packaged-renderer paint time, camera/QR
hardware behavior, filesystem throughput on a photographer Mac, or
Intel/Apple-silicon updater behavior. Native packaged-renderer responsiveness
and Mac workflow acceptance still require photographer-Mac signoff in the
existing real-Mac acceptance record; they are intentionally left unmarked.