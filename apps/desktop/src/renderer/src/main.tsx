import React from 'react';
import ReactDOM from 'react-dom/client';
import { createAppServices } from '@nova/ui';
import './theme/theme.css';
import { App } from './App.js';

const container = document.getElementById('root');
if (!container) throw new Error('Root element not found');

// The one native audio element - the playback engine. It lives in the page (hidden) so the browser's media stack drives
// it. It only ever receives opaque `nova-media://track/<id>` sources handed out by the main process. `crossOrigin` MUST be
// set before any source so the spectrum / equalizer (Web Audio) may read the samples of the CORS-enabled protocol.
const audio = document.createElement('audio');
audio.id = 'nova-audio';
audio.crossOrigin = 'anonymous';
audio.preload = 'auto';
audio.hidden = true;
document.body.append(audio);

// The renderer's composition point: the only way the UI reaches the backend is the narrow, typed `window.nova` bridge.
const services = createAppServices(window.nova, audio);

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <App services={services} />
  </React.StrictMode>,
);
