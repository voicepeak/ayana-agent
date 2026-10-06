export interface CaptionPosition { id: string; center: number }

/** Keep one winner at boundaries; unscaled layout coordinates prevent feedback. */
export function captionFocus(rows: CaptionPosition[], center: number, previous?: string): string | undefined {
  const nearest = rows.reduce<CaptionPosition | undefined>((best, row) => !best || Math.abs(row.center - center) < Math.abs(best.center - center) ? row : best, undefined);
  const held = rows.find(row => row.id === previous);
  return held && nearest && Math.abs(held.center - center) <= Math.abs(nearest.center - center) + 12 ? held.id : nearest?.id;
}
