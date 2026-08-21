import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = __dirname;
const dist = resolve(root, 'dist');

const entryPoints = {
  'background': 'src/background.ts',
  'content-script': 'src/content-script.ts',
  'popup/popup': 'src/popup/popup.ts',
  'options/options': 'src/options/options.ts',
};

const watch = process.argv.includes('--watch');

const staticAssets = [
  'manifest.json',
  'src/popup/popup.html',
  'src/options/options.html',
  'src/styles/theme.css',
];

async function copyStatic() {
  await mkdir(dist, { recursive: true });
  for (const asset of staticAssets) {
    const dest = resolve(dist, asset.replace(/^src\//, ''));
    await mkdir(dirname(dest), { recursive: true });
    await cp(resolve(root, asset), dest);
  }
  // copy icons if present
  const iconsSrc = resolve(root, 'src/icons');
  if (existsSync(iconsSrc)) {
    await cp(iconsSrc, resolve(dist, 'icons'), { recursive: true });
  }
}

async function run() {
  if (existsSync(dist)) await rm(dist, { recursive: true });

  const options = {
    entryPoints,
    outdir: dist,
    bundle: true,
    format: 'esm',
    target: 'es2022',
    loader: { '.css': 'text' },
    sourcemap: false,
    minify: !watch,
    logLevel: 'info',
  };

  if (watch) {
    const ctx = await context(options);
    await ctx.watch();
    await copyStatic();
    console.log('watching...');
  } else {
    await build(options);
    await copyStatic();
    console.log('build complete -> dist/');
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
