// Bundles peer.ts with esbuild (a dev dependency) and runs it. Usage: see README.md here.
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(tmpdir(), 'lolping-room-peer.mjs');
await build({
  entryPoints: [join(here, 'peer.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'warning',
  // Same build-time injection as the app, so this tool reaches the owner's relay too when it is set.
  define: { __PRIVATE_RELAY__: JSON.stringify(process.env.LOLPING_PRIVATE_RELAY ?? '') },
});
await import(pathToFileURL(out).href);
