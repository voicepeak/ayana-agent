import { copyFileSync, linkSync, mkdirSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';

export type PortableRuntime = { root: string; backend: string; python: string };

function clone(source: string, destination: string) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) clone(from, to);
    else if (entry.isFile()) {
      try { linkSync(from, to); }
      catch { copyFileSync(from, to); }
    }
  }
}

// Windows file-system filters can make fs.rmSync report success without
// deleting anything, so removal walks the tree and unlinks each entry.
export function removeTree(target: string) {
  let entries;
  try { entries = readdirSync(target, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) removeTree(child);
    else unlinkSync(child);
  }
  rmdirSync(target);
}

// The portable launcher unpacks into %TEMP%. Cleanup tools may delete those
// files while Ayana still runs, so the read-only runtime gets a second name
// under userData. Hard links keep the session intact without copying 1 GB.
export function stagePortableRuntime(resources: string, userData: string, pid = process.pid,
  remove: (target: string) => void = removeTree): PortableRuntime {
  const base = path.join(userData, 'portable-runtime');
  let root = path.join(base, 'current');
  try {
    remove(base);
    mkdirSync(root, { recursive: true });
  } catch {
    // An orphaned backend keeps its interpreter locked; use a fresh slot.
    root = path.join(base, `session-${pid}`);
    removeTree(root);
    mkdirSync(root, { recursive: true });
  }
  clone(path.join(resources, 'backend'), path.join(root, 'backend'));
  clone(path.join(resources, 'python'), path.join(root, 'python'));
  return { root, backend: path.join(root, 'backend'), python: path.join(root, 'python', 'python.exe') };
}

export function releasePortableRuntime(root: string | undefined) {
  if (!root) return;
  try {
    // A restart or a lock failure leaves the directory for the next stage to clean.
    removeTree(path.dirname(root));
  } catch { /* The next launch retries. */ }
}
