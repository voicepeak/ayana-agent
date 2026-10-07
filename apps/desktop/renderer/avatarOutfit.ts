import type { AvatarCatalog } from './avatarCatalogs';
import { catalogFor } from './avatarCatalogs';

/** Outfit is a user variable; the sentence still owns its expression and pose. */
export function outfitAsset(assetId: string, costume: string, catalog: AvatarCatalog = catalogFor(null)): string {
  const assets = catalog.assets as Record<string, { costume: string; source_expression: string; pose: string; alias?: boolean }>;
  const source = assets[assetId];
  if (source?.costume === costume && assetId !== 'neutral') return assetId;
  const fallback = catalog.fallbacks?.default || '休闲';
  const label = source?.source_expression || fallback;
  const candidates = Object.entries(assets).filter(([, item]) => item.costume === costume && !item.alias);
  return candidates.find(([, item]) => item.source_expression === label && item.pose === (source?.pose || 'crossed'))?.[0]
    || candidates.find(([, item]) => item.source_expression === label)?.[0]
    || candidates.find(([, item]) => item.source_expression === fallback && item.pose === 'crossed')?.[0] || assetId;
}
