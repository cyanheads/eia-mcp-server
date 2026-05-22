# EIA MCP Server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `eia_browse_routes` | Lists child routes under a given path in the EIA dataset taxonomy. Start with no path to get top-level categories (electricity, petroleum, natural-gas, steo, aeo, ieo, seds, etc.), then drill into subcategories and leaf routes. | `path?` (route prefix, defaults to root) | `readOnlyHint`, `openWorldHint: false` |
| `eia_describe_route` | Returns full metadata for a leaf route: available facets with their valid values, data column names, frequency options, units, and date range. Call before `eia_query_route` to understand filter options. | `route` (e.g. `electricity/retail-sales`) | `readOnlyHint`, `openWorldHint: false` |
| `eia_search_routes` | Fuzzy text search across route names, descriptions, and category labels. Resolves natural-language queries like "gasoline retail prices" or "solar capacity by state" to matching route paths. | `query`, `limit?` | `readOnlyHint`, `openWorldHint: false` |
| `eia_query_route` | Fetches data from a leaf route with optional facet filters, date range, frequency, and column selection. Returns a preview inline; spills large result sets to a DataCanvas table for SQL analysis. | `route`, `filters?` (facet key-value pairs), `start?`, `end?`, `frequency?`, `columns?`, `sort?`, `limit?`, `canvas_id?` | `readOnlyHint`, `openWorldHint: false` |

### Resources

None. The route tree is dynamic and too large for stable URIs; tool access covers all workflows.

### Prompts

None. Purely data-access server.

---

## Overview

Exposes the U.S. Energy Information Administration's API v2 as a navigable, queryable MCP surface. Wraps a hierarchical dataset taxonomy with 14 top-level categories: electricity, petroleum, natural-gas, coal, international, total-energy, steo (Short-Term Energy Outlook — a single flat leaf with 1,469 named series accessed via `seriesId` facet), aeo (Annual Energy Outlook), ieo (International Energy Outlook), seds, crude-oil-imports, nuclear-outages, densified-biomass, and co2-emissions (deprecated). The core problem is discovery: hundreds of leaf routes each with their own facets and units. Four tools map to the two-phase workflow every query requires — first find the right route, then pull the data.

## Requirements

- Read-only access to EIA API v2 (`https://api.eia.gov/v2`)
- Free API key required (`EIA_API_KEY` env var); no write or admin operations
- Rate limits apply — DEMO_KEY hits limits quickly; production keys are more generous but EIA does enforce per-minute caps. Cache the route tree and facet values in-process to minimize upstream calls.
- Response format: JSON throughout; pagination via `offset`/`length` params and `total` in the response
- DataCanvas (DuckDB) for tabular spillover — opt-in, Node only; tools degrade gracefully when unavailable (`ctx.core.canvas` is undefined in Workers)
- No mutations, no account-scoped data — pure public dataset access

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `EiaApiService` | EIA API v2 (`api.eia.gov/v2`) | All four tools |

**Resilience:**
- Retry boundary: full fetch + parse pipeline in each service method, via `withRetry`
- Backoff: 1s base (EIA is generally stable; retry mainly for transient 5xx/timeouts)
- Parse failure: detect HTML error pages and classify as transient `ServiceUnavailable`, not `SerializationError`
- Field selection: pass EIA's `data[]` param to request only needed columns

**Route search strategy:** Fetch the full route tree lazily and cache in-process at startup (warm on first `eia_browse_routes` or `eia_search_routes` call). The route tree is stable between EIA releases. In-memory Fuse.js fuzzy index built once; no build-time pre-indexing needed. Include STEO's 1,469 `seriesId` values in the search index (fetched once via `/v2/steo/facet/seriesId`) so natural-language queries like "ethanol net imports" resolve to the right series ID.

**Facet value cache:** `eia_describe_route` fans out `Promise.all` calls to `/v2/{route}/facet/{facetId}` (one per facet). Results are merged into the route metadata and cached per-route — key `{route}` → merged metadata object — to avoid repeat fan-out on subsequent describe or query calls. Retry boundary wraps the full fan-out, not individual facet calls, so a single facet 5xx doesn't partially poison the merged result.

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `EIA_API_KEY` | Yes | Free key from api.eia.gov — appended as `api_key` query param on every request |
| `EIA_BASE_URL` | No | Defaults to `https://api.eia.gov/v2`; overridable for testing |
| `CANVAS_PROVIDER_TYPE` | No | Set to `duckdb` to enable DataCanvas spillover (Node only) |

## Implementation Order

