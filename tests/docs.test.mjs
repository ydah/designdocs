import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { extractWikilinks } from '../src/lib/markdown.mjs';
import { buildDocIndex, resolveTarget } from '../src/lib/doc-index.mjs';
import { normalizeTag } from '../src/lib/tags.mjs';

test('normalizes tags to lower kebab-case', () => {
  assert.equal(normalizeTag('  PostgreSQL_design  '), 'postgresql-design');
  assert.equal(normalizeTag('Static Site'), 'static-site');
});

test('resolves local and explicit cross-repository wikilinks', () => {
  const ids = new Set(['api/0001-auth', 'api/0002-client']);
  assert.equal(resolveTarget('0001-auth', 'api', ids), 'api/0001-auth');
  assert.equal(resolveTarget('0001-auth', 'worker', ids), undefined);
  assert.equal(resolveTarget('api/0002-client', 'worker', ids), 'api/0002-client');
  assert.equal(resolveTarget('missing', 'api', ids), undefined);
});

test('does not extract wikilinks from code or math', () => {
  const links = extractWikilinks([
    '本文 [[0001-real]]',
    '`[[0002-inline-code]]`',
    '```text',
    '[[0003-code-block]]',
    '```',
    '$[[0004-math]]$',
  ].join('\n'));
  assert.deepEqual(links.map(({ target }) => target), ['0001-real']);
});

test('ignores private tsuzuri records when building the document index', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-docs-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  fs.mkdirSync(path.join(root, 'lrama', '0001-example.md.tsuzuri'), { recursive: true });
  fs.writeFileSync(path.join(root, 'lrama', '0001-example.md'), '---\ntitle: Example\n---\n');
  fs.writeFileSync(path.join(root, 'lrama', '0001-example.md.tsuzuri', 'memo.md'), '# private');

  assert.deepEqual(buildDocIndex(root).records.map(({ id }) => id), ['lrama/0001-example']);
});
