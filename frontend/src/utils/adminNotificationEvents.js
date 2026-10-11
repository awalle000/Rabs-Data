export const claimNotificationOnce = (seenIds, id) => {
  if (!id || seenIds.has(id)) return false;
  seenIds.add(id);
  return true;
};

export const parseSseFrames = (buffer) => {
  const frames = buffer.split('\n\n');
  const remainder = frames.pop() || '';
  const notifications = [];

  for (const frame of frames) {
    const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
    if (!dataLine) continue;
    try {
      notifications.push(JSON.parse(dataLine.slice(5).trim()));
    } catch {
      // Invalid frames are skipped; persisted polling remains available.
    }
  }

  return { notifications, remainder };
};