#!/usr/bin/env node
'use strict';

// scripts/build.js — Node SEA single executable (optional). This is a stub that produces
// a simple notice if SEA is not enabled on this Node version or platform. The app is
// zero-dependency and runs as `node server.js` out of the box.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));

console.log('agent-forge-studio build (Node SEA stub)');
console.log('This is a zero-dependency app — you can run it directly with: node server.js');
console.log('If you want a single executable, ensure Node >= 20.12 supports SEA on your platform.');
console.log('SEA build skipped (no configuration present).');
process.exit(0);
