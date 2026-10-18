/// <reference types="vite/client" />
import type { NovaBridge } from '@nova/shared';

declare global {
  interface Window {
    readonly nova: NovaBridge;
  }
}

export {};
