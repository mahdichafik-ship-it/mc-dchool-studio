# MC School Studio

A professional school photography day preparation tool. Photography studios log in, create a project per school, import student lists from Excel/CSV, generate QR codes for every student, then export everything as a ZIP of PNGs or a printable PDF.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080, served at /api)
- `pnpm --filter @workspace/mc-school-studio run dev` — run the React frontend (port 26125, served at /)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Required env: `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `VITE_CLERK_PUBLISHABLE_KEY` — Clerk auth (auto-provisioned)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React + Vite + Tailwind v4 + shadcn/ui + Wouter routing
- API: Express 5 + Clerk auth middleware
- DB: PostgreSQL + Drizzle ORM
- Auth: Clerk (Replit-managed)
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- File parsing: xlsx (Excel/CSV)
- QR generation: qrcode
- ZIP export: jszip
- PDF export: pdfkit

## Where things live

- `lib/api-spec/openapi.yaml` — API contract (source of truth)
- `lib/db/src/schema/` — DB schema (projects.ts, classes.ts, students.ts)
- `artifacts/api-server/src/routes/` — Express route handlers
- `artifacts/api-server/src/lib/` — auth.ts, studentId.ts, qrcode.ts helpers
- `artifacts/mc-school-studio/src/pages/` — React page components
- `artifacts/mc-school-studio/src/components/` — Shared UI components

## Architecture decisions

- Clerk auth is cookie-based on web — no bearer tokens needed in browser requests
- QR codes stored as base64 data URLs in the DB (simpleQr and jsonQr columns)
- Student IDs are 7-char uppercase alphanumeric, generated uniquely per project
- Excel import: each worksheet becomes a class; CSV import prompts for a class name
- Export endpoints return binary (ZIP/PDF) — frontend uses window.location.href for downloads
- Client-side search/filter on students list (fetches all, filters in memory)

## Product

Full MVP workflow:
1. Login → Dashboard (stats + recent projects)
2. Create School Project → Import Excel/CSV student list
3. Column mapping → Students imported with auto-generated IDs
4. Generate QR codes (simple text + JSON formats) per student
5. Export as ZIP (individual PNGs) or PDF (one student per page)

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- After changing `lib/api-spec/openapi.yaml`, always run codegen before using updated hooks
- `@swc/*` must NOT be in the esbuild externals — PDFKit's fontkit dependency needs it bundled
- For query hooks with path params: always include `queryKey: get*QueryKey(id)` in the query options
- API server build compiles to a single ESM bundle (~7.5MB) — this is expected with PDFKit included
