/**
 * @fileoverview Tests for the eia_dataframe_query tool.
 * @module tests/tools/dataframe-query.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import * as canvasBridge from '@/services/canvas-bridge/canvas-bridge.js';

vi.mock('@/services/canvas-bridge/canvas-bridge.js', () => ({
  getCanvasBridge: vi.fn(),
  initCanvasBridge: vi.fn(),
  _resetCanvasBridge: vi.fn(),
}));

const mockQuery = vi.fn();

describe('dataframeQueryTool', () => {
  beforeEach(() => {
    vi.mocked(canvasBridge.getCanvasBridge).mockReturnValue({
      query: mockQuery,
    } as unknown as ReturnType<typeof canvasBridge.getCanvasBridge>);
    mockQuery.mockReset();
  });

  it('throws canvas_unavailable when bridge is absent', async () => {
    vi.mocked(canvasBridge.getCanvasBridge).mockReturnValue(undefined);

    const ctx = createMockContext({ errors: dataframeQueryTool.errors, tenantId: 'test' });
    const input = dataframeQueryTool.input.parse({ sql: 'SELECT * FROM df_TEST' });

    await expect(dataframeQueryTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'canvas_unavailable' },
    });
  });

  it('executes SQL and returns results', async () => {
    mockQuery.mockResolvedValue({
      result: {
        columns: ['period', 'value'],
        rows: [{ period: '2024-01', value: '9.13' }],
        rowCount: 1,
        tableName: undefined,
      },
    });

    const ctx = createMockContext({ errors: dataframeQueryTool.errors, tenantId: 'test' });
    const input = dataframeQueryTool.input.parse({ sql: 'SELECT period, value FROM df_TEST' });
    const result = await dataframeQueryTool.handler(input, ctx);

    expect(result.columns).toEqual(['period', 'value']);
    expect(result.rows).toHaveLength(1);
    expect(result.row_count).toBe(1);
    expect(result.registered_as).toBeUndefined();
  });

  it('returns registered_as when register_as is supplied', async () => {
    const now = new Date().toISOString();
    mockQuery.mockResolvedValue({
      result: {
        columns: ['period', 'total'],
        rows: [{ period: '2024', total: '100.5' }],
        rowCount: 1,
        tableName: 'df_RESULT',
      },
      meta: {
        tableName: 'df_RESULT',
        expiresAt: now,
        sourceTool: 'eia_dataframe_query',
        queryParams: { sql: 'SELECT ...' },
        createdAt: now,
        rowCount: 1,
        truncated: false,
        maxRows: undefined,
        columnSchema: [],
      },
    });

    const ctx = createMockContext({ errors: dataframeQueryTool.errors, tenantId: 'test' });
    const input = dataframeQueryTool.input.parse({
      sql: 'SELECT period, SUM(CAST(value AS DOUBLE)) AS total FROM df_TEST GROUP BY period',
      register_as: 'df_RESULT',
    });
    const result = await dataframeQueryTool.handler(input, ctx);

    expect(result.registered_as).toBe('df_RESULT');
    expect(result.expires_at).toBe(now);
  });

  describe('format()', () => {
    it('renders table markdown', () => {
      const result = {
        columns: ['period', 'value'],
        row_count: 2,
        rows: [
          { period: '2024-01', value: '9.13' },
          { period: '2024-02', value: '8.45' },
        ],
      };
      const blocks = dataframeQueryTool.format!(result);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('| period | value |');
      expect(text).toContain('9.13');
      expect(text).toContain('8.45');
    });

    it('renders no-rows state', () => {
      const result = { columns: ['period'], row_count: 0, rows: [] };
      const blocks = dataframeQueryTool.format!(result);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('0 rows');
    });

    it('shows register info when registered_as present', () => {
      const result = {
        columns: ['val'],
        row_count: 5,
        rows: [{ val: '1' }],
        registered_as: 'df_OUT',
        expires_at: '2026-01-01T00:00:00Z',
      };
      const blocks = dataframeQueryTool.format!(result);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('df_OUT');
    });
  });
});
