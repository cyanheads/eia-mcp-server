/**
 * @fileoverview Tool definition for eia_describe_route. Returns full metadata
 * for a leaf route: facets with valid values, data columns, frequencies, units,
 * and date range. Required reading before constructing filters for eia_query_route.
 * Facet values are fetched from separate /facet/{id} endpoints and merged.
 * @module mcp-server/tools/definitions/describe-route.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getEiaApiService } from '@/services/eia/eia-service.js';

export const describeRouteTool = tool('eia_describe_route', {
  title: 'Describe EIA Route',
  description:
    'Returns full metadata for a leaf route: available facets with their valid values, data column names and units, frequency options, and date range. Call this before eia_query_route to discover valid facet IDs, facet values, column IDs, and frequency codes. Facet values are fetched from separate EIA endpoints and merged — results are cached per-route for the process lifetime to minimize API calls.',
  annotations: { readOnlyHint: true, openWorldHint: false },

  input: z.object({
    route: z
      .string()
      .min(1)
      .describe(
        'Leaf route path (e.g. "electricity/retail-sales", "steo"). Discoverable via eia_browse_routes or eia_search_routes.',
      ),
  }),

  output: z.object({
    route: z.string().describe('The route path described.'),
    description: z.string().describe('Human-readable description of the dataset.'),
    facets: z
      .array(
        z.object({
          id: z.string().describe('Facet ID — use as filter key in eia_query_route.'),
          description: z.string().describe('Facet description.'),
          values: z
            .array(
              z.object({
                id: z.string().describe('Facet value ID — use as filter value.'),
                name: z.string().describe('Human-readable name.'),
                alias: z.string().optional().describe('Short alias, when provided by EIA.'),
              }),
            )
            .describe('Valid values for this facet dimension.'),
        }),
      )
      .describe('Filterable dimensions. Each facet has an ID and a set of valid values.'),
    data_columns: z
      .array(
        z.object({
          id: z.string().describe('Column ID — use in the columns parameter of eia_query_route.'),
          alias: z.string().describe('Human-readable column alias.'),
          units: z.string().describe('Measurement units (e.g. "cents per kilowatt-hour").'),
        }),
      )
      .describe('Data columns available for this route.'),
    frequencies: z
      .array(
        z.object({
          id: z.string().describe('Frequency ID (e.g. "monthly", "annual").'),
          description: z.string().describe('Human-readable description.'),
          query: z.string().describe('API query value for this frequency.'),
          format: z.string().describe('Period format string (e.g. "YYYY-MM", "YYYY").'),
        }),
      )
      .describe('Valid frequency options for eia_query_route.'),
    date_range: z
      .object({
        start: z.string().describe('Earliest available period.'),
        end: z.string().describe('Latest available period.'),
      })
      .describe('Available date range for this route.'),
    default_frequency: z.string().describe('Default frequency ID used when none is specified.'),
    default_date_format: z
      .string()
      .describe('Period format for the default frequency (e.g. "YYYY-MM").'),
  }),

  errors: [
    {
      reason: 'route_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Route does not exist in the EIA taxonomy.',
      recovery: 'Use eia_browse_routes or eia_search_routes to discover valid leaf route paths.',
    },
    {
      reason: 'route_not_queryable',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Route is a category node with sub-routes, not a queryable leaf.',
      recovery:
        'Use eia_browse_routes to drill into sub-routes, or eia_search_routes to find leaf routes.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.ServiceUnavailable,
      retryable: true,
      when: 'EIA rate limit hit during facet fan-out.',
      recovery: 'Back off and retry; use a production EIA API key for higher rate limits.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Executing eia_describe_route', { route: input.route });
    const service = getEiaApiService();
    const meta = await service.describe(input.route, ctx);

    return {
      route: meta.route,
      description: meta.description,
      facets: meta.facets.map((f) => ({
        id: f.id,
        description: f.description,
        values: f.values.map((v) => ({
          id: v.id,
          name: v.name,
          ...(v.alias !== undefined && { alias: v.alias }),
        })),
      })),
      data_columns: meta.dataColumns.map((c) => ({
        id: c.id,
        alias: c.alias,
        units: c.units,
      })),
      frequencies: meta.frequencies.map((freq) => ({
        id: freq.id,
        description: freq.description,
        query: freq.query,
        format: freq.format,
      })),
      date_range: {
        start: meta.dateRange.start,
        end: meta.dateRange.end,
      },
      default_frequency: meta.defaultFrequency,
      default_date_format: meta.defaultDateFormat,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`## ${result.route}`);
    if (result.description) lines.push(`\n${result.description}\n`);

    lines.push(`**Date range:** ${result.date_range.start} → ${result.date_range.end}`);
    lines.push(
      `**Default frequency:** ${result.default_frequency} (format: ${result.default_date_format})\n`,
    );

    if (result.data_columns.length) {
      lines.push('### Data columns');
      for (const col of result.data_columns) {
        lines.push(`- **${col.id}** (${col.alias}) — ${col.units}`);
      }
      lines.push('');
    }

    if (result.frequencies.length) {
      lines.push('### Frequencies');
      for (const freq of result.frequencies) {
        lines.push(
          `- **${freq.id}** (query: ${freq.query}) — ${freq.description} (format: ${freq.format})`,
        );
      }
      lines.push('');
    }

    if (result.facets.length) {
      lines.push('### Facets (filter dimensions)');
      for (const facet of result.facets) {
        const preview = facet.values.slice(0, 5);
        const more = facet.values.length > 5 ? ` (+${facet.values.length - 5} more)` : '';
        const valueList = preview
          .map((v) => (v.alias ? `${v.id}=${v.name} (${v.alias})` : `${v.id}=${v.name}`))
          .join(', ');
        lines.push(`- **${facet.id}**: ${facet.description} — ${valueList}${more}`);
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
