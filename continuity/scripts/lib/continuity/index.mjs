export function createLiveContext(root, { clock, git }) {
  return Object.freeze({ root, now: clock(), git, evaluateEvidence: () => 'unknown' });
}

export function handleInspectCommand(context) {
  context.stderr.write('continuity: v2 inspect rendering is not available in this build\n');
  return 3;
}
