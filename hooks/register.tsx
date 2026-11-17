import type { EngineInterface, Register } from 'claude-code'

// Largest decoded PNG an <Image> accepts from bytes.
const MAX_PNG_BYTES = 2 * 1024 * 1024
// Longest edge in pixels when an image has to be converted or shrunk.
const MAX_EDGE = 1600
const MAX_IMAGES_PER_CALL = 4
const MAX_COLUMNS = 100
const MAX_ROWS = 40

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

function load($: EngineInterface, cache: Map<string, Entry>, id: string, found: Found[]) {
  cache.set(id, { state: 'pending' })
  void Promise.all(found.map(f => prepare($, f)))
    .then(images => cache.set(id, { state: 'ready', images }))
    .catch((err: unknown) => cache.set(id, { state: 'failed', reason: err instanceof Error ? err.message : String(err) }))
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

  const maxCols = Math.max(10, Math.min(MAX_COLUMNS, termCols - 6))
  return entry.images.map((img, i) => {
    // Terminal cells are about twice as tall as they are wide.
    let columns = Math.min(maxCols, Math.max(1, Math.round(img.width / 8)))
    let rows = Math.round((columns * img.height) / img.width / 2)
    if (rows > MAX_ROWS) {
      rows = MAX_ROWS
      columns = Math.max(1, Math.round((rows * 2 * img.width) / img.height))
    }
    return (
      <Box key={`${id}-box-${i}`} paddingLeft={5}>
        <Image
          key={`${id}-img-${i}`}
          source={{ png: img.png }}
          columns={columns}
          rows={Math.max(1, rows)}
          alt={`[image ${img.width}×${img.height}]`}
        />
      </Box>
    )
  })
}

export const register: Register = on => {
  const cache = new Map<string, Entry>()

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
    const extras = e.props.calls.flatMap((call, i) => {
      if (call.isRunning || call.output === undefined) return []
      const found = imagesFor($, ui, cache, call.tool_use_id ?? `group-${i}-${call.tool}`, call.output, e.viewport?.columns ?? 80)
      return found === null ? [] : [found].flat()
    })
    if (extras.length === 0) return row
    const { Box } = ui
    return <Box flexDirection="column">{row}{extras}</Box>
  })
}
