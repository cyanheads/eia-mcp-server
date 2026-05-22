# EIA MCP Server — Design

## MCP Surface

### Tools

4 tools + 3 dataframe tools (+1 opt-in dataframe drop)

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `eia_browse_routes` | Lists child routes under a given path in the EIA dataset taxonomy. Start with no path to get top-level categories (electricity, petroleum, natural-gas, steo, aeo, ieo, seds, etc.), then drill into subcategories and leaf routes. | `path?` (route prefix, defaults to root) | `readOnlyHint`, `openWorldHint: false` |
| `eia_describe_route` | Returns full metadata for a leaf route: available facets with their valid values, data column names, frequency options, units, and date range. Call before `eia_query_route` to understand filter options. | `route` (e.g. `electricity/retail-sales`) | `readOnlyHint`, `openWorldHint: false` |
| `eia_search_routes` | Fuzzy text search across route names, descriptions, and category labels. Resolves natural-language queries like "gasoline retail prices" or "solar capacity by state" to matching route paths. | `query`, `limit?` | `readOnlyHint`, `openWorldHint: false` |
| `eia_query_route` | Fetches data from a leaf route with optional facet filters, date range, frequency, and column selection. Returns a preview inline; spills large result sets to a DataCanvas table for SQL analysis. Returns `canvas_id` and `dataset` (`df_<id>`) when spillover occurs. | `route`, `filters?` (facet key-value pairs), `start?`, `end?`, `frequency?`, `columns?`, `sort?`, `limit?`, `canvas_id?` | `readOnlyHint`, `openWorldHint: false` |
| `eia_dataframe_describe` | List canvas dataframes materialized by `eia_query_route`, with provenance, TTL, row count, and column schema. | `name?` (single `df_<id>` or omit for all) | `readOnlyHint`, `idempotentHint`, `openWorldHint: false` |
| `eia_dataframe_query` | Run a single-statement SELECT across canvas dataframes. Supports `register_as` to persist results as new dataframes. Read-only: writes, DDL, DROP, COPY, PRAGMA, ATTACH, and external-file table functions are rejected by the framework SQL gate. System catalogs are denied at the bridge layer. | `sql`, `register_as?`, `preview?`, `row_limit?` | `readOnlyHint`, `idempotentHint`, `openWorldHint: false` |
| `eia_dataframe_drop` | Drop a canvas dataframe by name. **Opt-in** via `EIA_DATAFRAME_DROP_ENABLED=true` — off by default since TTL handles cleanup. Idempotent: returns `dropped=false` when nothing matched. | `name` | `readOnlyHint: false`, `idempotentHint`, `destructiveHint: true` |

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
| `EiaApiService` | EIA API v2 (`api.eia.gov/v2`) | All four data tools |
| `CanvasBridgeService` | Framework `DataCanvas` (`ctx.core.canvas`) | `eia_query_route` (register), `eia_dataframe_describe`, `eia_dataframe_query`, `eia_dataframe_drop` |

**`CanvasBridgeService`** adapts the generic `DataCanvas` primitive for EIA-specific workflows:
- Mints `df_<id>` handles for each registered table (deterministic, collision-resistant; bridged to the canvas table name).
- Derives an all-nullable column schema from the first 100 rows of an EIA result set. All EIA data values arrive as strings; the bridge maps them to `VARCHAR` by default and records this in provenance so SQL consumers know to `CAST` when doing arithmetic.
- Tracks per-table provenance: source tool, original input parameters, creation/expiry timestamps, row count, and truncation flag.
- Applies a sliding per-table TTL (default 24 h, override with `EIA_DATASET_TTL_SECONDS`) distinct from the canvas-level TTL. Expired entries are lazy-swept on `describe`.
- Bridge-layer deny of DuckDB system catalogs (`information_schema`, `pg_catalog`, `sqlite_master`, `duckdb_*`) so callers cannot enumerate `df_<id>` handles they don't already hold. Callers discover handles via `eia_query_route` output or `eia_dataframe_describe`.

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
| `CANVAS_PROVIDER_TYPE` | No | Set to `duckdb` to enable DataCanvas spillover and dataframe tools (Node only; Workers fail closed) |
| `EIA_DATASET_TTL_SECONDS` | No | Per-table TTL for canvas-registered dataframes. Default `86400` (24 h), sliding — touched on every dataframe operation. Independent from the canvas-level TTL. |
| `EIA_DATAFRAME_DROP_ENABLED` | No | Set to `true` to expose `eia_dataframe_drop`. Default `false`; TTL handles cleanup in normal operation. |

## Implementation Order

