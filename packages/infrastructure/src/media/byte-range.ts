/** Inclusive byte range, as HTTP Range semantics define it. */
export type ByteRangeResult =
  | { kind: 'single'; start: number; end: number }
  | { kind: 'unsatisfiable' }
  | { kind: 'unsupported' };

/**
 * Parses a single HTTP `Range` header value against a known total resource
 * size. Pure (no I/O) so every edge case can be unit-tested directly.
 *
 * Supports the three forms RFC 9110 defines for a byte range:
 *   - `bytes=START-END`   (bounded)
 *   - `bytes=START-`      (open-ended, "from START to EOF")
 *   - `bytes=-SUFFIX`     (suffix, "the last SUFFIX bytes")
 *
 * - The unit name is case-insensitive (`Bytes=0-9` is a byte range).
 * - A unit other than `bytes`, and multi-range requests, are 'unsupported':
 *   a server may ignore a Range it cannot satisfy exactly as one range and
 *   answer with the whole resource.
 * - A `bytes=` value that is not a valid range at all (`bytes=abc`, `bytes=-`,
 *   `bytes=5-2`, a start at/after EOF, a zero-length suffix, an empty file)
 *   is 'unsatisfiable' (HTTP 416) - this project's chosen reading of "a server
 *   MAY ignore or reject an invalid ranges-specifier".
 * - An end beyond EOF is clamped to the last byte, not an error.
 */
export function parseByteRange(rangeHeader: string, totalSize: number): ByteRangeResult {
  const match = /^bytes=(.+)$/i.exec(rangeHeader.trim());
  if (!match) return { kind: 'unsupported' };

  const spec = match[1]?.trim() ?? '';
  if (spec.includes(',')) return { kind: 'unsupported' };

  const rangeMatch = /^(\d*)-(\d*)$/.exec(spec);
  if (!rangeMatch) return { kind: 'unsatisfiable' };

  const [, startStr, endStr] = rangeMatch;
  if (startStr === '' && endStr === '') return { kind: 'unsatisfiable' };

  if (totalSize === 0) {
    // An empty file has no satisfiable byte range at all.
    return { kind: 'unsatisfiable' };
  }

  let start: number;
  let end: number;

  if (startStr === '') {
    // Suffix range: "the last N bytes".
    const suffixLength = Number(endStr);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { kind: 'unsatisfiable' };
    start = Math.max(0, totalSize - suffixLength);
    end = totalSize - 1;
  } else {
    start = Number(startStr);
    end = endStr === '' ? totalSize - 1 : Number(endStr);
  }

  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end) {
    return { kind: 'unsatisfiable' };
  }
  if (start >= totalSize) return { kind: 'unsatisfiable' };

  // A range extending beyond EOF is clamped to the actual end of the resource.
  end = Math.min(end, totalSize - 1);

  return { kind: 'single', start, end };
}
