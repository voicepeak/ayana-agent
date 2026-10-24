/** randomUUID is absent on HTTP LAN pages; getRandomValues remains available. */
export function identifier() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