1. Config (`src/config/server-config.ts`) — Zod schema for the env vars above, including `EIA_DATASET_TTL_SECONDS` and `EIA_DATAFRAME_DROP_ENABLED`
2. `EiaApiService` — browse, describe, and query methods with retry/timeout; route-tree cache + Fuse.js index
3. `eia_browse_routes` — thin wrapper over service browse method
4. `eia_describe_route` — thin wrapper; error contract for unknown routes
5. `eia_search_routes` — fuzzy search against the in-memory index
6. `eia_query_route` — filters, pagination, DataCanvas spillover (`ctx.core.canvas?`); emit `canvas_id` + `dataset` (`df_<id>`) on spillover
7. `CanvasBridgeService` (`src/services/canvas-bridge/`) — `df_<id>` minting, provenance tracking, per-table TTL, system-catalog deny
8. `eia_dataframe_describe` / `eia_dataframe_query` — layered on the bridge; describe lazy-sweeps expired tables
9. `eia_dataframe_drop` — conditional registration in `createApp()` guarded by `EIA_DATAFRAME_DROP_ENABLED`

Each step is independently testable. Tools 3–5 can be built and exercised before DataCanvas integration in step 6. The bridge (step 7) can be tested in isolation before the dataframe tools depend on it.

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
- `data: Array<Record<string, string | null>>` — preview rows; all numeric values are strings per EIA API (cast in SQL when arithmetic is needed: `CAST(value AS DOUBLE)`)
- `total: number` — total matching rows (parsed from API's string `total` field)
- `returned_count: number` — rows in this response (useful for chaining: when `returned_count < total`, use `offset`/canvas for the rest)
- `frequency: string` — frequency of the returned data
- `date_format: string` — period format for the returned data (e.g. `"YYYY-MM"`)
- `canvas_id?: string` — present when spillover occurred. The canvas ID identifies the shared DuckDB canvas workspace (pass on subsequent calls to accumulate multiple route results into the same canvas).
- `dataset?: string` — present when spillover occurred. The `df_<id>` handle for the registered table within the canvas — pass this directly to `eia_dataframe_query` SQL (`SELECT ... FROM df_<id>`). Distinct from `canvas_id`: one canvas can hold multiple `df_<id>` tables.
- `canvas_preview_note?: string` — human-readable note when total > length (e.g. "Showing 100 of 4,320 rows — query canvas for full dataset")
- `truncation_warning?: string` — forwarded from EIA's `warnings[]` when the API itself warns of incomplete results (row count approaches 5,000 per-page limit)

**Type inference note:** DuckDB infers column types from the first ~100 rows of each registered result. Because all EIA values arrive as strings, the bridge sets the schema explicitly as `VARCHAR` for data columns. SQL consumers that need numeric results must cast: `CAST(value AS DOUBLE)`, `CAST(value AS INTEGER)`. Aggregates (`SUM`, `AVG`) also require an explicit cast since DuckDB will not coerce `VARCHAR` to numeric implicitly.

**Errors:**
- `route_not_found` (`NotFound`) — route doesn't exist or isn't a leaf
- `invalid_facet` (`InvalidParams`) — unknown facet key; hint to call `eia_describe_route`
- `invalid_facet_value` (`InvalidParams`) — unknown value for a known facet; includes valid values in error data
- `no_data` (`NotFound`, non-retryable) — route exists but filters yield zero rows; suggest broadening filters or removing date constraints
- `length_exceeded` (`InvalidParams`) — `length` > 5000 (EIA hard limit); reduce to 5000 or use pagination
- `rate_limited` (`ServiceUnavailable`, retryable) — EIA rate limit hit (OVER_RATE_LIMIT in API response); back off and retry

**Annotations:** `readOnlyHint: true`, `openWorldHint: false`

---

### `eia_dataframe_describe`

Lists canvas dataframes materialized by `eia_query_route` — provenance, TTL, row count, and column schema. Lazy-sweeps expired tables before responding so the list is always current.

**Input schema:**
- `name?: string` — `df_<id>` handle to describe a single dataframe. Omit to list all active dataframes for this tenant.

**Output:**
- `dataframes: Array<{ name, source_tool, query_params, created_at, expires_at, row_count, truncated, max_rows?, column_schema }>` — newest first; empty when none are registered

**Errors:**
- `canvas_unavailable` (`ServiceUnavailable`) — canvas not configured; set `CANVAS_PROVIDER_TYPE=duckdb`

**Annotations:** `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false`

---

### `eia_dataframe_query`

Single-statement SELECT across canvas dataframes. Standard DuckDB SQL — joins, aggregates, window functions, CTEs all supported. Reference dataframes by the `df_<id>` handles returned by `eia_query_route` or listed by `eia_dataframe_describe`.

**Input schema:**
- `sql: string` — Single-statement SELECT. Data columns from EIA are `VARCHAR` — use `CAST(col AS DOUBLE)` when arithmetic or aggregation is needed.
- `register_as?: string` — Persist the query result as a new `df_<id>` with a fresh TTL. Use to chain analyses without re-running the upstream tool calls. Conflicts with an existing name throw `Conflict`.
- `preview?: number` — Rows to include in the immediate response (0–10 000). Defaults to `row_limit`. Set lower when chaining via `register_as` and only a sample is needed inline.
- `row_limit?: number` — Hard cap on rows materialized in the response (default 1000, max 10 000). When `register_as` is set, the full result lives on-canvas; raise this only for inline inspection.

**Output:**
- `columns: string[]` — Column names in projection order
- `row_count: number` — Total rows the query produced (may exceed `rows.length` when capped)
- `rows: Array<Record<string, unknown>>` — Materialized rows, bounded by `preview`/`row_limit`
- `registered_as?: string` — New dataframe name when `register_as` was supplied
- `expires_at?: string` — ISO 8601 expiry for the newly registered dataframe

**Read-only enforcement (four layers):**
1. Text-level deny-list — file/HTTP-reading table functions (`read_csv*`, `read_json*`, `read_parquet*`, etc.)
2. Statement count — must be exactly 1
3. Statement type — must be `SELECT`
4. EXPLAIN-plan walk — allowlisted physical operators; denied-function rescan over plan metadata

Bridge-layer additionally denies system catalogs (`information_schema`, `pg_catalog`, `sqlite_master`, `duckdb_*`) — callers cannot enumerate `df_<id>` tables they don't already hold a handle for.

**Errors:**
- `canvas_unavailable` (`ServiceUnavailable`) — canvas not configured; set `CANVAS_PROVIDER_TYPE=duckdb`

**Annotations:** `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false`

---

### `eia_dataframe_drop`

Drop a canvas dataframe by name. **Opt-in** — only registered in `createApp()` when `EIA_DATAFRAME_DROP_ENABLED=true`. Idempotent: returns `dropped=false` when nothing matched. Use to free canvas resources ahead of the per-table TTL when an analysis is complete; in normal operation, TTL cleanup is sufficient and this tool is unnecessary.

**Input schema:**
- `name: string` — `df_<id>` handle to drop

**Output:**
- `name: string` — The name that was requested
- `dropped: boolean` — `true` when the dataframe existed and was removed; `false` when nothing matched

**Errors:**
- `canvas_unavailable` (`ServiceUnavailable`) — canvas not configured; set `CANVAS_PROVIDER_TYPE=duckdb`

**Annotations:** `readOnlyHint: false`, `idempotentHint: true`, `destructiveHint: true`, `openWorldHint: false`

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

### Multi-Route Canvas Analysis

Addresses the prior "no bulk multi-route queries" limitation. Call `eia_query_route` N times with the same `canvas_id` to accumulate multiple route result sets into one canvas workspace, then use `eia_dataframe_query` to join or compare them in a single SQL statement.

| # | Action | Tool | Notes |
|:--|:-------|:-----|:------|
| 1 | Pull electricity retail sales | `eia_query_route` | `canvas_id` omitted → minted; returns `canvas_id` + `dataset` (`df_abc`) |
| 2 | Pull natural gas spot prices | `eia_query_route` | Same `canvas_id` passed in → returns second `dataset` (`df_xyz`) |
| 3 | Pull petroleum consumption by sector | `eia_query_route` | Same `canvas_id` → third `dataset` (`df_def`) |
| 4 | GROUP BY state / sector / fuel; SUM production by period | `eia_dataframe_query` | `SELECT period, SUM(CAST(value AS DOUBLE)) ... FROM df_abc GROUP BY period ORDER BY period` |
| 5 | JOIN two route results by period | `eia_dataframe_query` | `SELECT a.period, CAST(a.value AS DOUBLE), CAST(b.value AS DOUBLE) FROM df_abc a JOIN df_xyz b ON a.period = b.period` |
| 6 | Persist join result for follow-up | `eia_dataframe_query` | `register_as: "df_joined_energy"` — fresh TTL; chain further aggregates without re-running source queries |
| 7 | Inspect active dataframes | `eia_dataframe_describe` | Verify handles, row counts, expiry |

**Key cast pattern:** EIA data values are `VARCHAR` in the canvas. Any arithmetic or aggregation (`SUM`, `AVG`, arithmetic operators) requires an explicit cast: `CAST(value AS DOUBLE)`. String comparisons and period filtering work on the raw `VARCHAR` columns without casting.

---

## Known Limitations

- **STEO is a single flat leaf, not a subtree**: `steo` is a top-level leaf route with a single `seriesId` facet covering 1,469 named series (e.g. `PATCPUS` for petroleum prices). There are no sub-routes under `steo/`. Discovery works via `eia_describe_route` on `steo` to list the full `seriesId` facet catalog, then filter by `seriesId` in `eia_query_route`. `eia_search_routes` should index these series names for fuzzy matching.
- **Facet value fetch cost**: `eia_describe_route` fans out one HTTP call per facet to `/facet/{id}` — a route with 5 facets costs 6 total requests (1 metadata + 5 facet). Cache merged metadata per-route in-process. STEO's 1,469-value seriesId facet is an especially large payload; consider whether to include all values or paginate the facet list.
- **Data values are strings**: All numeric data from the `/data/` endpoint arrives as strings (e.g. `"9.13"`). Consumers doing arithmetic need to parse. Surfaced in output schema.
- **Route tree currency**: In-process cache is valid for server lifetime. EIA occasionally adds leaf routes between releases; a server restart picks them up.
- **International data granularity**: `international/` routes have coarser facets than domestic routes (country, not state). Fully accessible but sub-national breakdowns aren't available for most countries.
- **No bulk multi-route queries in a single call**: Each `eia_query_route` call targets one leaf route. Cross-route comparisons require multiple tool calls. However, calling `eia_query_route` N times with the same `canvas_id` accumulates multiple result sets into one canvas, and `eia_dataframe_query` can JOIN them in a single SQL statement — see "Multi-Route Canvas Analysis" workflow above.
- **Dataframe tools require `CANVAS_PROVIDER_TYPE=duckdb`**: Node.js only. DuckDB has no V8-isolate build; setting `CANVAS_PROVIDER_TYPE=duckdb` on a Cloudflare Workers deployment fails closed with a `ConfigurationError` at init time. When canvas is absent, `eia_query_route` degrades to preview-only and the three dataframe tools are not available (or return `canvas_unavailable`).
- **Deprecated routes**: `co2-emissions` is deprecated (API response carries a deprecation notice pointing to `seds`). `eia_browse_routes` should surface this notice; `eia_search_routes` may want to down-rank or annotate deprecated routes.

---

## Decisions Log

### Answered questions

- **Pre-index vs. live discovery for search** → In-process cache + Fuse.js warm on first call. Avoids build-time complexity; EIA's discovery endpoints are fast and the tree is small enough (~hundreds of routes) to hold in memory. No file system dependency, no stale index artifact.
- **STEO forecasts: separate tool or fold into `query_route`?** → Fold into `query_route`. STEO is a single flat leaf route (not a subtree) accessed by filtering `seriesId` facet. A dedicated tool would duplicate the query interface with no additional capability. Discovery relies on `eia_describe_route` on `steo` and `eia_search_routes` indexing the 1,469 series names.
- **Facet validation: enumerate at describe time or let EIA reject?** → Enumerate at describe time via `eia_describe_route`. Surfacing valid values in the MCP layer means better error messages and faster iteration — the caller knows what's valid before sending a query, rather than interpreting an opaque EIA 400.
- **DataCanvas spillover: opt-in or always-on?** → Opt-in via `CANVAS_PROVIDER_TYPE=duckdb`. DuckDB has no V8-isolate build, so Workers deployments would break if it were always attempted. Canvas presence checked via `ctx.core.canvas?` at runtime; tool degrades gracefully to preview-only when absent.
- **Resources?** → None. The route tree is dynamic (hundreds of entries, arbitrary depth) — stable URIs don't fit. All data access via tools; tool-only agents are fully served.
- **Why expose dataframe tools at all?** → EIA datasets are multi-dimensional: a single route might return data across states, sectors, fuel types, and periods simultaneously. Inline preview rows (bounded to avoid context overflow) are sufficient for narrow queries but blind for analysis across facet combinations. Canvas SQL lets the agent GROUP, SUM, and JOIN on the full result set without re-fetching upstream data. The three dataframe tools are the analytical complement to `eia_query_route`, not a separate workflow.
- **Why opt-in drop (`EIA_DATAFRAME_DROP_ENABLED`)?** → TTL (default 24 h, sliding) already handles cleanup for normal usage patterns. An always-on drop tool adds a destructive surface with no benefit in the common case. Opt-in makes the risk explicit — operators who need manual cleanup in long-running sessions enable it deliberately.
- **Why expose `register_as` chaining in `eia_dataframe_query`?** → Derived aggregates (e.g., a JOIN of electricity prices and gas prices, grouped by region and period) are expensive to reconstruct from raw route results. Persisting them as a named dataframe with a fresh TTL lets the agent build incrementally — query once, reuse across follow-up questions in the same session — without re-running N `eia_query_route` calls.
- **How do dataframe tools address the prior "no bulk multi-route queries" limitation?** → They don't remove it at the single-call level (each `eia_query_route` still targets one leaf route), but they provide the join layer that was missing. Call `eia_query_route` N times with the same `canvas_id` to stage N result sets, then use `eia_dataframe_query` to JOIN them. The limitation entry in Known Limitations has been updated to reflect this path.

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
