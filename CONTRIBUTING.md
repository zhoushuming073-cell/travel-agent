# Contributing to Smart Travel

Thank you for helping improve Smart Travel. This project values focused changes, reproducible evidence, and honest handling of unknown travel data.

## Prerequisites

- Node.js 22.13.0 or newer
- npm, using the committed `package-lock.json`
- Optional provider credentials for end-to-end planning tests

## Set up the project

```bash
git clone https://github.com/zhoushuming073-cell/travel-agent.git
cd travel-agent
npm ci
cp .dev.vars.example .dev.vars
npm run dev
```

On Windows PowerShell, copy the environment template with:

```powershell
Copy-Item .dev.vars.example .dev.vars
```

Add credentials only to the ignored local `.dev.vars` file. Never commit `.env*`, `.dev.vars`, API keys, tokens, cookies, private URLs, or credential-bearing logs.

## Validation

Run checks that match the change, and run the complete set before opening a pull request:

```bash
npm run test:domain
npm run typecheck -- --incremental false
npm run lint
npm run build
```

Do not make checks pass by deleting tests, skipping assertions, disabling lint rules, adding broad `any` types, or weakening planning contracts.

## Report an issue

Search existing issues first. A useful report includes:

- a focused description and reproducible steps;
- expected and actual behavior;
- browser, operating system, Node.js version, and relevant provider;
- sanitized logs or screenshots when useful; and
- whether the issue concerns planning logic, data reliability, persistence, or UI behavior.

Do not include secrets or exploitable vulnerability details in a public issue. See [SECURITY.md](SECURITY.md).

## Submit a pull request

Core maintainers may use the direct-`main` workflow documented in `AGENTS.md`. External contributors should:

1. Fork the repository.
2. Create a focused branch in the fork.
3. Keep the change limited to one coherent problem.
4. Add or update tests for behavior changes.
5. Run the full validation set.
6. Open a pull request using the repository template.

Avoid unrelated refactors, dependency upgrades, UI redesigns, schema changes, or file moves in the same pull request.

## Coding principles

- Preserve existing API endpoints and browser request contracts unless the change explicitly proposes a versioned migration.
- Keep the `hot`, `niche`, and `relax` itinerary IDs stable and preserve all user-required attractions.
- Keep the browser-driven `/api/plan/advance` lifecycle, D1 checkpoints, leases, idempotency, cancellation, retry, and recovery semantics intact.
- Add D1 changes through a new migration in `drizzle/`; do not treat `db/schema.ts` alone as the runtime schema.
- Prefer cohesive modules and narrow interfaces over large rewrites or circular dependencies.
- Preserve the current frontend structure: `app/travel/` is the route composition layer and `travel/` is the frontend feature workspace.

## Data reliability requirements

- Never invent hotel availability, transaction prices, opening status, live crowd counts, weather, or verified transit results.
- Keep unknown or conflicting facts explicit.
- Distinguish verified transit legs from estimates.
- Describe crowd information as a prediction unless an authoritative real-time source actually supplied it.
- Keep weather outside the provider forecast window unavailable rather than substituting current conditions.
- Retain source attribution, fetch timestamps, and evidence references when transforming provider data.

By contributing, you agree that your contribution is licensed under the repository's MIT License.
