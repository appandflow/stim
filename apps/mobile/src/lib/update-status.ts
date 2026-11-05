export function updateStatus({
  isChecking,
  isDownloading,
  isUpdatePending,
}: {
  isChecking: boolean;
  isDownloading: boolean;
  isUpdatePending: boolean;
}): 'ready' | 'downloading' | 'checking' | null {
  if (isUpdatePending) return 'ready';
  if (isDownloading) return 'downloading';
  if (isChecking) return 'checking';
  return null;
}
