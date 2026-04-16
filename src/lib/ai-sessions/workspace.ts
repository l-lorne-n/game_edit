export function getAiSessionWorkspaceRoot(sessionId: string): string {
  return `sessions/${sessionId}`;
}

export function getAiSessionWorkspaceFilePath(sessionId: string, filePath: string): string {
  const clean = filePath.startsWith('/') ? filePath.slice(1) : filePath;
  return `${getAiSessionWorkspaceRoot(sessionId)}/${clean}`;
}
