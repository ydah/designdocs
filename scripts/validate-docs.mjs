#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDocIndex } from '../src/lib/doc-index.mjs';
import { extractWikilinks } from '../src/lib/markdown.mjs';

const root = fileURLToPath(new URL('../src/content/docs/', import.meta.url));
const index = buildDocIndex(root, { strictWikilinks: true });
const errors = [];

for (const record of index.records) {
  const markdown = fs.readFileSync(record.filePath, 'utf8');
  for (const { target } of extractWikilinks(markdown)) {
    if (!index.resolve(target, record.repo)) {
      errors.push(`存在しない wikilink: [[${target}]] (${path.relative(process.cwd(), record.filePath)})`);
    }
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Validated ${index.records.length} design documents.`);
}
