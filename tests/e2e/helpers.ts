import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
// The 'electron' package's default export, when imported from plain Node
// (not from inside Electron itself), is a string: the path to the Electron
// binary for this platform.
import electronBinaryPath from 'electron';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, '../../apps/desktop');
export const mainEntryPath = path.join(desktopRoot, 'out/main/index.js');

/**
 * `--no-sandbox` / `--disable-gpu` here are accommodations for running a
 * real Electron window inside this container (headless, running as root,
 * under Xvfb) - they configure how THIS TEST PROCESS launches Chromium's
 * own OS-level sandbox, and are unrelated to, and do not weaken, the
 * app's own webPreferences (contextIsolation: true, nodeIntegration:
 * false, sandbox: true) which govern what the renderer can access. A
 * packaged, signed installer run by a real user on real Windows does not
 * need and will not carry these flags.
 */
export async function launchApp(options: { userDataDir?: string; startupSync?: boolean } = {}): Promise<{ app: ElectronApplication; window: Page }> {
  // Phase 5 starts watching + one reconciliation scan at launch (see `LibraryApplication.startup`).
  // The Phase 0-4 specs drive scanning by hand and assert exact states, so they launch with the
  // documented test hook `NOVA_STARTUP_SYNC=off`; the Phase 5 startup specs pass `startupSync: true`
  // to run the REAL launch policy.
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  // Phase 7 test hook: exposes the main-process shell (tray menu, command dispatch) on a main-process global.
  env.NOVA_E2E_SHELL_HOOKS = '1';
  if (options.startupSync === true) delete env.NOVA_STARTUP_SYNC;
  else env.NOVA_STARTUP_SYNC = 'off';
  const app = await electron.launch({
    env,
    executablePath: electronBinaryPath as unknown as string,
    args: [
      mainEntryPath,
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      // Keeps the real app's database out of the developer's own profile.
      ...(options.userDataDir !== undefined ? [`--user-data-dir=${options.userDataDir}`] : []),
    ],
  });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  return { app, window };
}

/**
 * The native OS folder picker cannot be operated by a test, so the main
 * process's `dialog.showOpenDialog` is told what the "user" picks, in order
 * (`undefined` = the user cancelled). Everything else stays real.
 */
export async function pickFolders(app: ElectronApplication, ...folders: (string | undefined)[]): Promise<void> {
  await app.evaluate(({ dialog }, queue) => {
    const remaining = [...queue];
    (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => {
      const next = remaining.shift();
      return next === undefined ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [next] };
    };
  }, folders);
}
