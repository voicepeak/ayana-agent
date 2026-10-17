import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function writeReleaseChecksums(directory, version) {
  const prefix = `Ayana-${version}-win-`;
  const artifacts = (await readdir(directory)).filter(name => name.startsWith(prefix) && name.endsWith('.exe')).sort();
  if (!artifacts.length) throw new Error(`No release artifacts for ${version}`);
  const lines = [];
  for (const name of artifacts) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path.join(directory, name))) hash.update(chunk);
    lines.push(`${hash.digest('hex')}  ${name}\n`);
  }
  const destination = path.join(directory, `SHA256SUMS-${version}.txt`);
  const temporary = `${destination}.tmp`;
  await writeFile(temporary, lines.join(''), 'utf8');
  await rename(temporary, destination);
  return destination;
}
