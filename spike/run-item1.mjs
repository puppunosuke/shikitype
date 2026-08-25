// Item 1: total key capture — can a document-level capture-phase handler
// suppress ALL of MathLive's default key handling, including leak paths
// (paste, IME composition)?
import { chromium } from 'playwright';

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
const ctx = p.context();
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://localhost:8891' });

await p.goto('http://localhost:8891/spike/test.html');
await p.waitForFunction(() => window.__ready === true);
await p.waitForTimeout(200);

async function focusReset() {
  await p.evaluate(() => { document.getElementById('mf1').value = ''; });
  await p.evaluate(() => document.getElementById('mf1').focus());
  await p.waitForTimeout(100);
}

async function getVal() {
  return p.evaluate(() => document.getElementById('mf1').value);
}

const results = {};

// --- baseline: without capture, typing works ---
await focusReset();
await p.keyboard.type('ab');
results.baseline_no_capture = await getVal();

// --- with capture: normal letters should be fully suppressed ---
await focusReset();
await p.evaluate(() => window.enableCapture());
await p.evaluate(() => window.clearLog());
await p.keyboard.type('ab');
results.letters_with_capture = await getVal();
results.letters_log_count = (await p.evaluate(() => window.getLog())).length;

// --- with capture: space (critical key) inside a fraction denominator ---
await focusReset();
await p.evaluate(() => { document.getElementById('mf1').value = ''; document.getElementById('mf1').focus(); });
await p.waitForTimeout(100);
await p.evaluate(() => window.disableCapture());
await p.keyboard.type('1/2'); // build \frac1{2} via real keystrokes, cursor ends inside/after denominator
const beforeSpace = await p.evaluate(() => ({ value: document.getElementById('mf1').value, pos: document.getElementById('mf1').position }));
await p.evaluate(() => window.enableCapture());
await p.keyboard.press('Space');
const afterSpace = await p.evaluate(() => ({ value: document.getElementById('mf1').value, pos: document.getElementById('mf1').position }));
results.space_before = beforeSpace;
results.space_after_with_capture = afterSpace;
results.space_suppressed = beforeSpace.value === afterSpace.value && beforeSpace.pos === afterSpace.pos;

// --- paste leak test: capture enabled, try Ctrl+V ---
await focusReset();
await p.evaluate(() => window.enableCapture());
await p.evaluate(async () => { await navigator.clipboard.writeText('999'); });
await p.keyboard.press('Control+v');
await p.waitForTimeout(150);
results.paste_value_with_capture = await getVal();
results.paste_leaked = results.paste_value_with_capture !== '';

// --- IME composition leak test: dispatch composition+input events directly on the keyboard-sink,
// bypassing keydown entirely (capture handler only listens to keydown) ---
await focusReset();
await p.evaluate(() => window.enableCapture());
const imeResult = await p.evaluate(() => {
  const mf = document.getElementById('mf1');
  const sink = mf.shadowRoot.querySelector('.ML__keyboard-sink');
  const log = [];
  function fire(type, opts) {
    const Ctor = type.startsWith('composition') ? CompositionEvent : InputEvent;
    const e = new Ctor(type, { bubbles: true, cancelable: true, composed: true, ...opts });
    const notCancelled = sink.dispatchEvent(e);
    log.push({ type, notCancelled });
  }
  fire('compositionstart', { data: '' });
  fire('compositionupdate', { data: 'あ' });
  fire('input', { inputType: 'insertCompositionText', data: 'あ' });
  fire('compositionend', { data: 'あ' });
  return { log, valueAfter: mf.value };
});
results.ime_synthetic_dispatch = imeResult;

// --- disable capture, sanity restore ---
await p.evaluate(() => window.disableCapture());

console.log(JSON.stringify(results, null, 2));
await b.close();
