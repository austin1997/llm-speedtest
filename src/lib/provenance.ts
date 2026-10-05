import type { Source } from './types';

// Labels live in the message catalogs; these helpers only choose the key.
export const sourceKey = (source: Source) => `source.${source}` as const;
export const quantityKey = (source: Source) => source === 'reported' || source === 'measured' ? 'quantity.actual' as const : `quantity.${source}` as const;
