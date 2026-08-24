# Studio access testing

This project has two repeatable access checks:

- `pnpm --filter @workspace/api-server run test:integration` runs the authenticated
  API matrix in `artifacts/api-server/test/access.integration.test.ts`.
- The Team page should be checked with the browser test plan below after the API
  suite passes.

## API coverage

The integration fixture creates an isolated studio and verifies owner, admin,
assistant, photographer, viewer, pending invite, and removed member behavior.
It includes:

- project lists and dashboard counts;
- project detail, student roster, class, and photo responses;
- authorized JSON, ZIP, and PDF exports plus blocked export responses;
- read-only/removed-member rejection for roster mutations and photo-file access;
- unassigned-project responses;
- Team data, invitation activation, and manager-only controls.

The test supplies a Clerk-branded `req.auth` function with a
`session_token` claim to the real `requireAuth` middleware. It uses unique
synthetic user IDs and deletes its studio during teardown. It does not call the
Clerk API or use a live staff account.

## Safe authenticated UI checks

Use the testing browser's programmatic Clerk login, not the Clerk sign-in or
sign-up form:

1. Create a new browser context.
2. Sign in with `[Clerk Auth]` as an ephemeral user such as
   `owner-<unique-id>@example.com`. Explicitly tell the test runner to override
   login claims for the requested role; never use a production staff email.
3. Open `/team` and wait for the Team data request to finish.
4. For an owner or admin, verify `data-testid="team-invite-form"`,
   `data-testid="team-project-assignments"`, and
   `data-testid="team-desktop-connections"` are visible. Verify the Members
   section shows role selectors for non-owner members.
5. For an assistant, photographer, or viewer, verify those three manager-only
   sections are absent. The Members section may remain visible, but no invite,
   assignment, or desktop-management controls should be available.
6. For a pending invite, sign in with the invited email and verify the user
   joins with the invited role. Verify the Team page does not show projects
   until one is assigned.
7. For a removed member, verify the Team request is rejected and that the
   dashboard/project URLs do not show the former studio's projects.

Run each role in a fresh context. This prevents a previous Clerk session,
React Query cache, or browser cookie from making one role appear to have
another role's controls. If a test needs a real fixture, seed the development
database with synthetic records only and remove them after the run.