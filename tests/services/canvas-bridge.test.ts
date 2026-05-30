/**
 * @fileoverview Tests for the canvas-bridge service — deriveAllNullableSchema
 * and CanvasBridge register/describe/query/drop behaviour.
 * @module tests/services/canvas-bridge.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { CanvasBridge, deriveAllNullableSchema } from '@/services/canvas-bridge/canvas-bridge.js';

// ---------------------------------------------------------------------------
// deriveAllNullableSchema — pure logic
// ---------------------------------------------------------------------------

describe('deriveAllNullableSchema', () => {
  it('marks all columns nullable=true', () => {
    const rows = [
      { period: '2024-01', value: '9.13', stateid: 'TX' },
      { period: '2024-02', value: '8.45', stateid: 'CA' },
    ];
    const schema = deriveAllNullableSchema(rows);
    expect(schema.length).toBeGreaterThan(0);
    for (const col of schema) {
      expect(col.nullable).toBe(true);
    }
  });

  it('returns schema with expected column names from sample rows', () => {
    const rows = [{ period: '2024-01', value: '100' }];
    const schema = deriveAllNullableSchema(rows);
    const names = schema.map((c) => c.name);
    expect(names).toContain('period');
    expect(names).toContain('value');
  });

  it('throws on empty rows array (framework requirement)', () => {
    // inferSchemaFromRows requires at least one row — empty input is a caller error.
    expect(() => deriveAllNullableSchema([])).toThrow();
  });

  it('handles rows with null values (sparse EIA columns)', () => {
    const rows = [
      { period: '2024-01', value: null, 'value-units': null },
      { period: '2024-02', value: '8.0', 'value-units': 'MMBtu' },
    ];
    const schema = deriveAllNullableSchema(rows as unknown as Record<string, unknown>[]);
    expect(schema.length).toBeGreaterThan(0);
    for (const col of schema) {
      expect(col.nullable).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// CanvasBridge — behavior tests using a mock DataCanvas
// ---------------------------------------------------------------------------

function makeMockCanvas() {
  const mockInstance = {
    canvasId: 'canvas-001',
    registerTable: vi.fn(),
    query: vi.fn(),
    drop: vi.fn(),
  };
  const mockCanvas = {
    acquire: vi.fn().mockResolvedValue(mockInstance),
  };
  return { mockCanvas, mockInstance };
}

describe('CanvasBridge', () => {
  describe('registerDataframe', () => {
    it('returns undefined and skips when rows are empty', async () => {
      const { mockCanvas } = makeMockCanvas();
      const bridge = new CanvasBridge(mockCanvas as never);
      const ctx = createMockContext({ tenantId: 'test' });

      const result = await bridge.registerDataframe(ctx, {
        rows: [],
        sourceTool: 'eia_query_route',
        queryParams: { route: 'steo' },
      });

      expect(result).toBeUndefined();
      expect(mockCanvas.acquire).not.toHaveBeenCalled();
    });

    it('registers a table and returns metadata with correct shape', async () => {
      const { mockCanvas, mockInstance } = makeMockCanvas();
      mockInstance.registerTable.mockResolvedValue({
        tableName: 'df_ABCDE_FGHIJ',
        rowCount: 2,
      });
      const bridge = new CanvasBridge(mockCanvas as never);
      const ctx = createMockContext({ tenantId: 'test' });

      const result = await bridge.registerDataframe(ctx, {
        rows: [
          { period: '2024-01', value: '9.13' },
          { period: '2024-02', value: '8.45' },
        ],
        sourceTool: 'eia_query_route',
        queryParams: { route: 'electricity/retail-sales' },
        truncated: false,
      });

      expect(result).toBeDefined();
      expect(result?.tableName).toBe('df_ABCDE_FGHIJ');
      expect(result?.rowCount).toBe(2);
      expect(result?.expiresAt).toBeDefined();
      expect(result?.columnSchema).toBeDefined();
    });

    it('returns undefined when canvas throws (best-effort)', async () => {
      const { mockCanvas, mockInstance } = makeMockCanvas();
      mockInstance.registerTable.mockRejectedValue(new Error('DuckDB error'));
      const bridge = new CanvasBridge(mockCanvas as never);
      const ctx = createMockContext({ tenantId: 'test' });

      const result = await bridge.registerDataframe(ctx, {
        rows: [{ period: '2024-01', value: '9.13' }],
        sourceTool: 'eia_query_route',
        queryParams: { route: 'steo' },
      });

      expect(result).toBeUndefined();
    });
  });

  describe('describe', () => {
    it('returns empty array when no dataframes are registered', async () => {
      const { mockCanvas } = makeMockCanvas();
      const bridge = new CanvasBridge(mockCanvas as never);
      const ctx = createMockContext({ tenantId: 'test' });

      const result = await bridge.describe(ctx);
      expect(result).toEqual([]);
    });

    it('returns metadata for a named table stored in state', async () => {
      const { mockCanvas } = makeMockCanvas();
      const bridge = new CanvasBridge(mockCanvas as never);
      const ctx = createMockContext({ tenantId: 'test' });

      const now = new Date().toISOString();
      const meta = {
        tableName: 'df_TEST',
        sourceTool: 'eia_query_route',
        queryParams: { route: 'steo' },
        createdAt: now,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        rowCount: 5,
        truncated: false,
        maxRows: undefined,
        columnSchema: [{ name: 'value', type: 'VARCHAR', nullable: true }],
      };
      await ctx.state.set('eia-df-meta/df_TEST', meta);

      const result = await bridge.describe(ctx, 'df_TEST');
      expect(result).toHaveLength(1);
      expect(result[0]?.tableName).toBe('df_TEST');
    });
  });

  describe('drop', () => {
    it('returns true when canvas drop succeeds', async () => {
      const { mockCanvas, mockInstance } = makeMockCanvas();
      mockInstance.drop.mockResolvedValue(true);
      const bridge = new CanvasBridge(mockCanvas as never);
      const ctx = createMockContext({ tenantId: 'test' });

      const result = await bridge.drop(ctx, 'df_ABCDE_FGHIJ');
      expect(result).toBe(true);
    });

    it('returns false when canvas drop returns false and no state meta exists', async () => {
      const { mockCanvas, mockInstance } = makeMockCanvas();
      mockInstance.drop.mockResolvedValue(false);
      const bridge = new CanvasBridge(mockCanvas as never);
      const ctx = createMockContext({ tenantId: 'test' });

      const result = await bridge.drop(ctx, 'df_MISSING');
      expect(result).toBe(false);
    });

    it('returns true when state had meta even if canvas drop returns false', async () => {
      const { mockCanvas, mockInstance } = makeMockCanvas();
      mockInstance.drop.mockResolvedValue(false);
      const bridge = new CanvasBridge(mockCanvas as never);
      const ctx = createMockContext({ tenantId: 'test' });

      const now = new Date().toISOString();
      await ctx.state.set('eia-df-meta/df_HAS_META', {
        tableName: 'df_HAS_META',
        sourceTool: 'eia_query_route',
        queryParams: {},
        createdAt: now,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        rowCount: 10,
        truncated: false,
        maxRows: undefined,
        columnSchema: [],
      });

      const result = await bridge.drop(ctx, 'df_HAS_META');
      expect(result).toBe(true);
    });
  });
});
