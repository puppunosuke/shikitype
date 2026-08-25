// Unicode→LaTeX変換テーブル（自前実装）
// 3F7B項目4の実測どおり、MathLiveはUnicode記号を自動変換しない（貼っても\intにならずリテラル文字のまま残る）ため、
// 自前のテーブルで変換してから流し込む。ペースト（Ctrl+V）経路で使う。

export const UNICODE_TO_LATEX = {
  '∫': '\\int ',
  'Σ': '\\sum ',
  'Π': '\\prod ',
  '√': '\\sqrt',
  'π': '\\pi ',
  '∞': '\\infty ',
  '→': '\\to ',
  '·': '\\cdot ',
  '×': '\\times ',
  '÷': '\\div ',
  '≦': '\\leqq ',
  '≧': '\\geqq ',
  '≠': '\\ne ',
  '≤': '\\le ',
  '≥': '\\ge ',
  '±': '\\pm ',
  '≒': '\\approx ',
  '≡': '\\equiv ',
  '∈': '\\in ',
  '∉': '\\notin ',
  '⊂': '\\subset ',
  '⊃': '\\supset ',
  '∪': '\\cup ',
  '∩': '\\cap ',
  '∅': '\\emptyset ',
  '∀': '\\forall ',
  '∃': '\\exists ',
  '⇒': '\\Rightarrow ',
  '⇔': '\\Leftrightarrow ',
  '∧': '\\wedge ',
  '∨': '\\vee ',
  '¬': '\\neg ',
  '∠': '\\angle ',
  '△': '\\triangle ',
  '⊥': '\\perp ',
  '∥': '\\parallel ',
  '°': '^\\circ ',
  '≅': '\\cong ',
  '∽': '\\backsim ',
  '∂': '\\partial ',
  'α': '\\alpha ', 'β': '\\beta ', 'γ': '\\gamma ', 'δ': '\\delta ',
  'θ': '\\theta ', 'λ': '\\lambda ', 'μ': '\\mu ', 'σ': '\\sigma ',
  'φ': '\\phi ', 'ψ': '\\psi ', 'ω': '\\omega ',
  'Γ': '\\Gamma ', 'Δ': '\\Delta ', 'Θ': '\\Theta ', 'Λ': '\\Lambda ',
  'Φ': '\\Phi ', 'Ψ': '\\Psi ', 'Ω': '\\Omega ',
};

/** Unicode記号を含む文字列をLaTeXコマンド列へ変換する。テーブルに無い文字はそのまま通す。 */
export function convertUnicodeToLatex(text) {
  let out = '';
  for (const ch of text) {
    out += UNICODE_TO_LATEX[ch] ?? ch;
  }
  return out;
}
