import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { STORY_CATALOG, STORY_CATALOG_VERSION } from '../stories/index.js';

const destination = resolve(process.argv[2] ?? 'backend/stories/catalog.v1.json');
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, `${JSON.stringify({ version: STORY_CATALOG_VERSION, count: STORY_CATALOG.length, stories: STORY_CATALOG }, null, 2)}\n`);
console.log(`Exported ${STORY_CATALOG.length} bilingual Miu stories to ${destination}`);
