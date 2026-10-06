/** Shared timing/layout for voiced subtitles and the text-only fallback. */
export const dialogueGlyphs = (text: string): string[] => [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(text)].map(part => part.segment);
const weight = (glyph: string) => /[，。！？、,.!?;；:：…\n]/u.test(glyph) ? 2.8 : /\s/u.test(glyph) ? .4 : 1;
export function dialogueRevealDuration(text: string) {
  return Math.max(900, dialogueGlyphs(text).reduce((sum, glyph) => sum + weight(glyph), 0) * 78);
}
export function dialogueReadTime(text: string) { return dialogueRevealDuration(text) + 1900; }
export function dialogueRevealCount(text: string, progress: number) {
  const glyphs = dialogueGlyphs(text);
  const fraction = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
  if (fraction >= 1) return glyphs.length;
  const budget = glyphs.reduce((sum, glyph) => sum + weight(glyph), 0) * fraction;
  let consumed = 0, count = 0;
  for (const glyph of glyphs) { if (consumed > budget) break; consumed += weight(glyph); count++; }
  return count;
}
export interface DialogueGlyph { value: string; index: number; }
export interface DialoguePage { lines: DialogueGlyph[][]; start: number; end: number; }
/** At most two lines per shot, without dropping long replies or splitting emoji. */
export function dialoguePages(text: string, columns = 15): DialoguePage[] {
  const limit = Math.max(4, Math.floor(columns));
  const pages: DialoguePage[] = [];
  let lines: DialogueGlyph[][] = [], line: DialogueGlyph[] = [], width = 0;
  const finishPage = () => {
    if (!lines.length) return;
    pages.push({ lines, start: lines[0][0].index, end: lines.at(-1)!.at(-1)!.index + 1 }); lines = [];
  };
  const finishLine = () => { if (line.length) { lines.push(line); line = []; } width = 0; if (lines.length === 2) finishPage(); };
  dialogueGlyphs(text).forEach((value, index) => {
    if (value === '\n' || value === '\r\n') { finishLine(); return; }
    const size = /^[\x00-\x7F]+$/.test(value) ? .55 : 1;
    if (width + size > limit) finishLine();
    line.push({ value, index }); width += size;
  });
  finishLine(); finishPage(); return pages;
}
export function dialoguePageAt(pages: DialoguePage[], count: number) {
  return pages.find(page => count <= page.end) || pages.at(-1);
}
