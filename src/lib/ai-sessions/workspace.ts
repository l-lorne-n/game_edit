export function getAiSessionWorkspaceRoot(sessionId: string): string {
  return `sessions/${sessionId}`;
}

export function getAiSessionVersionRoot(sessionId: string, workspaceVersion: number): string {
  return `${getAiSessionWorkspaceRoot(sessionId)}/v${workspaceVersion}`;
}

export function getAiSessionVersionTargetId(workspaceVersion: number): string {
  return `session:v${workspaceVersion}`;
}

export function parseAiSessionVersionTargetId(targetId: string | null | undefined): number | null {
  if (!targetId) {
    return null;
  }

  const match = /^session:v(\d+)$/.exec(targetId.trim());
  if (!match) {
    return null;
  }

  const parsed = Number.parseInt(match[1] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function getAiSessionWorkspaceFilePath(sessionId: string, filePath: string, workspaceVersion: number): string {
  const clean = filePath.startsWith('/') ? filePath.slice(1) : filePath;
  return `${getAiSessionVersionRoot(sessionId, workspaceVersion)}/${clean}`;
}
