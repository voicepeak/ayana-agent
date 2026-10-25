import catalogs from './generated/characters.json';
import type { Bootstrap, PublicSettings, RuntimeEvent } from './types';

type Asset = { file: string; source_expression: string; pose: string; costume?: string; alias?: boolean };
type Catalog = { name: string; persona: string; style: string; guide: unknown;
  mapping: { assets: Record<string, Asset>; default_asset_id: string; intent_defaults: Record<string, string>;
    fallbacks?: { affect?: Record<string, string>; intent?: Record<string, string>; default?: string } } };
const characters = catalogs as unknown as Record<string, Catalog>;
export const defaultSettings: PublicSettings = { character: 'ayana', avatar_costume: '校服', volume: 1,
  companion_ui: { theme: 'ink', primary_language: 'ja', translation_language: 'zh', caption_defaults_version: 2 } };
export let settings: PublicSettings = structuredClone(defaultSettings);
let sinceOpen = 2;
export function resetCharacterSettings() { settings = structuredClone(defaultSettings); sinceOpen = 2; }
export function setCharacterSettings(value: PublicSettings) {
  settings = { ...settings, ...value,
    companion_ui: { ...settings.companion_ui, ...value.companion_ui },
    voice: { ...settings.voice, ...value.voice } };
  // Mobile currently exposes only the black-uniform Ayana, including old saves.
  settings.character = 'ayana';
  if (!costumes().includes(String(settings.avatar_costume))) settings.avatar_costume = costumes()[0];
  const volume = Number(settings.volume);
  settings.volume = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1;
}
function catalog() { return characters[String(settings.character)] || characters.ayana; }
export function characterOptions() { return [{ id: 'ayana', name: characters.ayana.name }]; }
export function costumes() { return [...new Set(Object.values(catalog().mapping.assets).map(a => a.costume || '校服'))]; }
export function defaultAsset() {
  const preferred = catalog().mapping.assets[catalog().mapping.default_asset_id];
  if (preferred && preferred.costume === settings.avatar_costume) return catalog().mapping.default_asset_id;
  return Object.entries(catalog().mapping.assets).find(([, a]) => !a.alias && a.costume === settings.avatar_costume && a.pose === 'crossed')?.[0]
    || catalog().mapping.default_asset_id;
}
export function assetUrl(id: string) {
  const asset = catalog().mapping.assets[id] || catalog().mapping.assets[defaultAsset()];
  return new URL(asset.file, document.baseURI).href;
}
export function resolveExpression(event: RuntimeEvent, random = Math.random) {
  const mapping = catalog().mapping;
  const nativeAsset = mapping.assets[String(event.native_asset_id || '')];
  if (nativeAsset && nativeAsset.costume === settings.avatar_costume) {
    return { ...event, asset_id: String(event.native_asset_id), resolved_expression: nativeAsset.source_expression, resolved_pose: nativeAsset.pose };
  }
  const exact = mapping.assets[String(event.expression || '')];
  let label = exact?.source_expression || String(event.expression || '');
  const candidates = Object.entries(mapping.assets).filter(([, a]) => !a.alias && a.costume === settings.avatar_costume);
  if (!candidates.length) return { ...event, asset_id: defaultAsset() };
  const labels = new Set(candidates.map(([, a]) => a.source_expression));
  if (!labels.has(label)) label = mapping.fallbacks?.affect?.[String(event.affect)]
    || mapping.fallbacks?.intent?.[String(event.intent)] || mapping.fallbacks?.default || candidates[0][1].source_expression;
  const pose = event.pose === 'open' && sinceOpen >= 2 && random() < .35 ? 'open' : 'crossed';
  const matches = candidates.filter(([, a]) => a.source_expression === label);
  const selected = matches.find(([, a]) => a.pose === pose) || matches[0] || candidates[0];
  sinceOpen = selected[1].pose === 'open' ? 0 : sinceOpen + 1;
  return { ...event, asset_id: selected[0], resolved_expression: selected[1].source_expression, resolved_pose: selected[1].pose };
}
export function characterBootstrap(): Bootstrap {
  return { version: '0.2.0', protocol_version: 1, settings, tts: {}, avatar_character: String(settings.character),
    avatar_costume: String(settings.avatar_costume), default_asset_id: defaultAsset() };
}
export function prompt(memory: string[], recent: unknown[]) {
  const value = catalog();
  return `${value.persona}\n${value.style}\n你不能观察或控制电脑。只根据用户消息与真实上下文聊天。\n`
    + 'Return only NDJSON objects. Emit one complete Japanese sentence per speech, then its faithful Chinese translation. '
    + 'Speech: {"type":"speech","key":"s1","speech_ja":"こんにちは。","intent":"acknowledge","affect":"neutral","intensity":0.25,"expression":"表情目录中的原名","pose":"crossed"}. '
    + 'Each speech must be 1–48 characters with Japanese kana, ending in sentence punctuation. No code or URLs in speech. '
    + 'Start with a concise, meaningful first sentence (about 8–18 Japanese characters) when natural, then continue the substance in later complete sentences. Do not add a stock acknowledgement just to start sooner. '
    + 'Translation: {"type":"translation","key":"s1","display_zh":"你好。"}. Keys must be unique per reply. '
    + 'Use only speech and translation events. Expression follows your attitude toward this sentence, not random rotation.\n'
    + `表情语义目录：${JSON.stringify(value.guide)}\n当前服装：${settings.avatar_costume}\n`
    + `用户称呼：${settings.user_name || '未设置'}\n用户明确保存的记忆：${JSON.stringify(memory)}\n`
    + `最近实际展示：${JSON.stringify(recent)}\n手机时间：${new Date().toISOString()}`;
}
