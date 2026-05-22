/**
 * @fileoverview Tests for the eia_search_routes tool.
 * @module tests/tools/search-routes.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { searchRoutesTool } from '@/mcp-server/tools/definitions/search-routes.tool.js';
import * as eiaService from '@/services/eia/eia-service.js';

vi.mock('@/services/eia/eia-service.js', () => ({
  getEiaApiService: vi.fn(),
  initEiaApiService: vi.fn(),
  _resetEiaApiService: vi.fn(),
}));

const mockSearch = vi.fn();

describe('searchRoutesTool', () => {
  beforeEach(() => {
    vi.mocked(eiaService.getEiaApiService).mockReturnValue({
      search: mockSearch,
    } as unknown as ReturnType<typeof eiaService.getEiaApiService>);
    mockSearch.mockReset();
  });

  it('returns ranked results with scores', async () => {
    mockSearch.mockResolvedValue({
      results: [
        {
          entry: {
            route: 'electricity/retail-sales',
            name: 'Retail Sales',
            description: 'Sales by state',
            isLeaf: true,
            category: 'electricity',
          },
          score: 0.05,
        },
        {
          entry: {
            route: 'electricity',
            name: 'Electricity',
            description: 'Electric power',
            isLeaf: false,
            category: undefined,
          },
          score: 0.3,
        },
      ],
      totalIndexed: 150,
    });

    const ctx = createMockContext();
    const input = searchRoutesTool.input.parse({ query: 'retail electricity' });
    const result = await searchRoutesTool.handler(input, ctx);

    expect(result.results).toHaveLength(2);
    expect(result.results[0]?.route).toBe('electricity/retail-sales');
    expect(result.results[0]?.score).toBe(0.05);
    expect(result.results[0]?.isLeaf).toBe(true);
    expect(result.total_indexed).toBe(150);
  });

  it('returns empty results on no match', async () => {
    mockSearch.mockResolvedValue({ results: [], totalIndexed: 150 });

    const ctx = createMockContext();
    const input = searchRoutesTool.input.parse({ query: 'zzznomatch' });
    const result = await searchRoutesTool.handler(input, ctx);

    expect(result.results).toHaveLength(0);
    expect(result.total_indexed).toBe(150);
  });

  it('respects limit parameter', async () => {
    mockSearch.mockResolvedValue({ results: [], totalIndexed: 0 });

    const ctx = createMockContext();
    const input = searchRoutesTool.input.parse({ query: 'energy', limit: 5 });
    await searchRoutesTool.handler(input, ctx);

    expect(mockSearch).toHaveBeenCalledWith('energy', 5, ctx);
  });

  it('uses default limit of 10', async () => {
    mockSearch.mockResolvedValue({ results: [], totalIndexed: 0 });

    const ctx = createMockContext();
    const input = searchRoutesTool.input.parse({ query: 'energy' });
    await searchRoutesTool.handler(input, ctx);

    expect(mockSearch).toHaveBeenCalledWith('energy', 10, ctx);
  });

  describe('format()', () => {
    it('renders results with score and isLeaf tag', () => {
      const result = {
        results: [
          {
            route: 'petroleum/pri/gnd',
            name: 'Gasoline Prices',
            description: 'Weekly prices',
            score: 0.12,
            isLeaf: true,
          },
        ],
        total_indexed: 200,
      };
      const blocks = searchRoutesTool.format!(result);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('[leaf]');
      expect(text).toContain('petroleum/pri/gnd');
      expect(text).toContain('0.120');
      expect(text).toContain('200');
    });

    it('renders no-results message', () => {
      const result = { results: [], total_indexed: 100 };
      const blocks = searchRoutesTool.format!(result);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('No matching routes');
      expect(text).toContain('100');
    });
  });
});
