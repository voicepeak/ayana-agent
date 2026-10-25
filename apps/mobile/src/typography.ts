/** Keep emoji, kana combining marks and accented letters intact during highlighting. */
export function splitGraphemes(text: string): string[] {
  if (typeof Intl.Segmenter === 'function') return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), item => item.segment);
  return Array.from(text);
}