1. Config (`src/config/server-config.ts`) — Zod schema for the env vars above
2. `EiaApiService` — browse, describe, and query methods with retry/timeout; route-tree cache + Fuse.js index
3. `eia_browse_routes` — thin wrapper over service browse method
4. `eia_describe_route` — thin wrapper; error contract for unknown routes
5. `eia_search_routes` — fuzzy search against the in-memory index
6. `eia_query_route` — filters, pagination, DataCanvas spillover (`ctx.core.canvas?`)

Each step is independently testable. Tools 3–5 can be built and exercised before DataCanvas integration in step 6.

---

## Tool Detail

### `eia_browse_routes`

Lists child routes at a given path. Root call returns 14 top-level categories. Intermediate paths return subcategories. Leaf routes are flagged so callers know when to switch to `eia_describe_route`. A node is a leaf when its metadata response contains `frequency`/`facets`/`data` fields instead of a `routes` array.

**Input schema:**
- `path?: string` — Route path to browse (e.g. `"electricity"`, `"petroleum/pri"`). Omit for root.

**Output:**
- `path: string` — the path browsed
- `children: Array<{ id, name, description, route, isLeaf }>` — child entries from the API's `routes[]`; `isLeaf` is determined by probing each child: a child is a leaf if its metadata response contains `frequency`/`facets`/`data` fields rather than a nested `routes[]`. Note: this requires one probe call per child to determine leaf status — limit child probing to shallow depth or defer isLeaf detection to `eia_describe_route`.
- `isLeaf: boolean` — true when the path itself is a leaf (nothing to drill into; use `eia_describe_route`)

**Errors:**
- `route_not_found` (`NotFound`) — path doesn't exist in the taxonomy

**Annotations:** `readOnlyHint: true`, `openWorldHint: false`

---

### `eia_describe_route`

Full schema for a leaf route. Required reading before constructing facet filters.

**Input schema:**
- `route: string` — Leaf route path (e.g. `"electricity/retail-sales"`)

**Implementation note:** The EIA v2 API does NOT embed facet values in the route metadata response — they are fetched via separate calls to `/v2/{route}/facet/{facetId}` (one per facet). The service method must fan out these calls in parallel (`Promise.all`) and merge results. Cache the merged metadata per-route in-process to avoid repeat fan-out.

**Output:**
- `route: string`
- `description: string`
- `facets: Array<{ id, description, values: Array<{ id, name, alias }> }>` — filterable dimensions with valid values (merged from per-facet calls)
- `data_columns: Array<{ id, alias, units }>` — numeric columns available for the `data[]` param; sourced from the metadata `data` object (keyed by column id, each entry has `alias` and `units`)
- `frequencies: Array<{ id, description, query, format }>` — valid frequency options with their API query codes and period format strings
- `date_range: { start: string, end: string }` — from `startPeriod`/`endPeriod` in the API response
- `default_frequency: string` — the route's default frequency (from `defaultFrequency`)
- `default_date_format: string` — period format for the default frequency (e.g. `"YYYY-MM"`)

**Errors:**
- `route_not_found` (`NotFound`) — not a known leaf route; suggest `eia_browse_routes` or `eia_search_routes`
- `route_not_queryable` (`InvalidParams`) — path exists but is a category, not a leaf
- `rate_limited` (`ServiceUnavailable`, retryable) — EIA rate limit hit during facet fan-out; back off and retry

**Annotations:** `readOnlyHint: true`, `openWorldHint: false`

---

### `eia_search_routes`

Fuzzy search across the in-memory route index. Useful when the caller doesn't know the route tree structure and wants to resolve natural language ("natural gas spot prices") to a route path.

**Input schema:**
- `query: string` — Free-text search terms
- `limit?: number` — Max results to return (default 10, max 30)

**Output:**
- `results: Array<{ route, name, description, score }>` — ranked matches; `route` is directly usable in `eia_describe_route` or `eia_query_route` if `isLeaf`
- `isLeaf` field per result — callers know whether to browse further or query directly
- `total_indexed: number` — size of the search index (orientation signal)

**Annotations:** `readOnlyHint: true`, `openWorldHint: false`

---

### `eia_query_route`

Pulls data from a leaf route. Core data retrieval tool — use `eia_describe_route` first to discover valid facets and columns.

**Implementation note:** Data is fetched from `/v2/{route}/data/` (note the `/data/` suffix — the metadata and data endpoints are distinct paths). Query params: `frequency`, `data[]` (columns), `facets[facetId][]`, `start`, `end`, `sort[]`, `offset`, `length` (max 5000 per page). The API returns a `warnings[]` array when results are truncated server-side. Data values are returned as **strings** (e.g. `"9.13"`, not `9.13`); units for each column appear as inline `{col}-units` fields in each row (e.g. `"price-units": "cents per kilowatt-hour"`).

