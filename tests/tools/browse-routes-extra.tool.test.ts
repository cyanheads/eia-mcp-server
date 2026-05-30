/**
 * @fileoverview Additional coverage for eia_browse_routes — format for
 * non-empty leaf path, empty children on leaf, unicode path, and
 * description rendering in format output.
 * @module tests/tools/browse-routes-extra.tool.test
 */

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

describe('browseRoutesTool — additional coverage', () => {
  beforeEach(() => {
    vi.mocked(eiaService.getEiaApiService).mockReturnValue({
      browse: mockBrowse,
    } as unknown as ReturnType<typeof eiaService.getEiaApiService>);
    mockBrowse.mockReset();
  });

  // ------------------------------------------------------------------
  // Handlers with non-leaf path having mix of leaf/cat children
  // ------------------------------------------------------------------

  it('passes path through to service correctly', async () => {
    mockBrowse.mockResolvedValue({
      path: 'electricity',
      children: [],
      isLeaf: false,
    });

    const ctx = createMockContext({ errors: browseRoutesTool.errors });
    const input = browseRoutesTool.input.parse({ path: 'electricity' });
    await browseRoutesTool.handler(input, ctx);

    expect(mockBrowse).toHaveBeenCalledWith('electricity', ctx);
  });

  it('passes undefined to service when path is omitted', async () => {
    mockBrowse.mockResolvedValue({
      path: '',
      children: [],
      isLeaf: false,
    });

    const ctx = createMockContext({ errors: browseRoutesTool.errors });
    const input = browseRoutesTool.input.parse({});
    await browseRoutesTool.handler(input, ctx);

    expect(mockBrowse).toHaveBeenCalledWith(undefined, ctx);
  });

  // ------------------------------------------------------------------
  // Edge case: path with spaces / unusual chars forwarded to service
  // ------------------------------------------------------------------

  it('forwards a path with unusual characters to service', async () => {
    const { notFound } = await import('@cyanheads/mcp-ts-core/errors');
    mockBrowse.mockRejectedValue(notFound('Not found', { reason: 'route_not_found' }));

    const ctx = createMockContext({ errors: browseRoutesTool.errors });
    const input = browseRoutesTool.input.parse({ path: 'invalid path with spaces' });

    await expect(browseRoutesTool.handler(input, ctx)).rejects.toBeDefined();
    expect(mockBrowse).toHaveBeenCalledWith('invalid path with spaces', ctx);
  });

  // ------------------------------------------------------------------
  // format() — category root label
  // ------------------------------------------------------------------

  describe('format()', () => {
    it('renders root label when path is empty', () => {
      const result = {
        path: '',
        children: [
          {
            id: 'electricity',
            name: 'Electricity',
            description: 'Electric power',
            route: 'electricity',
            isLeaf: false,
          },
        ],
        isLeaf: false,
      };
      const blocks = browseRoutesTool.format!(result);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('root');
    });

    it('renders path name in children header when non-empty', () => {
      const result = {
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
      };
      const blocks = browseRoutesTool.format!(result);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('electricity');
    });

    it('renders empty-children state without crashing', () => {
      const result = {
        path: 'electricity',
        children: [],
        isLeaf: false,
      };
      const blocks = browseRoutesTool.format!(result);
      expect(blocks).toBeDefined();
      expect(blocks[0]?.type).toBe('text');
    });

    it('renders [leaf] for leaf children and [cat] for category children', () => {
      const result = {
        path: 'petroleum',
        children: [
          {
            id: 'pri',
            name: 'Prices',
            description: 'Prices',
            route: 'petroleum/pri',
            isLeaf: false,
          },
          {
            id: 'import',
            name: 'Imports',
            description: 'Imports',
            route: 'petroleum/import',
            isLeaf: true,
          },
        ],
        isLeaf: false,
      };
      const blocks = browseRoutesTool.format!(result);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('[leaf]');
      expect(text).toContain('[cat]');
    });
  });
});
