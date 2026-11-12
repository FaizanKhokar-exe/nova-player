/**
 * Unit tests never run inside Electron. The real `electron` package, when imported from plain Node, only exports the
 * path of the downloaded binary - and throws if that download is missing (for example when GitHub answers 504).
 * Unit tests alias `electron` to this stub so they do not depend on the download at all. The real Electron wiring is
 * covered by the Playwright end-to-end tests, which use the real binary.
 */
const unavailable = {} as Record<string, unknown>;
export const app = unavailable;
export const BrowserWindow = unavailable;
export const dialog = unavailable;
export const globalShortcut = unavailable;
export const ipcMain = unavailable;
export const Menu = unavailable;
export const nativeImage = unavailable;
export const net = unavailable;
export const Notification = unavailable;
export const protocol = unavailable;
export const screen = unavailable;
export const shell = unavailable;
export const Tray = unavailable;
export const contextBridge = unavailable;
export const ipcRenderer = unavailable;
export default unavailable;
