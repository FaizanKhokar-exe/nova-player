/** Letters of right-to-left scripts: Hebrew, Arabic (and so Urdu, Persian, Pashto, Sindhi), Syriac, Thaana, N'Ko, and their presentation forms. */
const RTL_LETTER = new RegExp('[\\u0590-\\u08FF\\uFB1D-\\uFDFF\\uFE70-\\uFEFF]', 'u');
const LATIN_LETTER = /\p{Script=Latin}|\p{Script=Devanagari}|\p{Script=Gurmukhi}|\p{Script=Han}|\p{Script=Hangul}|\p{Script=Hiragana}|\p{Script=Katakana}/u;

/** Reads left to right or right to left, by the FIRST letter that has a direction (like the browser's `dir="auto"`, but available to code). */
export function isRtlText(text: string): boolean {
  for (const ch of text) {
    if (RTL_LETTER.test(ch)) return true;
    if (LATIN_LETTER.test(ch)) return false;
  }
  return false;
}
