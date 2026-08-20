export function handleGraphifyCommand(context) {
  context.stderr.write('continuity: Graphify support is not available in this build\n');
  return 4;
}
