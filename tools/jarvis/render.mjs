// Render tools/jarvis/jarvis.html to an mp4 the boot pool can play.
//
// Headless Chrome loads the page in `?render=<fps>` mode, which draws every frame
// and posts it here as a PNG, then posts the effects track it rendered with an
// OfflineAudioContext. ffmpeg then mixes in voice.mp3 and encodes, with `moov`
// in front so the clip is faststart from the start.
//
// Usage: node tools/jarvis/render.mjs [--fps 60] [--trim 0.3] [--out <dir>] [--install]
//   --trim     seconds cut from the head of the sequence (default 0.3): the page
//              opens on a single dot, and a boot clip should open on something
//   --out      working directory for frames and the result (default: a fresh
//              folder under the OS temp dir; ~1 GB of PNGs at 60 fps)
//   --install  also copy the result to assets/videos/jarvis.mp4
// Needs Chrome (or Edge; override with CHROME=<path>) and ffmpeg on PATH.
// Changing VOICE_DELAY_MS means moving SPEAK_T0/SPEAK_T1 in jarvis.html too.
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir, mkdtemp, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const here = fileURLToPath(new URL('.', import.meta.url))
const args = process.argv.slice(2)
const flag = name => args.includes(name)
const option = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const fps = Number(option('--fps', 60)) || 60
const outDir = option('--out', null) ?? await mkdtemp(join(tmpdir(), 'jarvis-render-'))
const trim = Number(option('--trim', 0.3)) || 0
const VOICE_DELAY_MS = 7200
const DURATION = 10.4

const chrome = process.env.CHROME ?? [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find(existsSync)
if (!chrome) throw new Error('no Chrome/Edge found; set CHROME=<path>')

await mkdir(join(outDir, 'frames'), { recursive: true })
console.log('working in', outDir)

function body(req) {
  return new Promise((ok, fail) => {
    const parts = []
    req.on('data', c => parts.push(c)).on('end', () => ok(Buffer.concat(parts))).on('error', fail)
  })
}

// Resolves with the frame count once the page posts /done.
const rendered = new Promise((resolve) => {
  let browser
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        return res.end(await readFile(join(here, 'jarvis.html')))
      }
      const data = await body(req)
      if (req.url.startsWith('/frame/')) {
        const i = Number(req.url.slice(7))
        await writeFile(join(outDir, 'frames', String(i).padStart(5, '0') + '.png'), data)
        if (i % fps === 0) console.log('frame', i)
      } else if (req.url === '/audio') {
        await writeFile(join(outDir, 'sfx.wav'), data)
      } else if (req.url === '/done') {
        res.end('ok')
        browser?.kill()
        server.close()
        return resolve(Number(data.toString()))
      }
      res.end('ok')
    } catch (error) {
      console.error(error)
      res.writeHead(500); res.end()
    }
  })
  server.listen(0, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}/?render=${fps}`
    console.log('rendering', url)
    browser = spawn(chrome, [
      '--headless=new', '--hide-scrollbars', '--window-size=1920,1080',
      '--user-data-dir=' + join(outDir, 'chrome-profile'), url,
    ], { stdio: 'ignore' })
  })
})
console.log('frames', await rendered)

// Mix: the voice is delayed onto the waveform window, lightly roomed, and summed
// with the effects track without normalisation so neither is ducked. The trim is
// applied after the mix, on both streams, so the voice stays on its frames.
const mix = `[0:v]trim=start=${trim},setpts=PTS-STARTPTS[vv];` +
  `[1:a]adelay=${VOICE_DELAY_MS}|${VOICE_DELAY_MS},highpass=f=90,aecho=0.8:0.6:35|70:0.22|0.12,volume=1.6[v];` +
  '[2:a]volume=0.9[s];[s][v]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.95,' +
  `atrim=start=${trim},asetpts=PTS-STARTPTS[a]`
const result = join(outDir, 'jarvis.mp4')
// Hardware encoders first; libopenh264 is the one every ffmpeg build carries.
const encoders = [
  ['h264_nvenc', '-preset', 'p7', '-rc', 'vbr', '-cq', '19', '-b:v', '14M', '-maxrate', '20M'],
  ['h264_mf', '-b:v', '14M'],
  ['libx264', '-crf', '17', '-preset', 'slow'],
  ['libopenh264', '-b:v', '14M', '-maxrate', '20M'],
]
const encoded = encoders.some(([codec, ...tune]) => {
  const run = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-framerate', String(fps), '-i', join(outDir, 'frames', '%05d.png'),
    '-i', join(here, 'voice.mp3'), '-i', join(outDir, 'sfx.wav'),
    '-filter_complex', mix, '-map', '[vv]', '-map', '[a]',
    '-c:v', codec, ...tune, '-pix_fmt', 'yuv420p', '-profile:v', 'high',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-t', String(DURATION - trim), result,
  ], { stdio: 'inherit' })
  if (run.status === 0) console.log('encoded with', codec)
  return run.status === 0
})
if (!encoded) throw new Error('every H.264 encoder failed')

// Assert the result, not the plan: moov must precede mdat in the file written.
const head = (await readFile(result)).subarray(0, 65536)
const moov = head.indexOf('moov'), mdat = head.indexOf('mdat')
if (moov < 0 || (mdat >= 0 && mdat < moov)) throw new Error('result is not faststart')
console.log('wrote', result)

if (flag('--install')) {
  const target = fileURLToPath(new URL('../../assets/videos/jarvis.mp4', import.meta.url))
  await copyFile(result, target)
  console.log('installed', target)
}
