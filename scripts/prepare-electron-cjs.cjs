#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const distElectronDir = path.resolve(__dirname, '..', 'dist-electron');
const distElectronPkg = path.join(distElectronDir, 'package.json');
const packageJson = { type: 'commonjs' };

fs.mkdirSync(distElectronDir, { recursive: true });
fs.writeFileSync(distElectronPkg, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');

// Guard against malformed JSON being emitted into app.asar.
JSON.parse(fs.readFileSync(distElectronPkg, 'utf8'));

console.log(`[prepare-electron-cjs] wrote ${distElectronPkg}`);

