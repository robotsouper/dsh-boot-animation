// Regenerate tools/jarvis/voice.mp3, the "Welcome home, sir." line render.mjs
// mixes in. Only needed to change the line or the voice: the mp3 is checked in.
//
// Uses Microsoft's online Edge read-aloud voices through the `msedge-tts` package,
// which this plugin does not depend on. Install it somewhere else and name that
// directory:
//   npm install --prefix <dir> msedge-tts@2
//   node tools/jarvis/voice.mjs <dir>
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rename } from 'node:fs/promises'

const prefix = process.argv[2]
if (!prefix) throw new Error('usage: node tools/jarvis/voice.mjs <dir holding node_modules/msedge-tts>')
const require = createRequire(join(prefix, 'package.json'))
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts')

const here = fileURLToPath(new URL('.', import.meta.url))
const tts = new MsEdgeTTS()
await tts.setMetadata('en-GB-RyanNeural', OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3)
const { audioFilePath } = await tts.toFile(here, 'Welcome home, sir.', { rate: 0.95, pitch: '-6%' })
await rename(audioFilePath, join(here, 'voice.mp3'))
console.log('wrote', join(here, 'voice.mp3'))
process.exit(0)
