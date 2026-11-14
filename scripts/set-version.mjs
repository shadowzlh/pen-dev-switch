#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const version = process.argv[2]?.trim();
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('用法: pnpm version:set <major.minor.patch>');
  process.exit(1);
}

const root = resolve(import.meta.dirname, '..');
const print = (message) => console.log(message);

function patch(file, transform) {
  const path = resolve(root, file);
  const before = readFileSync(path, 'utf8');
  const after = transform(before);
  if (after === before) {
    print(`- ${file} 已是 ${version}`);
    return;
  }
  writeFileSync(path, after);
  print(`✓ ${file}`);
}

patch('package.json', (raw) => raw.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`));
patch('src-tauri/Cargo.toml', (raw) => raw.replace(/^version = "[^"]+"/m, `version = "${version}"`));

// tauri.conf.json 指向 package.json 时不需要改；仍写字面版本时同步。
const confPath = resolve(root, 'src-tauri/tauri.conf.json');
const confRaw = readFileSync(confPath, 'utf8');
const confVersion = JSON.parse(confRaw).version;
if (/^\d+\.\d+\.\d+$/.test(confVersion)) {
  writeFileSync(confPath, confRaw.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`));
  print('✓ src-tauri/tauri.conf.json');
} else {
  print(`- src-tauri/tauri.conf.json 使用 ${confVersion}，无需修改`);
}

print(`\n版本已设为 ${version}。Cargo.lock 会在下次 cargo 构建时自动更新。`);
