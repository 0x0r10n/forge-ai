/**
 * Prepend #!/usr/bin/env node to dist/forge.js
 *
 * Bun's --banner flag appends after existing content; this script
 * ensures the shebang is strictly the first byte of the output file,
 * which is required for the OS to recognise it as an executable script.
 */
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outPath = join(root, 'dist', 'forge.js');

const original = readFileSync(outPath, 'utf-8');

const SHEBANG = '#!/usr/bin/env -S node --no-deprecation\n';

// Skip if the exact desired shebang is already the first line
if (original.startsWith(SHEBANG)) {
  process.exit(0);
}

// Strip any existing shebang line before prepending
const stripped = original.startsWith('#!') ? original.slice(original.indexOf('\n') + 1) : original;
writeFileSync(outPath, SHEBANG + stripped, 'utf-8');
console.log('✔ Shebang prepended to dist/forge.js');
