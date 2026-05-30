/**
 * @fileoverview Tests for the bridge-layer SQL system-catalog deny gate.
 * @module tests/services/sql-gate-extras.test
 */

import { describe, expect, it } from 'vitest';
import { assertNoSystemCatalogAccess } from '@/services/canvas-bridge/sql-gate-extras.js';

describe('assertNoSystemCatalogAccess', () => {
  describe('happy path — allowed SELECTs pass through', () => {
    it('allows a plain SELECT against a df_ table', () => {
      expect(() => assertNoSystemCatalogAccess('SELECT * FROM df_ABCDE_FGHIJ')).not.toThrow();
    });

    it('allows a SELECT with aggregation', () => {
      expect(() =>
        assertNoSystemCatalogAccess(
          'SELECT period, CAST(value AS DOUBLE) AS val FROM df_TEST GROUP BY period ORDER BY period',
        ),
      ).not.toThrow();
    });

    it('allows a SELECT with a JOIN across two df_ tables', () => {
      expect(() =>
        assertNoSystemCatalogAccess(
          'SELECT a.period, b.value FROM df_A JOIN df_B ON a.period = b.period',
        ),
      ).not.toThrow();
    });

    it('allows a CTE', () => {
      expect(() =>
        assertNoSystemCatalogAccess(
          'WITH cte AS (SELECT * FROM df_X) SELECT * FROM cte WHERE val > 0',
        ),
      ).not.toThrow();
    });
  });

  describe('blocked catalogs', () => {
    it('blocks information_schema', () => {
      expect(() =>
        assertNoSystemCatalogAccess('SELECT * FROM information_schema.tables'),
      ).toThrow();
    });

    it('blocks information_schema case-insensitively', () => {
      expect(() =>
        assertNoSystemCatalogAccess('SELECT * FROM INFORMATION_SCHEMA.COLUMNS'),
      ).toThrow();
    });

    it('blocks pg_catalog', () => {
      expect(() => assertNoSystemCatalogAccess('SELECT * FROM pg_catalog.pg_class')).toThrow();
    });

    it('blocks sqlite_master', () => {
      expect(() =>
        assertNoSystemCatalogAccess('SELECT * FROM sqlite_master WHERE type="table"'),
      ).toThrow();
    });

    it('blocks duckdb_tables', () => {
      expect(() => assertNoSystemCatalogAccess('SELECT * FROM duckdb_tables()')).toThrow();
    });

    it('blocks duckdb_columns', () => {
      expect(() =>
        assertNoSystemCatalogAccess('SELECT * FROM duckdb_columns WHERE table_name LIKE "df_%"'),
      ).toThrow();
    });

    it('throws ValidationError with system_catalog_access reason', () => {
      let thrown: unknown;
      try {
        assertNoSystemCatalogAccess('SELECT * FROM information_schema.tables');
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeDefined();
      expect((thrown as { data?: { reason?: string } }).data?.reason).toBe('system_catalog_access');
    });
  });

  describe('injection attempt: catalog name in string literal is allowed', () => {
    it('does not block catalog name inside a quoted string literal', () => {
      // A string literal containing "information_schema" should not be flagged.
      // The function strips string literals before checking.
      expect(() =>
        assertNoSystemCatalogAccess("SELECT 'information_schema' AS note FROM df_TEST"),
      ).not.toThrow();
    });

    it('does not block catalog name inside a double-quoted identifier used as alias', () => {
      expect(() =>
        assertNoSystemCatalogAccess('SELECT value AS "information_schema" FROM df_TEST'),
      ).not.toThrow();
    });
  });

  describe('edge cases', () => {
    it('blocks duckdb_ prefix with arbitrary suffix', () => {
      expect(() => assertNoSystemCatalogAccess('SELECT * FROM duckdb_schemas()')).toThrow();
    });

    it('allows a SELECT with no FROM clause', () => {
      expect(() => assertNoSystemCatalogAccess('SELECT 1 + 1')).not.toThrow();
    });

    it('allows empty-like SQL that is just a comment', () => {
      expect(() => assertNoSystemCatalogAccess('SELECT -- comment\n1')).not.toThrow();
    });
  });
});
