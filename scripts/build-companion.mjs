import { build } from 'esbuild'
import { mkdir, copyFile } from 'node:fs/promises'
await mkdir('lib/companion',{recursive:true})
await build({entryPoints:['companion/main.ts'],bundle:true,platform:'node',format:'cjs',
  outfile:'lib/companion/main.cjs',external:['electron'],target:'node22'})
await copyFile('companion/test-window.html','lib/companion/test-window.html')
await build({entryPoints:['companion/preload.ts'],bundle:true,platform:'node',format:'cjs',outfile:'lib/companion/preload.cjs',external:['electron']})
await build({entryPoints:['companion/controls-renderer.ts'],bundle:true,platform:'browser',format:'iife',outfile:'lib/companion/controls-renderer.js'})
for(const file of ['controls-window.html','controls.css'])await copyFile(`companion/${file}`,`lib/companion/${file}`)
