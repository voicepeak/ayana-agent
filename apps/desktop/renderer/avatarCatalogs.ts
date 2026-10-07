import registry from '../../../characters/registry.json';
import ayana from '../../../characters/ayana/avatar-map.json';
import ayanaSu from '../../../characters/ayana-su/avatar-map.json';

export interface AvatarAsset {
  file: string; source_expression: string; pose: string; costume: string;
  width: number; height: number; alias?: boolean;
}
export interface AvatarCatalog {
  default_asset_id: string;
  intent_defaults: Record<string, string>;
  assets: Record<string, AvatarAsset>;
  fallbacks?: { affect?: Record<string, string>; intent?: Record<string, string>; default?: string };
  transition?: Record<string, unknown>;
}
export interface CharacterOption { id: string; name: string; ready?: boolean }

export const catalogs: Record<string, AvatarCatalog> = { ayana, 'ayana-su': ayanaSu };
export const characterRegistry = registry;

export function catalogFor(character: unknown): AvatarCatalog {
  return catalogs[String(character || registry.default)] || catalogs[registry.default] || ayana;
}

export function activeCatalog(settings: Record<string, unknown>): AvatarCatalog {
  return catalogFor(settings.character);
}

export function characterOptions(): CharacterOption[] {
  return Object.entries(registry.characters).map(([id, item]) => ({ id, name: item.name }));
}

export function costumesOf(catalog: AvatarCatalog): string[] {
  return [...new Set(Object.values(catalog.assets).map(item => item.costume))];
}

export function characterAspect(catalog: AvatarCatalog): number {
  return Math.max(...Object.values(catalog.assets).map(asset => asset.width / asset.height));
}
