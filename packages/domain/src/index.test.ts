import { describe, expect, it } from 'vitest';
import { sortTrackSummariesByTitle } from './index.js';

describe('sortTrackSummariesByTitle', () => {
  it('sorts tracks alphabetically by title, case-insensitively-ish per locale rules', () => {
    const input = [
      { id: '2', title: 'Beta' },
      { id: '1', title: 'Alpha' },
      { id: '3', title: 'gamma' },
    ];

    const result = sortTrackSummariesByTitle(input);

    expect(result.map((t) => t.title)).toEqual(['Alpha', 'Beta', 'gamma']);
  });

  it('does not mutate the input array', () => {
    const input = [
      { id: '2', title: 'Beta' },
      { id: '1', title: 'Alpha' },
    ];
    const inputCopy = [...input];

    sortTrackSummariesByTitle(input);

    expect(input).toEqual(inputCopy);
  });
});
