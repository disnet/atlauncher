// Bundles the browser code for the shell, the demo app and the mock apps.

import * as esbuild from 'esbuild'

export const buildOptions: esbuild.BuildOptions = {
  entryPoints: {
    'shell/main': 'shell/src/main.ts',
    'app/main': 'app/src/main.ts',
    'app/callback': 'app/src/callback.ts',
    'mocks/main': 'mocks/src/main.ts',
  },
  outdir: 'dist',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  sourcemap: true,
  logLevel: 'info',
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await esbuild.build(buildOptions)
}
