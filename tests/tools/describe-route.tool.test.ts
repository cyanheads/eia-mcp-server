/**
 * @fileoverview Tests for the eia_describe_route tool.
 * @module tests/tools/describe-route.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { describeRouteTool } from '@/mcp-server/tools/definitions/describe-route.tool.js';
import * as eiaService from '@/services/eia/eia-service.js';

vi.mock('@/services/eia/eia-service.js', () => ({
  getEiaApiService: vi.fn(),
  initEiaApiService: vi.fn(),
  _resetEiaApiService: vi.fn(),
}));

const mockDescribe = vi.fn();

const FULL_META = {
  route: 'electricity/retail-sales',
  description: 'Retail electricity sales by state and sector',
  facets: [
    {
      id: 'stateid',
      description: 'State',
      values: [
        { id: 'TX', name: 'Texas', alias: 'TX' },
        { id: 'CA', name: 'California' },
      ],
    },
  ],
  dataColumns: [
    { id: 'sales', alias: 'Electricity sales', units: 'million kilowatthours' },
    { id: 'revenue', alias: 'Revenue', units: 'million dollars' },
  ],
  frequencies: [
    { id: 'monthly', description: 'Monthly', query: 'monthly', format: 'YYYY-MM' },
    { id: 'annual', description: 'Annual', query: 'annual', format: 'YYYY' },
  ],
  dateRange: { start: '2001-01', end: '2024-11' },
  defaultFrequency: 'monthly',
  defaultDateFormat: 'YYYY-MM',
};

describe('describeRouteTool', () => {
  beforeEach(() => {
    vi.mocked(eiaService.getEiaApiService).mockReturnValue({
      describe: mockDescribe,
    } as unknown as ReturnType<typeof eiaService.getEiaApiService>);
    mockDescribe.mockReset();
  });

  it('returns full metadata for a leaf route', async () => {
    mockDescribe.mockResolvedValue(FULL_META);

    const ctx = createMockContext({ errors: describeRouteTool.errors });
    const input = describeRouteTool.input.parse({ route: 'electricity/retail-sales' });
    const result = await describeRouteTool.handler(input, ctx);

    expect(result.route).toBe('electricity/retail-sales');
    expect(result.facets).toHaveLength(1);
    expect(result.facets[0]?.id).toBe('stateid');
    expect(result.facets[0]?.values).toHaveLength(2);
    expect(result.data_columns).toHaveLength(2);
    expect(result.frequencies).toHaveLength(2);
    expect(result.date_range.start).toBe('2001-01');
    expect(result.default_frequency).toBe('monthly');
  });

  it('includes optional alias on facet values when present', async () => {
    mockDescribe.mockResolvedValue(FULL_META);

    const ctx = createMockContext({ errors: describeRouteTool.errors });
    const input = describeRouteTool.input.parse({ route: 'electricity/retail-sales' });
    const result = await describeRouteTool.handler(input, ctx);

    const txValue = result.facets[0]?.values.find((v) => v.id === 'TX');
    expect(txValue?.alias).toBe('TX');

    const caValue = result.facets[0]?.values.find((v) => v.id === 'CA');
    expect(caValue?.alias).toBeUndefined();
  });

  it('propagates route_not_found', async () => {
    const { notFound } = await import('@cyanheads/mcp-ts-core/errors');
    mockDescribe.mockRejectedValue(notFound('Not found', { reason: 'route_not_found' }));

    const ctx = createMockContext({ errors: describeRouteTool.errors });
    const input = describeRouteTool.input.parse({ route: 'bad/route' });

    await expect(describeRouteTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  it('propagates route_not_queryable for categories', async () => {
    const { invalidParams } = await import('@cyanheads/mcp-ts-core/errors');
    mockDescribe.mockRejectedValue(invalidParams('Not a leaf', { reason: 'route_not_queryable' }));

    const ctx = createMockContext({ errors: describeRouteTool.errors });
    const input = describeRouteTool.input.parse({ route: 'electricity' });

    await expect(describeRouteTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
    });
  });

  describe('format()', () => {
    it('renders all required fields including query and alias', () => {
      const result = {
        route: 'electricity/retail-sales',
        description: 'Retail electricity sales',
        facets: [
          {
            id: 'stateid',
            description: 'State',
            values: [{ id: 'TX', name: 'Texas', alias: 'TX' }],
          },
        ],
        data_columns: [{ id: 'sales', alias: 'Sales', units: 'MWh' }],
        frequencies: [
          { id: 'monthly', description: 'Monthly', query: 'monthly', format: 'YYYY-MM' },
        ],
        date_range: { start: '2001-01', end: '2024-11' },
        default_frequency: 'monthly',
        default_date_format: 'YYYY-MM',
      };

      const blocks = describeRouteTool.format!(result);
      const text = (blocks[0] as { text: string }).text;

      expect(text).toContain('electricity/retail-sales');
      expect(text).toContain('query: monthly');
      expect(text).toContain('TX=Texas (TX)');
      expect(text).toContain('sales');
      expect(text).toContain('MWh');
    });
  });
});