**Input schema:**
- `route: string` — Leaf route path (e.g. `"electricity/retail-sales"`)
- `filters?: Record<string, string | string[]>` — Facet filters keyed by facet ID (e.g. `{ "stateid": "TX", "sectorid": ["RES", "COM"] }`). Facet IDs and valid values discoverable via `eia_describe_route`.
- `columns?: string[]` — Data column IDs to return (reduces payload; defaults to all). Column IDs discoverable via `eia_describe_route`.
- `frequency?: string` — Aggregation frequency ID (e.g. `"monthly"`, `"annual"`, `"quarterly"`). Defaults to route's `defaultFrequency`. Valid IDs returned by `eia_describe_route`.
- `start?: string` — Period start in the route's date format (e.g. `"2020-01"` for monthly, `"2020"` for annual). Format discoverable via `eia_describe_route`.
- `end?: string` — Period end (same format as `start`)
- `sort?: Array<{ column: string; direction: "asc" | "desc" }>` — Result ordering
- `offset?: number` — Pagination offset (default 0); use with `length` to page through results
- `length?: number` — Rows to fetch per page (default 100, max 5000)
- `canvas_id?: string` — DataCanvas ID to register or append to; minted on omit when canvas is available

**Output:**
- `route: string`
- `data: Array<Record<string, string | null>>` — preview rows; note all numeric values are strings per EIA API
- `total: number` — total matching rows (parsed from API's string `total` field)
- `returned_count: number` — rows in this response (useful for chaining: when `returned_count < total`, use `offset`/canvas for the rest)
- `frequency: string` — frequency of the returned data
- `date_format: string` — period format for the returned data (e.g. `"YYYY-MM"`)
- `canvas_id?: string` — present when spillover occurred; use for SQL queries over the full result
- `canvas_preview_note?: string` — human-readable note when total > length (e.g. "Showing 100 of 4,320 rows — query canvas for full dataset")
- `truncation_warning?: string` — forwarded from EIA's `warnings[]` when the API itself warns of incomplete results (row count approaches 5,000 per-page limit)

**Errors:**
- `route_not_found` (`NotFound`) — route doesn't exist or isn't a leaf
- `invalid_facet` (`InvalidParams`) — unknown facet key; hint to call `eia_describe_route`
- `invalid_facet_value` (`InvalidParams`) — unknown value for a known facet; includes valid values in error data
- `no_data` (`NotFound`, non-retryable) — route exists but filters yield zero rows; suggest broadening filters or removing date constraints
- `length_exceeded` (`InvalidParams`) — `length` > 5000 (EIA hard limit); reduce to 5000 or use pagination
- `rate_limited` (`ServiceUnavailable`, retryable) — EIA rate limit hit (OVER_RATE_LIMIT in API response); back off and retry

**Annotations:** `readOnlyHint: true`, `openWorldHint: false`

---

## Workflow Analysis

### Discovery → Query

| # | Action | Tool |
|:--|:-------|:-----|
| 1 | Identify domain | `eia_browse_routes` (root) |
| 2 | Drill to leaf | `eia_browse_routes` (category path) |
| 3 | Inspect facets | `eia_describe_route` |
| 4 | Pull data | `eia_query_route` (with filters from step 3) |
| 5 | Analyze full set | SQL on `canvas_id` if spillover occurred |

### Fuzzy Discovery → Query

| # | Action | Tool |
|:--|:-------|:-----|
| 1 | Resolve natural language to route | `eia_search_routes` |
| 2 | Confirm facets | `eia_describe_route` |
| 3 | Pull data | `eia_query_route` |

---

## Known Limitations

- **STEO is a single flat leaf, not a subtree**: `steo` is a top-level leaf route with a single `seriesId` facet covering 1,469 named series (e.g. `PATCPUS` for petroleum prices). There are no sub-routes under `steo/`. Discovery works via `eia_describe_route` on `steo` to list the full `seriesId` facet catalog, then filter by `seriesId` in `eia_query_route`. `eia_search_routes` should index these series names for fuzzy matching.
- **Facet value fetch cost**: `eia_describe_route` fans out one HTTP call per facet to `/facet/{id}` — a route with 5 facets costs 6 total requests (1 metadata + 5 facet). Cache merged metadata per-route in-process. STEO's 1,469-value seriesId facet is an especially large payload; consider whether to include all values or paginate the facet list.
- **Data values are strings**: All numeric data from the `/data/` endpoint arrives as strings (e.g. `"9.13"`). Consumers doing arithmetic need to parse. Surfaced in output schema.
- **Route tree currency**: In-process cache is valid for server lifetime. EIA occasionally adds leaf routes between releases; a server restart picks them up.
- **International data granularity**: `international/` routes have coarser facets than domestic routes (country, not state). Fully accessible but sub-national breakdowns aren't available for most countries.
- **No bulk multi-route queries**: Each `eia_query_route` call targets one leaf route. Cross-route comparisons require multiple tool calls.
- **Deprecated routes**: `co2-emissions` is deprecated (API response carries a deprecation notice pointing to `seds`). `eia_browse_routes` should surface this notice; `eia_search_routes` may want to down-rank or annotate deprecated routes.

---

## Decisions Log

### Answered questions

- **Pre-index vs. live discovery for search** → In-process cache + Fuse.js warm on first call. Avoids build-time complexity; EIA's discovery endpoints are fast and the tree is small enough (~hundreds of routes) to hold in memory. No file system dependency, no stale index artifact.
- **STEO forecasts: separate tool or fold into `query_route`?** → Fold into `query_route`. STEO is a single flat leaf route (not a subtree) accessed by filtering `seriesId` facet. A dedicated tool would duplicate the query interface with no additional capability. Discovery relies on `eia_describe_route` on `steo` and `eia_search_routes` indexing the 1,469 series names.
- **Facet validation: enumerate at describe time or let EIA reject?** → Enumerate at describe time via `eia_describe_route`. Surfacing valid values in the MCP layer means better error messages and faster iteration — the caller knows what's valid before sending a query, rather than interpreting an opaque EIA 400.
- **DataCanvas spillover: opt-in or always-on?** → Opt-in via `CANVAS_PROVIDER_TYPE=duckdb`. DuckDB has no V8-isolate build, so Workers deployments would break if it were always attempted. Canvas presence checked via `ctx.core.canvas?` at runtime; tool degrades gracefully to preview-only when absent.
- **Resources?** → None. The route tree is dynamic (hundreds of entries, arbitrary depth) — stable URIs don't fit. All data access via tools; tool-only agents are fully served.

### Options declined

- **Build-time pre-indexed search file** → Adds a build artifact, requires regeneration on EIA updates, and complicates deployment. In-memory lazy cache is simpler and adequate for the dataset size.
- **Dedicated `eia_forecast` or `eia_steo` tool** → Redundant with `eia_query_route` targeting the `steo` leaf route via `seriesId` facet. Adds surface complexity for no capability gain.
- **App tools / resources for route browsing** → Route tree is dynamic and session-state-free; a resource URI can't capture arbitrary browse position. Standard tools handle the workflow cleanly.
- **Per-route facet cache with invalidation logic** → The facet cache is write-once per process lifetime (no TTL, no ETag-based invalidation). EIA facet catalogs are stable and not versioned in API responses; a server restart is the appropriate refresh mechanism. Adding cache invalidation would add complexity with no practical benefit.
- **`eia_compare_routes` multi-route query tool** → Agents can call `eia_query_route` N times. A cross-route join tool adds significant complexity (schema reconciliation, unit mismatch handling) for a workflow the agent can orchestrate itself via canvas SQL.

### Verified against live API (2026-05-21)

- **Route tree structure:** `GET /v2/` returns `routes[]` with `{id, name, description}` — 14 top-level entries (coal, crude-oil-imports, electricity, international, natural-gas, nuclear-outages, petroleum, seds, steo, densified-biomass, total-energy, aeo, ieo, co2-emissions). Browsing is a live tree-walk — there is no single "get all routes" batch endpoint; the implementation must walk the tree recursively.
- **Leaf detection:** A node is a leaf when its metadata response contains `frequency`/`facets`/`data` fields rather than a `routes[]` array.
- **Facet values require separate calls:** Route metadata (`GET /v2/{route}/`) returns facets as `[{id, description}]` only — no values. Valid facet values require `GET /v2/{route}/facet/{facetId}`, which returns `{totalFacets, facets: [{id, name, alias}]}`. The design's prior claim that values were embedded in route metadata was incorrect.
- **Data columns format:** Route metadata `data` field is an object keyed by column ID: `{colId: {alias, units}}` — not an array. Design output schema updated accordingly.
- **Date range fields:** `startPeriod`/`endPeriod` (not `start`/`end`). Also includes `defaultDateFormat` and `defaultFrequency`.
- **Data endpoint:** `/v2/{route}/data/` (separate from the metadata path). Accepts `frequency`, `data[]`, `facets[facetId][]`, `start`, `end`, `sort[]`, `offset`, `length`. Max `length` = 5000. Response includes `total` (string) and a `warnings[]` array when results are truncated server-side.
- **Data values are strings:** All numeric values in `data[]` rows are strings (e.g. `"9.13"`). Per-column units appear as `{col}-units` fields inline in each row.
- **STEO structure:** `steo` is a top-level leaf (not a subtree). Has one facet: `seriesId` with 1,469 values. Queried directly with `seriesId` filters; no sub-routes exist.
- **Rate limits are real:** DEMO_KEY hits rate limits after a few calls. Production keys are more generous but limits apply — in-process caching of route tree and facet values is essential, not optional.
