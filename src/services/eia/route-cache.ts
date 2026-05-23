/**
 * @fileoverview In-process route tree cache and Fuse.js fuzzy search index.
 * The route tree is fetched lazily on first use and held for the process
 * lifetime — EIA's taxonomy is stable between API releases and restarting the
 * server is the appropriate refresh mechanism. The Fuse.js index is built once
 * after the tree is populated and includes STEO series names so natural-language
 * queries resolve to specific seriesId values.
 * @module services/eia/route-cache
 */

import Fuse, { type IFuseOptions } from 'fuse.js';
import type { RawRouteNode, SearchIndexEntry } from './types.js';

/** Holds the in-process route tree state. */
interface CacheState {
  /** Sorted list of all index entries for total_indexed count. */
  entries: SearchIndexEntry[];
  /** Fuse.js index built over all routes + STEO series. */
  fuseIndex: Fuse<SearchIndexEntry>;
  /** Flat map of route path → raw node (all nodes in the tree). */
  nodeMap: Map<string, RawRouteNode>;
}

let _cache: CacheState | undefined;

/**
 * Normalize a description string from the EIA API. EIA descriptions often
 * contain embedded `\r\n` + leading whitespace (source-level line wrapping).
 * Collapse to a clean single-line string.
 */
export function normalizeDescription(desc: string | undefined): string {
  if (!desc) return '';
  return desc
    .replace(/\r/g, '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Walk the raw route tree and collect all nodes into a flat path→node map. */
export function buildNodeMap(
  nodes: RawRouteNode[],
  parentPath: string,
  map: Map<string, RawRouteNode>,
): void {
  for (const node of nodes) {
    const path = parentPath ? `${parentPath}/${node.id}` : node.id;
    // Normalize description in place so all tools that read from cache get clean strings
    const normalized: RawRouteNode =
      node.description !== undefined
        ? { ...node, description: normalizeDescription(node.description) }
        : node;
    map.set(path, normalized);
    if (normalized.routes?.length) {
      buildNodeMap(normalized.routes, path, map);
    }
  }
}

/**
 * Classify a raw node as a leaf. A node is a leaf when it has `frequency`,
 * `facets`, or `data` fields (queryable data endpoint) rather than a `routes`
 * array. Root-level nodes with no sub-routes and no data fields are treated as
 * leaves (e.g. steo).
 */
export function isLeafNode(node: RawRouteNode): boolean {
  if (node.frequency !== undefined) return true;
  if (node.facets !== undefined) return true;
  if (node.data !== undefined) return true;
  // A node with no routes array and no data/frequency is still a leaf candidate
  return !node.routes?.length;
}

/** Build search index entries from a flat node map. */
function buildEntries(nodeMap: Map<string, RawRouteNode>): SearchIndexEntry[] {
  const entries: SearchIndexEntry[] = [];
  for (const [route, node] of nodeMap) {
    const parts = route.split('/');
    const category: string | undefined = parts.length > 1 ? parts[0] : undefined;
    entries.push({
      route,
      name: node.name,
      description: node.description ?? '',
      isLeaf: isLeafNode(node),
      category,
    });
  }
  return entries;
}

const FUSE_OPTIONS: IFuseOptions<SearchIndexEntry> = {
  keys: [
    { name: 'name', weight: 2 },
    { name: 'description', weight: 1.5 },
    { name: 'route', weight: 1 },
    { name: 'category', weight: 0.5 },
  ],
  threshold: 0.4,
  includeScore: true,
  minMatchCharLength: 2,
};

/** Initialize the cache with the fetched route tree and optional STEO entries. */
export function initRouteCache(
  topLevelNodes: RawRouteNode[],
  steoSeriesEntries: SearchIndexEntry[],
): void {
  const nodeMap = new Map<string, RawRouteNode>();
  buildNodeMap(topLevelNodes, '', nodeMap);

  const routeEntries = buildEntries(nodeMap);
  const allEntries = [...routeEntries, ...steoSeriesEntries];

  _cache = {
    nodeMap,
    fuseIndex: new Fuse(allEntries, FUSE_OPTIONS),
    entries: allEntries,
  };
}

/** Return the cache, throwing if not yet initialized. */
export function getRouteCache(): CacheState {
  if (!_cache) throw new Error('Route cache not initialized');
  return _cache;
}

/** True when the cache has been populated. */
export function isRouteCacheReady(): boolean {
  return _cache !== undefined;
}

/** Reset the cache (used in tests). */
export function _resetRouteCache(): void {
  _cache = undefined;
}

/** Get a node by route path. Returns undefined when not found. */
export function getNode(path: string): RawRouteNode | undefined {
  if (!_cache) return;
  if (!path) {
    // Root — return a synthetic node with top-level children
    return;
  }
  return _cache.nodeMap.get(path);
}

/**
 * Get children of a given path. For root (empty path), returns top-level nodes.
 * Returns empty array when path has no children.
 */
export function getChildren(
  path: string,
): Array<{ id: string; route: string; node: RawRouteNode }> {
  if (!_cache) return [];
  const children: Array<{ id: string; route: string; node: RawRouteNode }> = [];

  if (!path) {
    // Root: find all nodes whose route has no '/' separator
    for (const [route, node] of _cache.nodeMap) {
      if (!route.includes('/')) {
        children.push({ id: node.id, route, node });
      }
    }
  } else {
    // Find all nodes whose route is exactly `${path}/${id}`
    const prefix = `${path}/`;
    for (const [route, node] of _cache.nodeMap) {
      if (route.startsWith(prefix) && !route.slice(prefix.length).includes('/')) {
        const id = route.slice(prefix.length);
        children.push({ id, route, node });
      }
    }
  }

  return children;
}

/** Fuzzy search across the index. Returns ranked matches. */
export function searchRoutes(
  query: string,
  limit: number,
): Array<{ entry: SearchIndexEntry; score: number }> {
  if (!_cache) return [];
  const results = _cache.fuseIndex.search(query, { limit });
  return results.map((r) => ({
    entry: r.item,
    score: r.score ?? 1,
  }));
}

/** Total number of indexed entries. */
export function getIndexSize(): number {
  return _cache?.entries.length ?? 0;
}

/** Add STEO series entries to an already-initialized cache. */
export function addSteoSeriesToIndex(steoEntries: SearchIndexEntry[]): void {
  if (!_cache) return;
  _cache.entries.push(...steoEntries);
  _cache.fuseIndex = new Fuse(_cache.entries, FUSE_OPTIONS);
}
