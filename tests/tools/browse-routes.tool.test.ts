/**
 * @fileoverview Tests for the eia_browse_routes tool.
 * @module tests/tools/browse-routes.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browseRoutesTool } from '@/mcp-server/tools/definitions/browse-routes.tool.js';
import * as eiaService from '@/services/eia/eia-service.js';

vi.mock('@/services/eia/eia-service.js', () => ({
  getEiaApiService: vi.fn(),
  initEiaApiService: vi.fn(),
  _resetEiaApiService: vi.fn(),
}));

const mockBrowse = vi.fn();

describe('browseRoutesTool', () => {
  beforeEach(() => {
    vi.mocked(eiaService.getEiaApiService).mockReturnValue({
      browse: mockBrowse,
    } as unknown as ReturnType<typeof eiaService.getEiaApiService>);
    mockBrowse.mockReset();
  });

  it('returns root categories when no path provided', async () => {
    mockBrowse.mockResolvedValue({
      path: '',
      children: [
        {
          id: 'electricity',
          name: 'Electricity',
          description: 'Electric power',
          route: 'electricity',
          isLeaf: false,
        },
        {
          id: 'petroleum',
          name: 'Petroleum',
          description: 'Oil and gas',
          route: 'petroleum',
          isLeaf: false,
        },
      ],
      isLeaf: false,
    });

    const ctx = createMockContext({ errors: browseRoutesTool.errors });
    const input = browseRoutesTool.input.parse({});
    const result = await browseRoutesTool.handler(input, ctx);

    expect(result.path).toBe('');
    expect(result.children).toHaveLength(2);
    expect(result.isLeaf).toBe(false);
    expect(mockBrowse).toHaveBeenCalledWith(undefined, ctx);
  });

  it('returns children for a given path', async () => {
    mockBrowse.mockResolvedValue({
      path: 'electricity',
      children: [
        {
          id: 'retail-sales',
          name: 'Retail Sales',
          description: 'Sales by state',
          route: 'electricity/retail-sales',
          isLeaf: true,
        },
      ],
      isLeaf: false,
    });

    const ctx = createMockContext({ errors: browseRoutesTool.errors });
    const input = browseRoutesTool.input.parse({ path: 'electricity' });
    const result = await browseRoutesTool.handler(input, ctx);

    expect(result.path).toBe('electricity');
    expect(result.children[0]?.isLeaf).toBe(true);
    expect(result.children[0]?.route).toBe('electricity/retail-sales');
  });

  it('returns isLeaf=true for leaf path', async () => {
    mockBrowse.mockResolvedValue({
      path: 'electricity/retail-sales',
      children: [],
      isLeaf: true,
    });

    const ctx = createMockContext({ errors: browseRoutesTool.errors });
    const input = browseRoutesTool.input.parse({ path: 'electricity/retail-sales' });
    const result = await browseRoutesTool.handler(input, ctx);

    expect(result.isLeaf).toBe(true);
    expect(result.children).toHaveLength(0);
  });

  it('propagates route_not_found from service', async () => {
    const { notFound } = await import('@cyanheads/mcp-ts-core/errors');
    mockBrowse.mockRejectedValue(
      notFound('Route "bad-path" not found', { reason: 'route_not_found' }),
    );

    const ctx = createMockContext({ errors: browseRoutesTool.errors });
    const input = browseRoutesTool.input.parse({ path: 'bad-path' });

    await expect(browseRoutesTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  describe('format()', () => {
    it('renders children with id, name, description, route', () => {
      const result = {
        path: 'electricity',
        children: [
          {
            id: 'retail-sales',
            name: 'Retail Sales',
            description: 'Sales data',
            route: 'electricity/retail-sales',
            isLeaf: true,
          },
        ],
        isLeaf: false,
      };
      const blocks = browseRoutesTool.format!(result);
      expect(blocks[0]?.type).toBe('text');
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('retail-sales');
      expect(text).toContain('Retail Sales');
      expect(text).toContain('Sales data');
      expect(text).toContain('electricity/retail-sales');
    });

    it('renders leaf note when path is leaf with no children', () => {
      const result = {
        path: 'electricity/retail-sales',
        children: [],
        isLeaf: true,
      };
      const blocks = browseRoutesTool.format!(result);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('eia_describe_route');
    });
  });
});
