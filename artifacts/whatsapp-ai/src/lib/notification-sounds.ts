// Notification sounds for incoming chats. Sounds are synthesized with the
// Web Audio API so no audio assets need to be bundled or downloaded — each
// "ring" is a short sequence of oscillator tones.

export type NotificationSoundId =
  | "off"
  | "chime"
  | "ping"
  | "bell"
  | "marimba"
  | "blip";

export const DEFAULT_NOTIFICATION_SOUND: NotificationSoundId = "chime";

export const NOTIFICATION_SOUND_IDS: NotificationSoundId[] = [
  "off",
  "chime",
  "ping",
  "bell",
  "marimba",
  "blip",
];

// Ordered for the settings UI: the five rings first, then mute.
export const NOTIFICATION_SOUND_OPTIONS: {
  id: NotificationSoundId;
  label: string;
}[] = [
  { id: "chime", label: "Chime" },
  { id: "ping", label: "Ping" },
  { id: "bell", label: "Bell" },
  { id: "marimba", label: "Marimba" },
  { id: "blip", label: "Blip" },
  { id: "off", label: "Mute" },
];

export function isNotificationSoundId(v: unknown): v is NotificationSoundId {
  return typeof v === "string" && (NOTIFICATION_SOUND_IDS as string[]).includes(v);
}

let audioCtx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) return null;
  if (!audioCtx) audioCtx = new Ctor();
  // Browsers start the context suspended until a user gesture; the dashboard
  // user has always interacted with the page by the time a chat arrives.
  if (audioCtx.state === "suspended") void audioCtx.resume();
  return audioCtx;
}

type ToneSpec = {
  freq: number;
  start: number;
  dur: number;
  type?: OscillatorType;
  gain?: number;
};

function playTones(specs: ToneSpec[]): void {
  const ctx = getCtx();
  if (!ctx) return;
  const now = ctx.currentTime;
  for (const s of specs) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = s.type ?? "sine";
    const t0 = now + s.start;
    osc.frequency.setValueAtTime(s.freq, t0);
    osc.connect(g);
    g.connect(ctx.destination);
    const peak = s.gain ?? 0.18;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + s.dur);
    osc.start(t0);
    osc.stop(t0 + s.dur + 0.03);
  }
}

const PATTERNS: Record<Exclude<NotificationSoundId, "off">, ToneSpec[]> = {
  chime: [
    { freq: 1046.5, start: 0, dur: 0.18 },
    { freq: 1318.51, start: 0.12, dur: 0.26 },
  ],
  ping: [{ freq: 987.77, start: 0, dur: 0.32, gain: 0.22 }],
  bell: [
    { freq: 1567.98, start: 0, dur: 0.55, type: "triangle", gain: 0.2 },
    { freq: 2349.32, start: 0, dur: 0.45, type: "triangle", gain: 0.07 },
  ],
  marimba: [
    { freq: 880, start: 0, dur: 0.16 },
    { freq: 1108.73, start: 0.09, dur: 0.16 },
    { freq: 1318.51, start: 0.18, dur: 0.24 },
  ],
  blip: [
    { freq: 523.25, start: 0, dur: 0.09, type: "square", gain: 0.12 },
    { freq: 1046.5, start: 0.06, dur: 0.13, type: "square", gain: 0.12 },
  ],
};

export function playNotificationSound(id: NotificationSoundId): void {
  if (id === "off") return;
  const pattern = PATTERNS[id];
  if (pattern) playTones(pattern);
}
