'use strict';
const fs = require('node:fs');
const path = require('node:path');
const source = path.join(__dirname, 'src');
const target = path.join(__dirname, '../server/public');
fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
fs.cpSync(source, target, { recursive: true });
console.log(`DigitalBots web assets copied to ${target}`);
