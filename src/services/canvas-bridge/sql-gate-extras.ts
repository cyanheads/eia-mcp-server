/**
 * @fileoverview Bridge-layer SQL gate additions on top of the framework's
 * read-only gate. Additionally denies access to DuckDB system catalogs
 * (information_schema, pg_catalog, sqlite_master, duckdb_*) so callers cannot
 * enumerate df_<id> handles they don't already hold.
 * @module services/canvas-bridge/sql-gate-extras
 */

import { validationError } from '@cyanheads/mcp-ts-core/errors';

const FORBIDDEN_CATALOG_PATTERNS: ReadonlyArray<RegExp> = [
  /\binformation_schema\b/i,
  /\bpg_catalog\b/i,
  /\bsqlite_master\b/i,
  /\bduckdb_[a-z_]+\b/i,
];

function stripStringLiterals(sql: string): string {
  return sql.replace(/'([^'\\]|\\.|'')*'/g, "''").replace(/"([^"\\]|\\.|"")*"/g, '""');
}

/**
 * Reject SELECTs referencing DuckDB system catalogs. Throws ValidationError
 * with data.reason = 'system_catalog_access'.
 */
export function assertNoSystemCatalogAccess(sql: string): void {
  const stripped = stripStringLiterals(sql);
  for (const pattern of FORBIDDEN_CATALOG_PATTERNS) {
    const match = stripped.match(pattern);
    if (match) {
      throw validationError(`SQL references a denied system catalog: ${match[0]}.`, {
        reason: 'system_catalog_access',
        catalog: match[0],
        recovery: {
          hint: 'Query only df_<id> tables. Use eia_dataframe_describe to list available dataframes.',
        },
      });
    }
  }
}
