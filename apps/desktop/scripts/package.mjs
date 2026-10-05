import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { verifyPortableIsolation } from './verify-portable.mjs';

// In installed builder 26.15.3, true keeps NSIS's per-launch $PLUGINSDIR.
// False (despite its type comment) reuses a build directory and can delete
// another running instance's backend files after a second launch exits.
await verifyPortableIsolation();

// Reuse a previously installed official builder toolset when available. This
// avoids downloading the same compiler again on restricted/offline networks.
// On a fresh machine electron-builder uses its normal checksum-verified download.
const environment = { ...process.env };
// 7-Zip 24 can select ARM64 filters that the bundled NSIS extractor cannot read.
// Keep the Windows x64 portable archive on the supported BCJ filter.
environment.ELECTRON_BUILDER_7Z_FILTER ||= 'BCJ';
const cache = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache');
if (cache) {
  const compiler = path.join(cache, 'nsis', 'nsis-3.0.4.1-nsis-3.0.4.1');
  const resources = path.join(cache, 'nsis', 'nsis-resources-3.4.1-nsis-resources-3.4.1');
  if (!environment.ELECTRON_BUILDER_NSIS_DIR && existsSync(path.join(compiler, 'Bin', 'makensis.exe')) && existsSync(path.join(compiler, 'elevate.exe'))) {
    environment.ELECTRON_BUILDER_NSIS_DIR = compiler;
  }
  if (!environment.ELECTRON_BUILDER_NSIS_RESOURCES_DIR && existsSync(path.join(resources, 'plugins'))) {
    environment.ELECTRON_BUILDER_NSIS_RESOURCES_DIR = resources;
  }
}
const child = spawn(process.execPath, ['node_modules/electron-builder/cli.js', '--win', 'portable'], { stdio: 'inherit', env: environment });
child.on('exit', code => { process.exitCode = code ?? 1; });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
