import {cp, mkdir, rm} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build, context} from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = resolve(root, 'dist');
const watch = process.argv.includes('--watch');

const staticFiles = [
	'content.css',
	'manifest.json',
	'options.css',
	'options.html',
];

async function copyAssets() {
	await mkdir(outputDirectory, {recursive: true});
	await Promise.all(staticFiles.map(file => cp(
		resolve(root, file),
		resolve(outputDirectory, file),
	)));
	await cp(resolve(root, 'icons'), resolve(outputDirectory, 'icons'), {
		recursive: true,
	});
}

const buildOptions = {
	bundle: true,
	entryPoints: {
		background: resolve(root, 'src/background.ts'),
		content: resolve(root, 'src/content/index.ts'),
		options: resolve(root, 'src/options/index.ts'),
	},
	format: 'iife',
	logLevel: 'info',
	outdir: outputDirectory,
	platform: 'browser',
	sourcemap: watch,
	target: 'chrome120',
};

await rm(outputDirectory, {force: true, recursive: true});
await copyAssets();

if (watch) {
	const buildContext = await context(buildOptions);
	await buildContext.watch();
	console.log('Watching TypeScript sources.');
} else {
	await build(buildOptions);
}
