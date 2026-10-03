import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Reuse a previously installed official builder toolset when available. This
// avoids downloading the same compiler again on restricted/offline networks.
// On a fresh machine electron-builder uses its normal checksum-verified download.
const environment = { ...process.env };
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
