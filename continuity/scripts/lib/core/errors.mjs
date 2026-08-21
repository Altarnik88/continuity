export class MemoryError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.name = 'MemoryError';
    this.exitCode = exitCode;
  }
}

export const LEGACY_SCHEMA_UNSUPPORTED =
  'this build supports schema v3 only; v1/v2 stores are frozen at git tag legacy-v1v2-final';
