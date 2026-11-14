#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (file) => readFileSync(resolve(root, file), 'utf8');

const problems = [];

const pkg = JSON.parse(read('package.json')).version;
const cargoMatch = read('src-tauri/Cargo.toml').match(/^version = "([^"]+)"/m);
const cargo = cargoMatch?.[1];

const confRaw = JSON.parse(read('src-tauri/tauri.conf.json'));
const confVersion = confRaw.version;
const conf = /^\d+\.\d+\.\d+$/.test(confVersion ?? '')
  ? confVersion
  : JSON.parse(readFileSync(resolve(root, 'src-tauri', confVersion), 'utf8')).version;

const sources = [
  ['package.json', pkg],
  ['src-tauri/Cargo.toml', cargo],
  ['src-tauri/tauri.conf.json', conf],
];

for (const [file, value] of sources) {
  if (!value) {
    problems.push(`${file}: 无法读取版本号`);
  } else if (!/^\d+\.\d+\.\d+$/.test(value)) {
    problems.push(`${file}: 版本号不是 x.y.z 格式（当前 ${value}）`);
  }
}

if (new Set(sources.map(([, value]) => value)).size > 1) {
  problems.push(
    `版本号不一致：${sources.map(([file, value]) => `${file}=${value}`).join('，')}`,
  );
}

const tag = (process.argv[2] ?? '').trim();
const tagVersion = tag.replace(/^v/, '');
if (/^v?\d+\.\d+\.\d+$/.test(tag) && tagVersion !== pkg) {
  problems.push(`tag ${tag} 与 package.json 版本 ${pkg} 不一致`);
}

if (problems.length > 0) {
  console.error('版本校验失败：');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('\n先运行 pnpm version:set <x.y.z> 再提交。');
  process.exit(1);
}

console.log(`版本一致：${pkg}${tag ? `（tag ${tag}）` : ''}`);
