import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

await build({
  entryPoints: [fileURLToPath(new URL('./relay-admin.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('../server/relay/admin/room-policy.js', import.meta.url)),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  globalName: 'roomPolicyPanel',
  minify: true,
});
