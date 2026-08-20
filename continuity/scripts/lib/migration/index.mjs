export function handleMigrationCommand(context) {
  context.stderr.write('continuity: migration support is not available in this build\n');
  return 3;
}
