import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
// Initialize the public entry point before its internal targets to avoid the
// builder's PlatformPackager/index circular dependency during standalone use.
require('app-builder-lib');
const { NsisTarget } = require('app-builder-lib/out/targets/nsis/NsisTarget.js');
const { Arch } = require('builder-util');
const projectDir = fileURLToPath(new URL('..', import.meta.url));

// Run the installed builder's real define generation, then stop at its
// effectiveOptionComputed hook. Fake archive metadata avoids file writes,
// downloads, compression or starting the user's application.
async function computedDefines(portable, metadata) {
  let result;
  const appInfo = {
    id: metadata.build.appId, name: metadata.name, version: metadata.version,
    productName: metadata.build.productName, productFilename: 'Ayana',
    sanitizedName: metadata.name, description: metadata.description,
    copyright: '', buildVersion: metadata.version, updaterCacheDirName: 'ayana',
    getVersionInWeirdWindowsForm: () => `${metadata.version}.0`,
  };
  const packager = {
    config: { portable }, appInfo, projectDir, compression: 'store',
    platformSpecificBuildOptions: {},
    info: { metadata, buildResourcesDir: projectDir, emitArtifactBuildStarted: async () => {} },
    expandArtifactNamePattern: () => 'verification-only.exe',
    getIconPath: async () => null,
    packagerOptions: { effectiveOptionComputed: async ([defines]) => { result = defines; return true; } },
  };
  const packageHelper = {
    refCount: 0,
    packArch: async () => ({
      fileInfo: { path: 'verification-only.7z', sha512: Buffer.alloc(64).toString('base64') },
      unpackedSize: 0,
    }),
  };
  const target = new NsisTarget(packager, projectDir, 'portable', packageHelper);
  await target.buildInstaller(new Map([[Arch.x64, projectDir]]));
  assert(result, 'Builder must reach the define verification hook.');
  return result;
}

export async function verifyPortableIsolation() {
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const defines = await computedDefines(metadata.build.portable, metadata);
  assert(!Object.hasOwn(defines, 'UNPACK_DIR_NAME'),
    'Portable launches must use independent $PLUGINSDIR directories, not a shared build directory.');

  const template = await readFile(require.resolve('app-builder-lib/templates/nsis/portable.nsi'), 'utf8');
  assert(template.includes('StrCpy $INSTDIR "$PLUGINSDIR\\app"'),
    'Verify the installed NSIS template still defaults to a per-launch plugin directory.');

  // Confirm the probe exposes the original regression, rather than merely
  // asserting that our package.json contains a particular boolean value.
  const previousDefaults = await computedDefines({}, metadata);
  assert.equal(typeof previousDefaults.UNPACK_DIR_NAME, 'string');
  console.log('PASS: Installed portable builder omits shared UNPACK_DIR_NAME; each launch uses its own NSIS plugin directory.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await verifyPortableIsolation();
}
