import catalog from '../../../characters/ayana/avatar-map.json';

/** Outfit is a user variable; the sentence still owns its expression and pose. */
export function outfitAsset(assetId: string, costume: string): string {
  const assets = catalog.assets as Record<string, { costume: string; source_expression: string; pose: string }>;
  const source = assets[assetId];
  if (source?.costume === costume && assetId !== 'neutral') return assetId;
  const label = source?.source_expression || ({ explain: '正经', encourage: '卖萌', caution: '担忧', playful: '得意' } as Record<string, string>)[assetId] || '休闲';
  const candidates = Object.entries(assets).filter(([, item]) => item.costume === costume);
  return candidates.find(([, item]) => item.source_expression === label && item.pose === (source?.pose || 'crossed'))?.[0]
    || candidates.find(([, item]) => item.source_expression === label)?.[0]
    || candidates.find(([, item]) => item.source_expression === '休闲' && item.pose === 'crossed')?.[0] || assetId;
}
