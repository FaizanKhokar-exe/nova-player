import { describe, expect, it } from 'vitest';
import { isRtlText } from './rtl.js';

describe('isRtlText', () => {
  it('knows Urdu, Arabic, Persian and Hebrew', () => {
    expect(isRtlText('میں تم سے پیار کرتا ہوں')).toBe(true);
    expect(isRtlText('أحبك كثيرا')).toBe(true);
    expect(isRtlText('دوستت دارم')).toBe(true);
    expect(isRtlText('אני אוהב אותך')).toBe(true);
  });
  it('knows left-to-right scripts, Roman Urdu and plain symbols', () => {
    expect(isRtlText('I love you')).toBe(false);
    expect(isRtlText('main tumse pyar karta hoon')).toBe(false);
    expect(isRtlText('मैं तुमसे प्यार करता हूँ')).toBe(false);
    expect(isRtlText('♪ ♪ ♪')).toBe(false);
    expect(isRtlText('')).toBe(false);
  });
  it('follows the first letter, ignoring leading digits, quotes and punctuation', () => {
    expect(isRtlText('"... 123 تم"')).toBe(true);
    expect(isRtlText('(1) Hello مرحبا')).toBe(false);
  });
});
