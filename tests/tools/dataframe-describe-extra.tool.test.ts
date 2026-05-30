/**
 * @fileoverview Additional coverage for eia_dataframe_describe — name filter,
 * max_rows omitted case, and format rendering with truncation detail.
 * @module tests/tools/dataframe-describe-extra.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import * as canvasBridge from '@/services/canvas-bridge/canvas-bridge.js';

vi.mock('@/services/canvas-bridge/canvas-bridge.js', () => ({
  getCanvasBridge: vi.fn(),
  initCanvasBridge: vi.fn(),
  _resetCanvasBridge: vi.fn(),
}));

const mockDescribe = vi.fn();

describe('dataframeDescribeTool — additional coverage', () => {
  beforeEach(() => {
    vi.mocked(canvasBridge.getCanvasBridge).mockReturnValue({
      describe: mockDescribe,
    } as unknown as ReturnType<typeof canvasBridge.getCanvasBridge>);
    mockDescribe.mockReset();
  });

  // ------------------------------------------------------------------
  // name filter parameter forwarded to bridge
  // ------------------------------------------------------------------

  it('passes name to bridge.describe when name is supplied', async () => {
    mockDescribe.mockResolvedValue([]);

    const ctx = createMockContext({ errors: dataframeDescribeTool.errors, tenantId: 'test' });
    const input = dataframeDescribeTool.input.parse({ name: 'df_TEST' });
    await dataframeDescribeTool.handler(input, ctx);

    expect(mockDescribe).toHaveBeenCalledWith(ctx, 'df_TEST');
  });

  it('passes undefined to bridge.describe when name is omitted', async () => {
    mockDescribe.mockResolvedValue([]);

    const ctx = createMockContext({ errors: dataframeDescribeTool.errors, tenantId: 'test' });
    const input = dataframeDescribeTool.input.parse({});
    await dataframeDescribeTool.handler(input, ctx);

    expect(mockDescribe).toHaveBeenCalledWith(ctx, undefined);
  });

  // ------------------------------------------------------------------
  // max_rows omitted (undefined) — nullable field
  // ------------------------------------------------------------------

  it('maps max_rows as undefined when not in metadata', async () => {
    const now = new Date().toISOString();
    mockDescribe.mockResolvedValue([
      {
        tableName: 'df_NO_MAX',
        sourceTool: 'eia_query_route',
        queryParams: { route: 'steo' },
        createdAt: now,
        expiresAt: now,
        rowCount: 10,
        truncated: false,
        maxRows: undefined,
        columnSchema: [],
      },
    ]);

    const ctx = createMockContext({ errors: dataframeDescribeTool.errors, tenantId: 'test' });
    const input = dataframeDescribeTool.input.parse({});
    const result = await dataframeDescribeTool.handler(input, ctx);

    expect(result.dataframes[0]?.max_rows).toBeUndefined();
  });

  // ------------------------------------------------------------------
  // format() — truncated with max_rows vs without
  // ------------------------------------------------------------------

  describe('format()', () => {
    it('renders truncated with max_rows value when provided', () => {
      const now = new Date().toISOString();
      const result = {
        dataframes: [
          {
            name: 'df_TRUNC',
            source_tool: 'eia_query_route',
            query_params: { route: 'electricity/retail-sales' },
            created_at: now,
            expires_at: now,
            row_count: 240,
            truncated: true,
            max_rows: 100,
            column_schema: [{ name: 'period', type: 'VARCHAR', nullable: true }],
          },
        ],
      };
      const blocks = dataframeDescribeTool.format!(result);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('truncated at 100');
    });

    it('renders truncated without max_rows when max_rows is absent', () => {
      const now = new Date().toISOString();
      const result = {
        dataframes: [
          {
            name: 'df_TRUNC2',
            source_tool: 'eia_query_route',
            query_params: {},
            created_at: now,
            expires_at: now,
            row_count: 50,
            truncated: true,
            column_schema: [],
          },
        ],
      };
      const blocks = dataframeDescribeTool.format!(result);
      const text = (blocks[0] as { text: string }).text;
      // "truncated" without a number
      expect(text).toContain('truncated');
      expect(text).not.toContain('truncated at');
    });

    it('renders multiple dataframes correctly', () => {
      const now = new Date().toISOString();
      const result = {
        dataframes: [
          {
            name: 'df_FIRST',
            source_tool: 'eia_query_route',
            query_params: { route: 'steo' },
            created_at: now,
            expires_at: now,
            row_count: 10,
            truncated: false,
            column_schema: [],
          },
          {
            name: 'df_SECOND',
            source_tool: 'eia_query_route',
            query_params: { route: 'electricity/retail-sales' },
            created_at: now,
            expires_at: now,
            row_count: 20,
            truncated: false,
            column_schema: [],
          },
        ],
      };
      const blocks = dataframeDescribeTool.format!(result);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('2 active dataframe(s)');
      expect(text).toContain('df_FIRST');
      expect(text).toContain('df_SECOND');
    });
  });
});
