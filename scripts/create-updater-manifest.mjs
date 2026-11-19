#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const [version, tag, directory] = process.argv.slice(2);
if (!version || !tag || !directory) {
  console.error('Usage: node scripts/create-updater-manifest.mjs <version> <tag> <artifact-directory>');
  process.exit(1);
}

const files = readdirSync(directory);
const installer = files.find((file) => file.endsWith('-setup.exe') && files.includes(`${file}.sig`));
if (!installer) throw new Error('No signed NSIS installer found');

const signatureFile = `${installer}.sig`;

const owner = process.env.GITHUB_REPOSITORY;
if (!owner) throw new Error('GITHUB_REPOSITORY is required');

const manifest = {
  version,
  notes: `See the v${version} release notes.`,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature: readFileSync(join(directory, signatureFile), 'utf8').trim(),
      url: `https://github.com/${owner}/releases/download/${tag}/${encodeURIComponent(basename(installer))}`,
    },
  },
};

writeFileSync(join(directory, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
