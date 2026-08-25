import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '..', '..');
const destination = join(here, '..', 'public');
const files = ['app.html', 'app.js', 'styles.css', 'keymap.js', 'unicode-latex.js', 'conversion.js'];

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
for (const file of files) await cp(join(source, file), join(destination, file));
await cp(join(source, 'vendor'), join(destination, 'vendor'), { recursive: true, filter: (path) => !path.includes('types') });
await cp(join(destination, 'app.html'), join(destination, 'index.html'));
const indexPath = join(destination, 'index.html');
const html = await readFile(indexPath, 'utf8');
await writeFile(indexPath, html.replace('</head>', '  <meta name="shikitype-cloud" content="1" />\n</head>'));
