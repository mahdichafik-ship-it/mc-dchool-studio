import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const desktopRoot = resolve(import.meta.dirname, '..')
const assetsDir = join(desktopRoot, 'out/renderer/assets')
const cssAsset = readdirSync(assetsDir).find((name) => /^index-.*\.css$/.test(name))
assert.ok(cssAsset, 'renderer build must expose its compiled stylesheet')
const css = readFileSync(join(assetsDir, cssAsset), 'utf8')
const chromium = '/repl/tools/bin/chromium'
const temp = mkdtempSync(join(tmpdir(), 'shoot-layout-'))

const viewports = [
  { width: 1024, height: 700 },
  { width: 1280, height: 800 },
]

function toolbar() {
  return `<header class="shoot-toolbar bg-slate-950 border-b px-6 py-3 shrink-0 flex flex-wrap items-center justify-between gap-y-3">
    <div class="flex items-center gap-5 min-w-0"><button aria-label="Back to projects">Back</button><h1 class="font-extrabold text-white">Volume Capture</h1></div>
    <div class="flex items-center gap-4 shrink-0">
      <div data-testid="shoot-watch-status" class="flex items-center h-8 rounded-md border px-3 text-white"><button>Live · Stop</button></div>
      <button class="shoot-secondary-action">Consolidate folders</button>
      <div class="flex items-center gap-2">
        <button>Live Upload On</button>
        <div class="shoot-secondary-action"><button>JPEG Only · Export · To LR</button></div>
        <button>Upload 999</button>
        <button data-testid="shoot-primary-action">Retry Upload &amp; Finish</button>
      </div>
    </div>
  </header>`
}

function studentFixture() {
  return `<main class="shoot-workspace flex flex-col h-full bg-slate-50">
    ${toolbar()}
    <div class="flex-1 flex overflow-hidden">
      <aside style="width:340px;flex:none"></aside>
      <section class="flex-1 min-w-0 flex flex-col">
        <div class="shoot-subject-header bg-white border-b px-8 py-6 flex flex-wrap gap-4 justify-between items-start shrink-0">
          <h2 class="shoot-subject-name text-4xl font-extrabold break-words">Alexandria-Cassandra Montgomery-Worthington The Third</h2>
          <button>Clear Target</button>
        </div>
        <div class="flex-1 overflow-y-auto p-4">
          <div class="shoot-capture-area min-w-0 flex flex-col gap-3">
            <div class="grid min-w-0 grid-cols-1 gap-3">
              <div class="shoot-preview relative flex min-h-[220px] max-h-[430px] overflow-hidden bg-slate-950"><div>Live Preview</div></div>
            </div>
            <div data-testid="shoot-completeness" class="shoot-completeness grid grid-cols-5 gap-2 border bg-white p-3">
              <span>Pairing: JPEG only</span><span>Upload: Queued</span><button>Edit framing</button>
            </div>
          </div>
        </div>
      </section>
    </div>
  </main>`
}

function groupFixture() {
  return `<main class="shoot-workspace flex flex-col h-full bg-slate-50">
    ${toolbar()}
    <div class="flex-1 flex overflow-hidden">
      <aside style="width:340px;flex:none"></aside>
      <section class="flex-1 min-w-0 flex flex-col">
        <div class="shoot-subject-header bg-white border-b px-8 py-6 flex flex-wrap gap-4 justify-between items-start shrink-0">
          <h2 class="shoot-subject-name text-4xl font-extrabold break-words">Whole School Panoramic Group With A Very Long Descriptive Name</h2>
          <button>Clear Target</button>
        </div>
        <div class="flex-1 overflow-y-auto p-8">
          <div class="shoot-group-body max-w-[1400px] mx-auto flex flex-col gap-8">
            <div><div class="bg-white border p-4">Group roster<br>Student one<br>Student two</div></div>
            <div class="shoot-capture-area flex-1 min-w-0 flex flex-col gap-4">
              <div class="flex justify-between"><strong>Group Captures</strong><button>Refresh</button></div>
              <div class="border bg-white p-4 flex flex-col gap-4">
                <div class="shoot-preview overflow-hidden bg-slate-950">Live group capture</div>
                <span data-testid="shoot-completeness" class="shoot-completeness">JPEG + RAW · Uploaded</span>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  </main>`
}

function assertionsScript() {
  return `<script>
    const selectors = ['[data-testid="shoot-watch-status"]','[data-testid="shoot-primary-action"]','.shoot-subject-name','.shoot-capture-area','[data-testid="shoot-completeness"]'];
    const boxes = Object.fromEntries(selectors.map(selector => [selector, document.querySelector(selector).getBoundingClientRect()]));
    const preview = document.querySelector('.shoot-preview').getBoundingClientRect();
    const completeness = boxes['[data-testid="shoot-completeness"]'];
    const visible = Object.values(boxes).every(box => box.top >= 0 && box.left >= 0 && box.bottom <= innerHeight && box.right <= innerWidth);
    const noOverlap = preview.bottom <= completeness.top;
    const noHorizontalOverflow = document.documentElement.scrollWidth <= innerWidth;
    document.body.dataset.result = visible && noOverlap && noHorizontalOverflow ? 'PASS' : JSON.stringify({ visible, noOverlap, noHorizontalOverflow, innerWidth, innerHeight, boxes, preview });
  </script>`
}

try {
  for (const viewport of viewports) {
    for (const [state, fixture] of [['student', studentFixture], ['group', groupFixture]]) {
      const file = join(temp, `${state}-${viewport.width}x${viewport.height}.html`)
      writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}button{min-height:32px}</style></head><body>${fixture()}${assertionsScript()}</body></html>`)
      const output = execFileSync(chromium, [
        '--headless',
        '--no-sandbox',
        '--disable-gpu',
        `--window-size=${viewport.width},${viewport.height}`,
        '--dump-dom',
        `file://${file}`,
      ], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] })
      const result = output.match(/data-result="([^"]+)"/)?.[1]
      assert.equal(result, 'PASS', `${state} layout failed at ${viewport.width}x${viewport.height}: ${result}`)
    }
  }
  console.log('Rendered shoot workspace layouts pass at 1024×700 and 1280×800')
} finally {
  rmSync(temp, { recursive: true, force: true })
}