# Agent Protocol

**Server:** @cyanheads/eia-mcp-server
**Version:** 0.1.4
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.9.6`
**Engines:** Bun ≥1.3.0, Node ≥24.0.0

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## What's Next?

When the user asks what to do next, what's left, or needs direction, suggest relevant options based on the current project state:

1. **Re-run the `setup` skill** — ensures CLAUDE.md, skills, structure, and metadata are populated and up to date with the current codebase
2. **Run the `design-mcp-server` skill** — if the tool/resource surface hasn't been mapped yet, work through domain design
3. **Add tools/resources/prompts** — scaffold new definitions using the `add-tool`, `add-app-tool`, `add-resource`, `add-prompt` skills
4. **Add services** — scaffold domain service integrations using the `add-service` skill
5. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
6. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill, get a report of issues and pain points
7. **Run `devcheck`** — lint, format, typecheck, and security audit
8. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation
9. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
10. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Check `ctx.elicit` / `ctx.sample`** for presence before calling.
- **Secrets in env vars only** — never hardcoded.

---

## Patterns

### Tool

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { getEiaApiService } from '@/services/eia/eia-service.js';

export const browseRoutes = tool('eia_browse_routes', {
  description: 'Lists child routes under a given path in the EIA dataset taxonomy.',
  annotations: { readOnlyHint: true, openWorldHint: false },

  input: z.object({
    path: z.string().optional().describe('Route path to browse (e.g. "electricity"). Omit for root.'),
  }),

  output: z.object({
    path: z.string().describe('The path browsed'),
    children: z.array(z.object({
      id: z.string().describe('Route segment ID'),
      name: z.string().describe('Human-readable name'),
      description: z.string().describe('Route description'),
      route: z.string().describe('Full route path'),
      isLeaf: z.boolean().describe('True when this child is a queryable leaf route'),
    })).describe('Child entries'),
    isLeaf: z.boolean().describe('True when the browsed path itself is a leaf route'),
  }),

  errors: [
    { reason: 'route_not_found', code: JsonRpcErrorCode.NotFound,
      when: 'Path does not exist in the EIA taxonomy',
      recovery: 'Call eia_browse_routes without a path to see valid top-level categories.' },
  ],

  async handler(input, ctx) {
    ctx.log.info('Executing eia_browse_routes', { path: input.path });
    const result = await getEiaApiService().browse(input.path);
    return result;
  },

  format: (result) => [{
    type: 'text',
    text: result.children.map(c => `${c.isLeaf ? '[leaf]' : '[cat]'} ${c.route} — ${c.name}`).join('\n'),
  }],
});
```

### Server config

```ts
// src/config/server-config.ts — lazy-parsed, separate from framework config
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  apiKey: z.string().describe('EIA API key'),
  baseUrl: z.string().url().default('https://api.eia.gov/v2').describe('EIA API base URL'),
  canvasProvider: z.string().optional().describe('Canvas provider type (e.g. "duckdb")'),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;
export function getServerConfig(): z.infer<typeof ServerConfigSchema> {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    apiKey: 'EIA_API_KEY',
    baseUrl: 'EIA_BASE_URL',
    canvasProvider: 'CANVAS_PROVIDER_TYPE',
  });
  return _config;
}
```

`parseEnvConfig` maps Zod schema paths → env var names so validation errors name the actual variable (`EIA_API_KEY` is required) rather than the internal path.

---

## Context

Handlers receive a unified `ctx` object. Key properties:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. |
| `ctx.state` | Tenant-scoped KV — `.get(key)`, `.set(key, value, { ttl? })`, `.delete(key)`, `.list(prefix, { cursor, limit })`. Accepts any serializable value. |
| `ctx.recoveryFor(reason)` | Typed lookup of the contract `recovery` for a declared reason. Spread into `ctx.fail` data to mirror the contract hint into `content[]`. |
| `ctx.signal` | `AbortSignal` for cancellation. |
| `ctx.requestId` | Unique request ID. |
| `ctx.tenantId` | Tenant ID from JWT, `'default'` for stdio or HTTP+`MCP_AUTH_MODE=none`. |

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable? }]` on `tool()` / `resource()` to receive a typed `ctx.fail(reason, …)` keyed by the declared reason union. TypeScript catches `ctx.fail('typo')` at compile time, `data.reason` is auto-populated for observability, and the linter enforces conformance against the handler body. The `recovery` field is required (≥ 5 words, lint-validated) — it's the single source of truth for the recovery hint. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`) bubble freely and don't need declaring.

```ts
errors: [
  { reason: 'route_not_found', code: JsonRpcErrorCode.NotFound,
    when: 'Route does not exist in the EIA taxonomy',
    recovery: 'Call eia_browse_routes without a path to see top-level categories.' },
  { reason: 'rate_limited', code: JsonRpcErrorCode.ServiceUnavailable,
    retryable: true,
    when: 'EIA rate limit exceeded',
    recovery: 'Back off and retry; use a production API key for higher limits.' },
],
async handler(input, ctx) {
  const result = await getEiaApiService().query(input.route, input.filters);
  if (!result) throw ctx.fail('route_not_found', `Route ${input.route} not found`);
  return result;
}
```

**Fallback:** error factories or plain `Error`.

```ts
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Route not found', { route });
throw serviceUnavailable('EIA rate limit hit', { route }, { cause: err });
```

For HTTP responses, use `httpErrorFromResponse(response, { service, data })` from `/utils` — covers the full 4xx/5xx → `JsonRpcErrorCode` table.

See framework CLAUDE.md and the `api-errors` skill for the full auto-classification table, all factories, and the contract reference.

---

## Structure

