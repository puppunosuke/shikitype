import { chromium } from "playwright";

const URL = "http://127.0.0.1:8765/neo-math-app-sss-concepts.html";
const N = 18;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(URL, { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);

// 書体のロード確認は、その案を表示したあとに、その案が実際に使う書体とウェイトで行う。
// 全案ぶんを最初にまとめて聞くと、まだ画面に無い案の書体は未ロードで false が返り、
// 不具合と読み違える（前回この artifact で誤読した）。

const rows = [];
for (let i = 0; i < N; i++) {
  await page.click(`.choice[data-i="${i}"]`);
  await page.evaluate(() => document.fonts.ready);
  const r = await page.evaluate(() => {
    const pick = (sel) => {
      const el = document.querySelector(`#nma-screen ${sel}`);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        family: cs.fontFamily.split(",")[0].replace(/"/g, ""),
        weight: cs.fontWeight,
        size: Math.round(parseFloat(cs.fontSize)),
        tracking: cs.letterSpacing,
        // 判定にはその要素が実際に表示している文字を渡す。和文書体はGoogle Fontsが
        // 文字範囲ごとに分割配信するため、文字を渡さないと既定の判定文字で誤判定する。
        text: (el.textContent || "").slice(0, 40),
      };
    };
    const frame = document.querySelector("#nma-screen .appframe");
    const brand = pick(".brand"), math = pick(".math"), jp = pick(".problem") || pick(".course");
    // この案が実際に指定している書体＋ウェイトが読めているか
    const usable = [brand, math, jp].filter(Boolean)
      .filter((f) => !document.fonts.check(`${f.weight} 16px "${f.family}"`, f.text || "A"))
      .map((f) => `${f.family} ${f.weight}`);
    return {
      theme: [...frame.classList].find((c) => /^t\d+$/.test(c)),
      brand, math, jp, unloaded: usable,
      keySymbol: pick(".key em"),
      keyLetter: pick(".key b"),
    };
  });
  rows.push(r);
}

console.log("\ntheme  brand(family/w/size)            math(family/w/size)          和文            key記号/元キー");
for (const r of rows) {
  console.log(
    `${r.theme.padEnd(5)} ${(r.brand.family + "/" + r.brand.weight + "/" + r.brand.size).padEnd(32)} ` +
    `${(r.math.family + "/" + r.math.weight + "/" + r.math.size).padEnd(28)} ` +
    `${(r.jp ? r.jp.family : "-").padEnd(15)} ` +
    `${r.keySymbol.size}px / ${r.keyLetter.size}px`
  );
}

const brandFamilies = new Set(rows.map((r) => r.brand.family));
const jpFamilies = new Set(rows.filter((r) => r.jp).map((r) => r.jp.family));
console.log(`\ndistinct brand families: ${brandFamilies.size} / 和文 families: ${jpFamilies.size}`);

const unloaded = rows.flatMap((r) => r.unloaded.map((u) => `${r.theme}:${u}`));
console.log(`表示後も読めていない書体: ${unloaded.length ? unloaded.join(", ") : "なし"}`);

const badKeys = rows.filter((r) => r.keySymbol.size <= r.keyLetter.size).map((r) => r.theme);
console.log(`記号が元キーより小さい案: ${badKeys.length ? badKeys.join(",") : "なし"}`);

// 3幅で、はみ出しと文字の切れを実測する
for (const width of [1280, 760, 380]) {
  await page.setViewportSize({ width, height: 900 });
  const bad = [];
  for (let i = 0; i < N; i++) {
    await page.click(`.choice[data-i="${i}"]`);
    await page.evaluate(() => document.fonts.ready);
    const issues = await page.evaluate(() => {
      const out = [];
      const frame = document.querySelector("#nma-screen .appframe");
      const fb = frame.getBoundingClientRect();
      const theme = [...frame.classList].find((c) => /^t\d+$/.test(c));
      for (const sel of [".brand", ".math", ".course", ".guide-head strong"]) {
        for (const el of frame.querySelectorAll(sel)) {
          const b = el.getBoundingClientRect();
          if (b.width === 0) continue;
          const over = Math.round(Math.max(b.right - fb.right, fb.left - b.left));
          if (over > 1) out.push(`${theme}${sel}+${over}px`);
        }
      }
      return out;
    });
    bad.push(...issues);
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  console.log(`@${width}: 横はみ出し=${overflow} / 枠外へ出た文字=${bad.length ? bad.join(", ") : "なし"}`);
}

await page.setViewportSize({ width: 1280, height: 900 });
await page.click('.choice[data-i="0"]');
await page.screenshot({ path: "F:/12_Claude/Claude/.tmp/sss-t1.png" });
await page.click('.choice[data-i="17"]');
await page.screenshot({ path: "F:/12_Claude/Claude/.tmp/sss-t18.png" });
await page.click('.choice[data-i="13"]');
await page.screenshot({ path: "F:/12_Claude/Claude/.tmp/sss-t14.png" });

await browser.close();
