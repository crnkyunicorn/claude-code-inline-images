import type { EngineInterface, Register } from 'claude-code'

// Largest decoded PNG an <Image> accepts from bytes.
const MAX_PNG_BYTES = 2 * 1024 * 1024
// Longest edge in pixels when an image has to be converted or shrunk.
const MAX_EDGE = 1600
const MAX_IMAGES_PER_CALL = 4
// Largest box, in terminal cells, for each thumbnail: images from tool results (indented
// under the tool call) and images you pasted (under your message).
// `inRow` lays the images side by side, wrapping to a new row where the terminal ends.
type Fit = { columns: number; rows: number; indent: number; inRow?: boolean }
const TOOL_FIT: Fit = { columns: 50, rows: 15, indent: 5, inRow: true }
const PASTE_FIT: Fit = { columns: 50, rows: 15, indent: 2, inRow: true }
// Columns between images laid side by side.
const ROW_GAP = 2

type Found = { base64: string; mime: string }
type Ready = { png: string; width: number; height: number }
type Entry = { state: 'pending' } | { state: 'ready'; images: Ready[] } | { state: 'failed'; reason: string }

// Converts any image (stdin: base64) to a PNG no larger than MAX_EDGE (stdout: base64).
// Tries Pillow, then macOS sips, then ffmpeg.
const TO_PNG = `
set -e
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
(base64 -d 2>/dev/null || base64 -D) > "$t/in"
if command -v python3 >/dev/null && python3 -c 'import PIL' 2>/dev/null; then
  python3 - "$t/in" "$t/out.png" ${MAX_EDGE} <<'PY'
import sys
from PIL import Image
im = Image.open(sys.argv[1]); im.seek(0)
m = int(sys.argv[3]); im.thumbnail((m, m))
im.convert('RGBA').save(sys.argv[2], 'PNG', optimize=True)
PY
elif command -v sips >/dev/null; then
  sips -s format png -Z ${MAX_EDGE} "$t/in" --out "$t/out.png" >/dev/null
elif command -v ffmpeg >/dev/null; then
  ffmpeg -loglevel error -y -i "$t/in" -frames:v 1 -vf "scale='min(${MAX_EDGE},iw)':-1" "$t/out.png"
else
  echo "no converter: install Pillow (pip install pillow) or ffmpeg" >&2; exit 3
fi
base64 < "$t/out.png" | tr -d '\\n'
`

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

// Walks a tool's output for image blocks in the shapes Claude Code tools use:
// Read ({ type:'image', file:{ base64, type } }), MCP ({ type:'image', data, mimeType }),
// API blocks ({ type:'image', source:{ data, media_type } }).
function findImages(value: unknown, out: Found[] = [], depth = 0): Found[] {
  if (depth > 8 || out.length >= MAX_IMAGES_PER_CALL) return out
  if (Array.isArray(value)) {
    for (const v of value) findImages(v, out, depth + 1)
    return out
  }
  if (!isRecord(value)) return out
  if (value.type === 'image') {
    const file = value.file, source = value.source
    if (isRecord(file) && typeof file.base64 === 'string') {
      out.push({ base64: file.base64, mime: String(file.type ?? '') })
      return out
    }
    if (typeof value.data === 'string') {
      out.push({ base64: value.data, mime: String(value.mimeType ?? '') })
      return out
    }
    if (isRecord(source) && typeof source.data === 'string') {
      out.push({ base64: source.data, mime: String(source.media_type ?? '') })
      return out
    }
  }
  for (const v of Object.values(value)) findImages(v, out, depth + 1)
  return out
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// Decodes a short base64 prefix (enough to read a PNG header).
function decodeHead(text: string): Uint8Array {
  const bytes: number[] = []
  let bits = 0, acc = 0
  for (const ch of text) {
    const v = B64.indexOf(ch)
    if (v < 0) break
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((acc >> bits) & 0xff)
    }
  }
  return Uint8Array.from(bytes)
}

function pngSize(base64: string): { width: number; height: number } | undefined {
  const b = decodeHead(base64.slice(0, 64))
  const isPng = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
  if (!isPng || b.length < 24) return undefined
  const v = new DataView(b.buffer, b.byteOffset)
  return { width: v.getUint32(16), height: v.getUint32(20) }
}

