import {homedir} from 'node:os'
import {join} from 'node:path'

if(process.argv.length!==2)throw new Error('Default-profile companion does not accept debug ports')
process.env.DSH_BETTER_FLOAT_COMPANION_DIR=join(homedir(),'.dsh','companions','better-float')
await import('./run-companion.mjs')
