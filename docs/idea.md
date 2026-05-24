# eia-energy-mcp-server — Idea

Pre-design seed. Feeds into `design-mcp-server` to produce `docs/design.md`.

## Domain

US Energy Information Administration — official source for energy data: electricity, natural gas, petroleum, coal, nuclear, renewables, total energy, international, and environmental/emissions. Production, consumption, prices, capacity, imports/exports, and forecasts (STEO — Short-Term Energy Outlook).

## Data source

- **API:** https://www.eia.gov/opendata/ (API v2 is current)
- **Auth:** free API key, generous limits
- **Format:** JSON; navigable route tree (`/electricity/retail-sales`, `/natural-gas/prices/`, `/petroleum/pri/spt`) with facet-based filtering (region, sector, fuel type, end-use)
- **Key concept:** route → facets → data points. Hundreds of leaf routes; discovery is half the problem.

## User goals

- Discover what data is available (walk the route tree, resolve "gas prices" → the right leaf)
- Pull energy prices (gasoline retail, electricity retail/wholesale, natural gas spot)
- Production / consumption by state, region, sector, fuel type
- International comparisons (country-level energy mixes)
- Forecasts via STEO (production, prices, demand, 24-month horizon)

## Tool sketch

| Tool | Purpose |
|:-----|:--------|
| `eia_browse_routes` | Walk the dataset taxonomy — top-level (`electricity`, `petroleum`, …) → leaf routes |
| `eia_describe_route` | Schema for a route — available facets, data columns, frequency, units |
| `eia_query_route` | Pull data with facet filters, date range, frequency aggregation; spill large results to canvas |
| `eia_search_routes` | Free-text search across route names/descriptions for fuzzy discovery |

## Pairs with

- **fred-mcp-server** — CPI energy components, WTI/Brent oil series in FRED
- **secedgar-mcp-server** — energy sector filings paired with production/price context
- **nws-weather-mcp-server** — energy demand correlates with weather; cross-tool workflow opportunity
- **cdc-health-mcp-server** — heat/cold mortality vs. energy data follows a similar Socrata-style discovery pattern

## Open questions

- Route tree is large — pre-index for fuzzy search at build time, or hit EIA's discovery endpoints live?
- Tabular spillover almost certainly needed for multi-facet queries — DataCanvas
- STEO forecasts: separate tool, or fold into `query_route` with the forecast path?
- Facet validation: enumerate per-route at describe time, or let EIA reject bad filters?
