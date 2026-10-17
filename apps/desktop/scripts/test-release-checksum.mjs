import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeReleaseChecksums } from './release-checksum.mjs';

const directory = await mkdtemp(path.join(os.tmpdir(), 'ayana-checksum-'));
try {
  await assert.rejects(writeReleaseChecksums(directory, '0.0.1'), /No release artifacts/);
  const filename = 'Ayana-0.0.1-win-x64.exe';
  const setup = 'Ayana-0.0.1-win-x64-setup.exe';
  await writeFile(path.join(directory, filename), 'first build');
  await writeFile(path.join(directory, setup), 'setup build');
  await writeFile(path.join(directory, 'Ayana-0.0.0-win-x64.exe'), 'previous version');
  const manifest = await writeReleaseChecksums(directory, '0.0.1');
  await writeFile(path.join(directory, filename), 'rebuilt artifact');
  await writeReleaseChecksums(directory, '0.0.1');
  const hash = value => createHash('sha256').update(value).digest('hex');
  assert.equal(await readFile(manifest, 'utf8'),
    `${hash('setup build')}  ${setup}\n${hash('rebuilt artifact')}  ${filename}\n`);
  console.log('PASS: release checksums cover both installer and portable artifacts, regenerate from completed files and exclude other versions.');
} finally {
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  assert(path.basename(directory).startsWith('ayana-checksum-'));
  await rm(directory, { recursive: true, force: true });
}
