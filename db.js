import { PGlite } from '@electric-sql/pglite';

/** @type {Map<string, PGlite>} */
const dbCache = new Map();

export function getDb(dataDir) {
    if (!dbCache.has(dataDir)) {
        dbCache.set(dataDir, new PGlite(dataDir));
    }
    return dbCache.get(dataDir);
}
