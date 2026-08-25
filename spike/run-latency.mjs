import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.goto('http://localhost:8891/spike/test.html');
await p.waitForFunction(() => window.__ready === true);
await p.waitForTimeout(200);

// Build ~50-token and ~200-token expressions by repeating a unit.
function buildExpr(tokens) {
  // one unit ~= 5 tokens: "+x^{2}" roughly
  const unitCount = Math.floor(tokens / 5);
  let s = 'y=';
  for (let i = 0; i < unitCount; i++) s += `+x_{${i}}^{2}`;
  return s;
}

async function measureReinjectLatency(latex, iterations) {
  return p.evaluate(({ latex, iterations }) => {
    const mf = document.getElementById('mf1');
    mf.value = latex;
    const times = [];
    // Simulate real per-keystroke re-injection: each "keystroke" appends one
    // character to the LaTeX source (forcing an actual reparse+re-render,
    // not a no-op), then we restore the caret position. This is the realistic
    // shape of the fallback strategy (re-inject whole string on every key).
    let current = latex;
    for (let i = 0; i < iterations; i++) {
      const nextLatex = current + (i % 2 === 0 ? 'x' : 'y'); // force a real diff each time
      const pos = mf.position;
      const t0 = performance.now();
      mf.setValue(nextLatex, { silenceNotifications: true });
      mf.position = Math.min(pos + 1, mf.lastOffset);
      // force layout/paint to flush so we measure real re-render cost, not just JS scheduling
      void mf.getBoundingClientRect().height;
      const t1 = performance.now();
      times.push(t1 - t0);
      current = nextLatex;
    }
    times.sort((a, b) => a - b);
    const sum = times.reduce((a, c) => a + c, 0);
    return {
      tokenCountApprox: latex.length,
      iterations,
      meanMs: sum / times.length,
      medianMs: times[Math.floor(times.length / 2)],
      p95Ms: times[Math.floor(times.length * 0.95)],
      maxMs: times[times.length - 1],
    };
  }, { latex, iterations });
}

const expr50 = buildExpr(50);
const expr200 = buildExpr(200);
const r50 = await measureReinjectLatency(expr50, 100);
const r200 = await measureReinjectLatency(expr200, 100);
console.log('EXPR50_LEN', expr50.length, JSON.stringify(r50, null, 2));
console.log('EXPR200_LEN', expr200.length, JSON.stringify(r200, null, 2));

await b.close();
