import type { Speech } from './state';
import type { CompanionDesign } from './CompanionDesign';
export type DialogueLanguage = CompanionDesign['primary_language'];
export const dialogueLanguageTag = { ja: 'ja', zh: 'zh-CN', en: 'en' };
export function dialogueText(speech: Pick<Speech, 'ja' | 'zh' | 'en'>, language: DialogueLanguage) {
  return speech[language] || '';
}
