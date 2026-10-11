let audioContext;

export const playAdminNotificationSound = async (volume = 0.55) => {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return false;

  try {
    audioContext ||= new AudioContextClass();
    if (audioContext.state !== 'running') await audioContext.resume();
    if (audioContext.state !== 'running') return false;

    const now = audioContext.currentTime;
    [880, 1174].forEach((frequency, index) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const start = now + index * 0.12;
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(Math.max(0.001, volume * 0.16), start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.22);
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.23);
    });
    return true;
  } catch {
    return false;
  }
};