```text
src/
  index.ts                              # createApp() entry point
  config/
    server-config.ts                    # EIA-specific env vars (Zod schema)
  services/
    eia/
      eia-service.ts                    # EIA API v2 service (init/accessor)
      api-client.ts                     # HTTP client for api.eia.gov/v2
      route-cache.ts                    # In-process route tree cache + Fuse.js index
      types.ts                          # EIA domain types
  mcp-server/
    tools/definitions/
      browse-routes.tool.ts             # eia_browse_routes
      describe-route.tool.ts            # eia_describe_route
      search-routes.tool.ts             # eia_search_routes
      query-route.tool.ts               # eia_query_route
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `browse-routes.tool.ts` |
| Tool/resource/prompt names | snake_case | `eia_browse_routes` |
| Directories | kebab-case | `src/services/eia/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Browse the EIA dataset taxonomy.'` |

---

## EIA-Specific Conventions

**Two-phase workflow:** Discovery (`eia_browse_routes` / `eia_search_routes` → `eia_describe_route`) must precede data retrieval (`eia_query_route`). Facet IDs and valid values are not embedded in route metadata — they require separate `GET /v2/{route}/facet/{facetId}` calls. Always describe the route before querying it.

**In-process caches:**
- Route tree: fetched lazily on first `eia_browse_routes` / `eia_search_routes` call; cached for server lifetime. STEO's 1,469 `seriesId` values are included in the Fuse.js index.
- Facet metadata: per-route cache keyed by route path; populated by `eia_describe_route` via fan-out (`Promise.all` over all facets). Reused by subsequent describe and query calls.

**STEO:** `steo` is a flat leaf (no sub-routes) with one facet: `seriesId` covering 1,469 named series. Query it via `eia_query_route` with `seriesId` filter. Discovery via `eia_search_routes` (series names are indexed).

**Data values are strings:** All numeric data from `/v2/{route}/data/` arrives as strings (e.g. `"9.13"`). Per-column units appear as `{col}-units` fields inline in each row. Surfaces in output schema — do not coerce silently.

**Retry / rate limits:** Wrap fetch + parse in `withRetry`. DEMO_KEY hits limits quickly; production keys have higher caps. Detect EIA's `OVER_RATE_LIMIT` response and classify as `ServiceUnavailable` (retryable).

**DataCanvas:** Opt-in via `CANVAS_PROVIDER_TYPE=duckdb`. Check `ctx.core.canvas?` at runtime; degrade gracefully to preview-only when absent. Large result sets (total > length) spill to canvas and return a `canvas_id` for SQL queries.

---

## Skills

Skills are modular instructions in `skills/` at the project root. Read them directly when a task matches — e.g., `skills/add-tool/SKILL.md` when adding a tool.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). This makes skills available as context without needing to reference `skills/` paths manually. After framework updates, run the `maintenance` skill — it re-syncs the agent directory automatically (Phase B).

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `devcheck` | Lint, format, typecheck, audit |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `maintenance` | Investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest` |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, logger, state, progress |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-workers` | Cloudflare Workers runtime |

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-05-21`).

---

## Commands

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run audit:refresh` | Delete `bun.lock`, reinstall, re-audit. Use when `devcheck` flags a transitive advisory — stale lockfile can mask already-patched deps. If advisory survives, it's real. |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting |
| `bun run test` | Run tests |
| `bun run lint:mcp` | Validate MCP definitions against spec |
| `bun run lint:packaging` | Validate env var alignment between `manifest.json` and `server.json` |
| `bun run bundle` | Build and pack as `.mcpb` for one-click Claude Desktop install |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from per-version files |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `bun run list-skills` | List available local skills (useful for sub-agents) |

---

## Bundling

`bun run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. MCPB is stdio-only — HTTP deployments are unaffected. Delete `manifest.json` and `.mcpbignore` if not needed; `lint:packaging` skips cleanly.

**Adding an env var requires both files:** `server.json` (`environmentVariables[]`) and `manifest.json` (`mcp_config.env`). `lint:packaging` (run by `devcheck`) verifies the names match.

---

## Changelog

Directory-based, grouped by minor series via the `.x` semver-wildcard convention. Source of truth: `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.1.x/0.1.0.md`) — one file per release, shipped in the npm package. At release, author the per-version file with a concrete version and date, then run `bun run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited or moved; read it for the frontmatter + section layout when scaffolding. `CHANGELOG.md` is a **navigation index** (header + link + summary per version), regenerated by `bun run changelog:build` — devcheck hard-fails on drift; never hand-edit it.

Each per-version file opens with YAML frontmatter:

```markdown
---
summary: "One-line headline, ≤350 chars"  # required — powers the rollup index
breaking: false                            # optional — true flags breaking changes
security: false                            # optional — true flags security fixes
---

# 0.1.0 — YYYY-MM-DD
...
```

`breaking: true` renders a `· ⚠️ Breaking` badge — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames). `security: true` renders a `· 🛡️ Security` badge and pairs with a `## Security` body section. When both are set, badges render `· ⚠️ Breaking · 🛡️ Security`.

**Section order** (Keep a Changelog): Added, Changed, Deprecated, Removed, Fixed, Security. Include only sections with entries — don't ship empty headers.

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getEiaApiService } from '@/services/eia/eia-service.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When regex/length constraints matter, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.state` for storage
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data
- [ ] EIA wrapping: raw/domain/output schemas reviewed against real upstream sparsity/nullability; data values are strings — do not coerce silently
- [ ] EIA wrapping: normalization and `format()` preserve uncertainty; do not fabricate facts from missing upstream data
- [ ] EIA wrapping: tests include at least one sparse payload case with omitted upstream fields
- [ ] Route tree and facet caches populated before use; retry/rate-limit contract declared on each tool
- [ ] DataCanvas spillover via `ctx.core.canvas?` — graceful degradation when absent
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `bun run devcheck` passes