function decodedBytes(base64: string): number {
  const pad = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return (base64.length * 3) / 4 - pad
}

async function prepare($: EngineInterface, found: Found): Promise<Ready> {
  const size = pngSize(found.base64)
  if (size && decodedBytes(found.base64) <= MAX_PNG_BYTES) {
    return { png: found.base64, ...size }
  }
  const run = await $.process.run(['sh', '-c', TO_PNG], { stdin: found.base64, timeoutMs: 20_000 })
  const out = run.stdout.trim()
  const converted = run.exitCode === 0 ? pngSize(out) : undefined
  if (!converted) throw new Error(run.stderr.trim().split('\n').pop() || `could not convert ${found.mime || 'image'}`)
  if (decodedBytes(out) > MAX_PNG_BYTES) throw new Error('image too large to draw')
  return { png: out, ...converted }
}

// Converts found images in the background, filing the result under every key given.
function load($: EngineInterface, cache: Map<string, Entry>, keys: string | string[], found: Found[]) {
  const ids = typeof keys === 'string' ? [keys] : keys
  const put = (entry: Entry) => ids.forEach(id => cache.set(id, entry))
  put({ state: 'pending' })
  void Promise.all(found.map(f => prepare($, f)))
    .then(images => put({ state: 'ready', images }))
    .catch((err: unknown) => put({ state: 'failed', reason: err instanceof Error ? err.message : String(err) }))
    .finally(() => $.ui.invalidate('ui.render'))
}

type Resolved = ReturnType<EngineInterface['ui']['resolve']>

// The images (or a status line) for one finished tool call, or null when it has none.
function imagesFor(
  $: EngineInterface,
  ui: Resolved,
  cache: Map<string, Entry>,
  id: string,
  output: unknown,
  termCols: number,
  fit: Fit = TOOL_FIT,
) {
  let entry = cache.get(id)
  if (!entry) {
    const found = findImages(output)
    if (found.length === 0) return null
    load($, cache, id, found)
    entry = cache.get(id)!
  }

  const { Box, Text, Image } = ui as any
  if (entry.state === 'pending') {
    return <Text key={`${id}-status`} dimColor>  ⎿ loading image…</Text>
  }
  if (entry.state === 'failed') {
    return <Text key={`${id}-status`} dimColor>  ⎿ image not shown: {entry.reason}</Text>
  }

  const maxCols = Math.max(10, Math.min(fit.columns, termCols - 6))
  const sized = entry.images.map(img => {
    // Terminal cells are about twice as tall as they are wide.
    let columns = Math.min(maxCols, Math.max(1, Math.round(img.width / 8)))
    let rows = Math.round((columns * img.height) / img.width / 2)
    if (rows > fit.rows) {
      rows = fit.rows
      columns = Math.max(1, Math.round((rows * 2 * img.width) / img.height))
    }
    return { img, columns, rows: Math.max(1, rows) }
  })
  const picture = ({ img, columns, rows }: (typeof sized)[number], i: number) => (
    <Image
      key={`${id}-img-${i}`}
      source={{ png: img.png }}
      columns={columns}
      rows={rows}
      alt={`[image ${img.width}×${img.height}]`}
    />
  )

  if (!fit.inRow) {
    return sized.map((s, i) => (
      <Box key={`${id}-box-${i}`} paddingLeft={fit.indent}>
        {picture(s, i)}
      </Box>
    ))
  }

  // Side by side: as many per row as the terminal's width allows.
  const room = termCols - fit.indent - 2
  const lines: { s: (typeof sized)[number]; i: number }[][] = [[]]
  let used = 0
  sized.forEach((s, i) => {
    const line = lines[lines.length - 1]!
    const need = (line.length > 0 ? ROW_GAP : 0) + s.columns
    if (line.length > 0 && used + need > room) {
      lines.push([{ s, i }])
      used = s.columns
    } else {
      line.push({ s, i })
      used += need
    }
  })
  return lines.map((line, r) => (
    <Box key={`${id}-row-${r}`} flexDirection="row" paddingLeft={fit.indent} gap={ROW_GAP}>
      {line.map(({ s, i }) => picture(s, i))}
    </Box>
  ))
}

