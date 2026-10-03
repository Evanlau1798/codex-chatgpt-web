import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { executableOnPath, LAB_ROOT, DEFAULT_SOURCE_ROOT } from '../src/launch-args.mjs';
const bun = process.env.ASTRA6_BUN_PATH || executableOnPath('bun');
const root = LAB_ROOT;
const sourceRoot = DEFAULT_SOURCE_ROOT;

test('model-catalog.ts uses source augmentNativeModelCatalog and emits only GPT-6 Pro/max', { skip: !fs.existsSync(bun) }, () => {
  const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'astra6-catalog-test-')), 'catalog.json');
  const result = spawnSync(bun, [path.join(root, 'scripts/model-catalog.ts'), '--source-root', sourceRoot,
    '--source-catalog', path.join(root, 'tests/fixtures/native-models.json'), '--output', output], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const catalog = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.deepEqual(catalog.models.map(model => model.slug), ['chatgpt-web/gpt-6-pro']);
  assert.equal(catalog.models[0].default_reasoning_level, 'max');
  assert.deepEqual(catalog.models[0].supported_reasoning_levels.map(level => level.effort), ['max']);
  assert.equal(catalog.models[0].supports_search_tool, false);
});

test('catalog generator invokes an npm command-shim package entry through a real child', { skip: !fs.existsSync(bun) }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-shim-'));
  try {
    const pkg = path.join(tmp, 'node_modules', '@openai', 'codex');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'codex.cmd'), '@echo off\n');
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ bin: { codex: 'cli.mjs' } }));
    fs.writeFileSync(path.join(pkg, 'cli.mjs'), `import fs from 'node:fs'; if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['debug','models','--bundled'])) process.exit(2); console.log(fs.readFileSync(${JSON.stringify(path.join(root, 'tests/fixtures/native-models.json'))}, 'utf8'));`);
    const output = path.join(tmp, 'catalog.json');
    const result = spawnSync(bun, [path.join(root, 'scripts/model-catalog.ts'), '--source-root', sourceRoot,
      '--codex-path', path.join(tmp, 'codex.cmd'), '--output', output], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).models[0].slug, 'chatgpt-web/gpt-6-pro');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
