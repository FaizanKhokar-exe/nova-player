import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TrackTitle } from './TrackTitle.js';

describe('TrackTitle', () => {
  it('renders the track title text', () => {
    render(<TrackTitle track={{ id: 't1', title: 'Test Song' }} />);
    expect(screen.getByTestId('track-title')).toHaveTextContent('Test Song');
  });
});