// Mods get no message id, so a pasted image is tied to its message by the text. The exact
// text comes first (its [Image #N] chips number up through the session, so they tell
// image-only messages apart); the text without chips is the fallback, in case the row
// and the submission spell the chips differently.
function exactKey(text: string): string {
  return 'paste=' + text.trim()
}
function looseKey(text: string): string {
  return 'paste~' + text.replace(/\[Image #\d+\]/g, ' ').replace(/\s+/g, ' ').trim()
}

// Reads one attachment of the prompt being submitted, joining the engine's 4 MiB slices.
async function readMedia($: EngineInterface, id: string): Promise<Found | undefined> {
  let base64 = '', mime = '', offset: number | undefined
  do {
    const media = await $.prompt.media(offset === undefined ? { id } : { id, offset })
    if (media.base64 === undefined || media.type !== 'image') return undefined
    base64 += media.base64
    mime = media.mediaType
    offset = media.next
  } while (offset !== undefined)
  return { base64, mime }
}

export const register: Register = on => {
  const cache = new Map<string, Entry>()

  // A prompt with pasted images: read their bytes while the submission is in flight,
  // then convert them in the background so sending isn't held up.
  on('prompt.submit', async ($, e, next) => {
    const ids = (e.attachments ?? []).filter(a => a.type === 'image' && a.id).map(a => a.id!)
    if (ids.length > 0) {
      try {
        const found: Found[] = []
        for (const id of ids.slice(0, MAX_IMAGES_PER_CALL)) {
          const image = await readMedia($, id)
          if (image) found.push(image)
        }
        if (found.length > 0) load($, cache, [exactKey(e.text), looseKey(e.text)], found)
      } catch {
        // Never block a prompt over a thumbnail.
      }
    }
    return next(e)
  })

  // Your message in the transcript: draw its pasted images under it.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const row = await next(e)
    if (e.surface !== 'terminal') return row
    const exact = exactKey(e.props.text)
    const key = cache.has(exact) ? exact : looseKey(e.props.text)
    if (!cache.has(key)) return row
    const extra = imagesFor($, $.ui.resolve(e), cache, key, undefined, e.viewport?.columns ?? 80, PASTE_FIT)
    if (extra === null) return row
    const { Box } = $.ui.resolve(e)
    return <Box flexDirection="column">{row}{extra}</Box>
  })

  // A tool call drawn as its own row.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const row = await next(e)
    if (e.surface !== 'terminal' || e.props.isRunning || e.props.output === undefined) return row
    const extra = imagesFor($, $.ui.resolve(e), cache, e.props.tool_use_id, e.props.output, e.viewport?.columns ?? 80)
    if (extra === null) return row
    const { Box } = $.ui.resolve(e)
    return <Box flexDirection="column">{row}{extra}</Box>
  })

  // Reads and searches folded into one line ("Read 1 file"): draw their images under it.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const row = await next(e)
    if (e.surface !== 'terminal' || e.props.isExpanded) return row
    const ui = $.ui.resolve(e)
    const cols = e.viewport?.columns ?? 80
    const withImages: string[] = []
    const extras = e.props.calls.flatMap((call, i) => {
      if (call.isRunning || call.output === undefined) return []
      const id = call.tool_use_id ?? `group-${i}-${call.tool}`
      const found = imagesFor($, ui, cache, id, call.output, cols)
      if (found === null) return []
      withImages.push(id)
      return [found].flat()
    })
    if (extras.length === 0) return row
    const { Box } = ui

    // Once every call's images are ready, lay them all in one row instead of a row per call.
    const entries = withImages.map(id => cache.get(id))
    if (withImages.length > 1 && entries.every(en => en?.state === 'ready')) {
      const images = entries.flatMap(en => (en?.state === 'ready' ? en.images : []))
      const key = `group:${withImages.join('|')}`
      cache.set(key, { state: 'ready', images })
      return <Box flexDirection="column">{row}{imagesFor($, ui, cache, key, undefined, cols)}</Box>
    }
    return <Box flexDirection="column">{row}{extras}</Box>
  })
}
