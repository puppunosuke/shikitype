import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto("http://127.0.0.1:8765/neo-math-app-sss-concepts.html", { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);
const out = [];
for (let i = 0; i < 18; i++) {
  await page.click(`.choice[data-i="${i}"]`);
  await page.evaluate(() => document.fonts.ready);
  const r = await page.evaluate(() => {
    const frame = document.querySelector("#nma-screen .appframe");
    const theme = [...frame.classList].find((c) => /^t\d+$/.test(c));
    const probe = (sel) => {
      const el = frame.querySelector(sel);
      if (!el || !el.textContent.trim()) return null;
      const cs = getComputedStyle(el);
      const fam = cs.fontFamily.split(",")[0].replace(/"/g, "");
      const c = document.createElement("canvas").getContext("2d");
      const text = el.textContent.trim().slice(0, 30);
      c.font = `${cs.fontWeight} 40px "${fam}"`;
      const withFont = c.measureText(text).width;
      c.font = `${cs.fontWeight} 40px monospace`;
      const fallback = c.measureText(text).width;
      return { fam, text, applied: Math.abs(withFont - fallback) > 0.5 };
    };
    return { theme, brand: probe(".brand"), jp: probe(".problem") || probe(".course"), math: probe(".math") };
  });
  out.push(r);
}
const bad = [];
for (const r of out) for (const k of ["brand","jp","math"]) {
  if (r[k] && !r[k].applied) bad.push(`${r.theme}.${k}(${r[k].fam})`);
}
console.log("指定書体で描かれていない要素: " + (bad.length ? bad.join(", ") : "なし"));
console.log("和文の実書体: " + out.map(r => `${r.theme}=${r.jp ? r.jp.fam : "-"}`).join(" "));
await browser.close();
