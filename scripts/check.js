#!/usr/bin/env node
'use strict';

// scripts/check.js — syntax check + a cheap smoke test: every lib module loads and
// a temp channel workspace + studio home can be initialised. Zero runtime deps.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const root = path.resolve(__dirname, '..');
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ytstudio-check-'));
const tmpWork = fs.mkdtempSync(path.join(os.tmpdir(), 'ytws-check-'));

process.env.YOUTUBE_STUDIO_HOME = tmpHome;

function check(file) {
  try { require('node:fs'); new (require('node:vm').Script)(fs.readFileSync(file, 'utf8'), { filename: file }); }
  catch (e) { console.error('SYNTAX FAIL', file, e.message); process.exit(1); }
}

const files = [];
function walk(d, ext) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, ext);
    else if (p.endsWith(ext)) files.push(p);
  }
}
walk(root, '.js');

for (const f of files) check(f);
console.log(`Syntax OK for ${files.length} files.`);

// smoke load
const cfg = require(path.join(root, 'lib/config'));
cfg.setWorkDir(tmpWork);
require(path.join(root, 'lib/log'));
require(path.join(root, 'lib/errors'));
require(path.join(root, 'lib/runtime'));
require(path.join(root, 'lib/sessions'));
require(path.join(root, 'lib/workspace'));
require(path.join(root, 'lib/permission'));
require(path.join(root, 'lib/llm'));
require(path.join(root, 'lib/ollama'));
require(path.join(root, 'lib/openai'));
require(path.join(root, 'lib/anthropic'));
require(path.join(root, 'lib/agents'));
require(path.join(root, 'lib/tools'));
require(path.join(root, 'lib/agent'));
require(path.join(root, 'lib/skills'));
require(path.join(root, 'lib/commands'));
require(path.join(root, 'lib/web'));
require(path.join(root, 'lib/youtube'));
require(path.join(root, 'server'));
console.log('Smoke load OK.');
