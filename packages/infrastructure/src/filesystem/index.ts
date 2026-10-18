export { createNodeFileSystem } from './node-file-system.js';
export type { FileSystem, FileStats, FileKind, DirectoryEntry, DirectoryEntryKind } from './file-system.js';
export { FileSystemError, toFileSystemError, type FileSystemErrorCode, type FileSystemOperation } from './file-system-error.js';
export {
  canonicalizePath,
  pathComparisonKey,
  isPathWithin,
  resolveWithin,
  NATIVE_PATH_FLAVOR,
  type CanonicalPath,
  type PathKey,
  type PathFlavor,
} from './path-policy.js';
