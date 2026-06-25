const esbuild = require('esbuild');

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  sourcemap: true,
  platform: 'node',
  target: 'node18',
  logLevel: 'info',
  minify: process.argv.includes('--production'),
  legalComments: 'none',
};

async function main() {
  if (process.argv.includes('--watch')) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log('[esbuild] watching for changes...');
  } else {
    await esbuild.build(buildOptions);
    console.log('[esbuild] build complete');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
