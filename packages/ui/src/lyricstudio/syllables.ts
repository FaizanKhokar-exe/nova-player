/**
 * How long a line of lyrics takes to sing, in "syllable units", for any script. This is an ESTIMATE used to share
 * the singing time between lines; it is deliberately simple per script and never claims linguistic accuracy.
 */

type Script = 'latin' | 'cyrillic' | 'greek' | 'devanagari' | 'gurmukhi' | 'arabic' | 'cjk' | 'hangul' | 'other';

function scriptOf(code: number): Script | undefined {
  if (code < 0x80) return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) ? 'latin' : undefined;
  if ((code >= 0xc0 && code <= 0x24f) || (code >= 0x1e00 && code <= 0x1eff)) return 'latin';
  if (code >= 0x370 && code <= 0x3ff) return 'greek';
  if (code >= 0x400 && code <= 0x52f) return 'cyrillic';
  if ((code >= 0x600 && code <= 0x6ff) || (code >= 0x750 && code <= 0x77f) || (code >= 0xfb50 && code <= 0xfdff) || (code >= 0xfe70 && code <= 0xfeff)) return 'arabic';
  if (code >= 0x900 && code <= 0x97f) return 'devanagari';
  if (code >= 0xa00 && code <= 0xa7f) return 'gurmukhi';
  if ((code >= 0x3040 && code <= 0x30ff) || (code >= 0x3400 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff)) return 'cjk';
  if (code >= 0xac00 && code <= 0xd7af) return 'hangul';
  if (/\p{L}/u.test(String.fromCodePoint(code))) return 'other';
  return undefined;
}

const LATIN_VOWELS = new Set('aeiouyàáâãäåæèéêëìíîïòóôõöøùúûüýÿœāēīōūăĕĭŏŭ'.split(''));
const CYRILLIC_VOWELS = new Set('аеёиоуыэюяіїє'.split(''));
const GREEK_VOWELS = new Set('αεηιουωάέήίόύώ'.split(''));

function vowelGroups(word: string, vowels: ReadonlySet<string>): number {
  let groups = 0;
  let inside = false;
  for (const ch of word.toLowerCase()) {
    const isVowel = vowels.has(ch);
    if (isVowel && !inside) groups += 1;
    inside = isVowel;
  }
  // No "silent final e" rule: in Roman Urdu / Hindi (tere, mujhe, kaise) the final e IS sung, and over-counting an English
  // "love" by one beat costs far less than merging a real syllable of another language.
  return groups;
}

/** Indic scripts: one beat per consonant or independent vowel, minus consonants joined to the next by a virama. */
function indicBeats(run: string, script: 'devanagari' | 'gurmukhi'): number {
  let beats = 0;
  for (const ch of run) {
    const c = ch.codePointAt(0) ?? 0;
    if (script === 'devanagari') {
      if ((c >= 0x915 && c <= 0x939) || (c >= 0x958 && c <= 0x95f) || (c >= 0x904 && c <= 0x914) || c === 0x960 || c === 0x961) beats += 1;
      else if (c === 0x94d) beats -= 1;
    } else {
      if ((c >= 0xa15 && c <= 0xa39) || (c >= 0xa59 && c <= 0xa5e) || (c >= 0xa05 && c <= 0xa14)) beats += 1;
      else if (c === 0xa4d) beats -= 1;
    }
  }
  return Math.max(1, beats);
}

/** Splits a line into runs of one script; letters of other scripts are measured by their own rule. */
export function countSyllables(text: string): number {
  let total = 0;
  let run = '';
  let runScript: Script | undefined;
  const flush = (): void => {
    if (run === '' || runScript === undefined) {
      run = '';
      return;
    }
    switch (runScript) {
      case 'latin':
        for (const word of run.split(/[^\p{L}\p{M}]+/u)) if (word !== '') total += Math.max(1, vowelGroups(word.normalize('NFC'), LATIN_VOWELS));
        break;
      case 'cyrillic':
        for (const word of run.split(/[^\p{L}\p{M}]+/u)) if (word !== '') total += Math.max(1, vowelGroups(word, CYRILLIC_VOWELS));
        break;
      case 'greek':
        for (const word of run.split(/[^\p{L}\p{M}]+/u)) if (word !== '') total += Math.max(1, vowelGroups(word, GREEK_VOWELS));
        break;
      case 'devanagari':
      case 'gurmukhi':
        for (const word of run.split(/[^\p{L}\p{M}]+/u)) if (word !== '') total += indicBeats(word, runScript);
        break;
      case 'arabic': {
        // Urdu / Arabic / Persian are written without most short vowels: about 1.6 letters per sung beat.
        for (const word of run.split(/[^\p{L}]+/u)) {
          const letters = [...word].filter((ch) => /\p{L}/u.test(ch)).length;
          if (letters > 0) total += Math.max(1, letters / 1.6);
        }
        break;
      }
      case 'cjk':
      case 'hangul':
        total += [...run].filter((ch) => /\p{L}/u.test(ch)).length;
        break;
      case 'other':
        for (const word of run.split(/[^\p{L}\p{M}]+/u)) if (word !== '') total += Math.max(1, [...word].length / 2.5);
        break;
    }
    run = '';
  };
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const script = scriptOf(code);
    if (script === undefined) {
      // combining marks / virama / ZWJ belong to the current run; anything else ends a word
      if (/\p{M}/u.test(ch) || code === 0x200c || code === 0x200d) {
        run += ch;
        continue;
      }
      run += ' ';
      continue;
    }
    if (runScript !== undefined && script !== runScript) flush();
    runScript = script;
    run += ch;
  }
  flush();
  return total;
}

/** The weight of one line when sharing singing time: syllables plus a small fixed cost for taking a breath and starting. */
export function lineWeight(text: string): number {
  return Math.max(1, countSyllables(text)) + 0.35;
}
