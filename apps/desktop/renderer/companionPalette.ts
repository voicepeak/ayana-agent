type RGB = [number, number, number];
const rgb = (hex: string): RGB => [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16)) as RGB;
const hex = (channels: RGB) => '#' + channels.map(channel => Math.round(channel).toString(16).padStart(2, '0')).join('');
function luminance(color: string) {
  const channels = rgb(color).map(channel => { const value = channel / 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4; });
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}
export function contrastRatio(first: string, second: string) {
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}
function mix(first: string, second: string, amount: number) {
  const a = rgb(first), b = rgb(second);
  return hex(a.map((channel, index) => channel + (b[index] - channel) * amount) as RGB);
}
function readable(background: string, target: string, minimum: number) {
  for (let amount = .45; amount <= 1; amount += .025) {
    const color = mix(background, target, amount);
    if (contrastRatio(background, color) >= minimum) return color;
  }
  return target;
}
/** Every visible surface owns its text and edge colours, independent of the desktop beneath it. */
export function surfacePalette(background: string) {
  let dark = contrastRatio(background, '#17191d') >= contrastRatio(background, '#fffaf0');
  const preferred = dark ? '#17191d' : '#fffaf0';
  if (contrastRatio(background, preferred) < 4.5) dark = contrastRatio(background, '#000000') >= contrastRatio(background, '#ffffff');
  const text = contrastRatio(background, preferred) >= 4.5 ? preferred : dark ? '#000000' : '#ffffff';
  return { background, text, muted: readable(background, text, 4.5), border: readable(background, text, 3),
    accent: readable(background, text, 4.5), light: dark };
}
