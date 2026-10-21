import { attachedLyricsMigration } from './attached-lyrics-schema.js';
import { customMediaMigration } from './custom-media-schema.js';
import { collectionsMigration } from './collections-schema.js';
import { initialSchemaMigration } from './initial-schema.js';
import { libraryRootsMigration } from './library-roots-schema.js';
import { playbackSessionMigration } from './playback-session-schema.js';
import type { Migration } from './migration-runner.js';
import { scanStateMigration } from './scan-state-schema.js';

/**
 * The ordered, append-only list of schema migrations. Never edit or reorder
 * a migration that has shipped - add a new one at the end instead.
 */
export const MIGRATIONS: readonly Migration[] = [
  initialSchemaMigration,
  scanStateMigration,
  libraryRootsMigration,
  playbackSessionMigration,
  attachedLyricsMigration,
  collectionsMigration,
  customMediaMigration,
];
