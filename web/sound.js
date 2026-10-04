// Local synthesized effects. Audio starts only after a user gesture.
export class ArenaSound {
  constructor({ onChange = () => {} } = {}) {
    this.onChange = onChange;
    this.available = Boolean(window.AudioContext || window.webkitAudioContext);
    try {
      this.enabled = localStorage.getItem("arena-sound") !== "off";
    } catch {
      this.enabled = true;
    }
    this.nodes = new Set();
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.stop();
      else if (this.context) void this.unlock();
    });
  }
  get ready() {
    return this.enabled && this.context?.state === "running";
  }
  async unlock() {
    if (!this.enabled || !this.available) return false;
    const Audio = window.AudioContext || window.webkitAudioContext;
    try {
      if (!this.context || this.context.state === "closed") {
        this.stop();
        this.context = new Audio();
        this.context.onstatechange = () => this.onChange();
        this.master = this.context.createGain();
        this.master.gain.value = 0.3;
        this.master.connect(this.context.destination);
      }
      if (this.context.state !== "running") await this.context.resume();
    } catch {
      /* Audio availability never blocks the game. */
    } finally {
      this.onChange();
    }
    return this.ready;
  }
  async toggle() {
    // The first click activates audio; only an already playing context is muted.
    this.enabled = !this.ready;
    try {
      localStorage.setItem("arena-sound", this.enabled ? "on" : "off");
    } catch {}
    if (this.enabled) {
      if (await this.unlock()) this.confirm();
    } else this.stop();
    this.onChange();
    return this.enabled;
  }
  confirm() {
    this.tone(660, 0.13, { volume: 0.28 });
    this.tone(880, 0.17, { delay: 0.09, volume: 0.28 });
  }
  stop() {
    for (const oscillator of this.nodes) {
      try {
        oscillator.stop();
      } catch {}
    }
    this.nodes.clear();
  }
  tone(
    frequency,
    duration,
    { delay = 0, end = frequency, type = "sine", volume = 0.3 } = {},
  ) {
    const c = this.context;
    if (!c || c.state !== "running" || !this.enabled || document.hidden) return;
    const oscillator = c.createOscillator(),
      gain = c.createGain(),
      at = c.currentTime + delay;
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, at);
    oscillator.frequency.exponentialRampToValueAtTime(
      Math.max(20, end),
      at + duration,
    );
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(volume, at + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    oscillator.connect(gain);
    gain.connect(this.master);
    oscillator.onended = () => {
      this.nodes.delete(oscillator);
      oscillator.disconnect();
      gain.disconnect();
    };
    this.nodes.add(oscillator);
    oscillator.start(at);
    oscillator.stop(at + duration + 0.01);
  }
  play(events, { key, finished = false, winner = null } = {}) {
    if (
      !this.enabled ||
      document.hidden ||
      this.context?.state !== "running" ||
      this.lastKey === key
    )
      return;
    this.lastKey = key;
    const types = new Set(events.map((e) => e.type));
    if (types.has("move"))
      this.tone(240, 0.095, { end: 140, type: "triangle", volume: 0.22 });
    if (types.has("attack") || types.has("miss"))
      this.tone(720, 0.16, { end: 95, type: "sawtooth", volume: 0.16 });
    if (events.some((e) => e.type === "attack" && e.damage > 0))
      this.tone(100, 0.2, {
        delay: 0.08,
        end: 35,
        type: "triangle",
        volume: 0.65,
      });
    if (types.has("defend")) this.tone(300, 0.2, { end: 520, volume: 0.22 });
    if (types.has("scan")) this.tone(380, 0.35, { end: 1200, volume: 0.13 });
    if (types.has("trap")) {
      this.tone(170, 0.05, { type: "square", volume: 0.12 });
      this.tone(240, 0.07, { delay: 0.08, volume: 0.18 });
    }
    if (types.has("explosion") || types.has("death"))
      this.tone(155, 0.35, { end: 25, type: "sawtooth", volume: 0.3 });
    if (types.has("pickup") || types.has("harvest"))
      for (const [i, note] of [660, 880, 1320].entries())
        this.tone(note, 0.17, { delay: i * 0.065, volume: 0.24 });
    if (types.has("zone_shift"))
      for (const [i, note] of [440, 554, 660].entries())
        this.tone(note, 0.2, { delay: i * 0.11, volume: 0.21 });
    if (finished)
      for (const [i, note] of (winner
        ? [523, 659, 784, 1047]
        : [440, 392, 330]
      ).entries())
        this.tone(note, 0.32, { delay: 0.15 + i * 0.13, volume: 0.28 });
  }
}
