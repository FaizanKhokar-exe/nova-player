import { AppProviders, AppRoot, type AppServices } from '@nova/ui';

/** The renderer root. All services are created by the entry point (main.tsx) from `window.nova`. */
export function App({ services }: { services: AppServices }) {
  return (
    <AppProviders services={services}>
      <AppRoot />
    </AppProviders>
  );
}
