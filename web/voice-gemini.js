// Gemini Live voice. Same interface/events as Voice (OpenAI) in voice.js:
// start() stop() toggleMute() inject(text) sayText(text); events: state listening talking level
// cat-text user-text tool error dropped.
function b64FromBuffer(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function pcmFromB64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const i16 = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 0x8000;
  return f32;
}

class GeminiVoice extends EventTarget {
  constructor(cfg = {}) {
    super();
    this.cfg = cfg;
    this.state = "off";
    this.ws = null;
    this.muted = false;
    this.responding = false;
    this.userSpeaking = false;
    this.queue = [];
    this.sources = new Set();
    this.level = 0;
    this.catText = "";
    this.userText = "";
    this.loud = 0; this.quiet = 0;
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  setState(s) { this.state = s; this.emit("state", s); }
  get playing() { return this.sources.size > 0; }

  async start() {
    if (this.ws) return;
    this.fatal = false;
    this.setState("connecting");
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });

      // mic → 16 kHz PCM
      this.inCtx = new AudioContext({ sampleRate: 16000 });
      await this.inCtx.audioWorklet.addModule("/pcm-worklet.js");
      const src = this.inCtx.createMediaStreamSource(this.mic);
      const node = new AudioWorkletNode(this.inCtx, "pcm-capture");
      const sink = this.inCtx.createGain(); sink.gain.value = 0;
      src.connect(node); node.connect(sink); sink.connect(this.inCtx.destination);
      node.port.onmessage = (e) => this.onMic(e.data);

      // 24 kHz playback → analyser (mouth sync) → speakers
      this.outCtx = new AudioContext({ sampleRate: 24000 });
      this.analyser = this.outCtx.createAnalyser(); this.analyser.fftSize = 512;
      this.analyser.connect(this.outCtx.destination);
      this.nextTime = 0;
      this.meter();

      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = (this.ws = new WebSocket(`${proto}://${location.host}/api/gemini-live`));
      this.wanted = true; // stays true until the user hangs up
      ws.onopen = () => { this.ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('{"cadbury":"ping"}'), 15000); };
      ws.onmessage = (e) => this.onServer(JSON.parse(e.data));
      ws.onclose = (e) => {
        console.warn("voice socket closed", e.code, e.reason);
        const reconnect = this.wanted && !this.fatal;
        this.cleanup();
        if (reconnect) this.emit("dropped");
      };
      ws.onerror = () => {};
    } catch (e) {
      console.error(e);
      this.emit("error", e.message || String(e));
      this.stop();
    }
  }

  cleanup() {
    clearInterval(this.ping);
    this.stopPlayback();
    try { this.mic?.getTracks().forEach((t) => t.stop()); } catch {}
    try { this.inCtx?.close(); } catch {}
    try { this.outCtx?.close(); } catch {}
    this.ws = this.mic = this.inCtx = this.outCtx = null;
    this.responding = false;
    this.setState("off");
  }
  stop() { this.wanted = false; const ws = this.ws; this.ws = null; try { ws?.close(); } catch {} this.cleanup(); }

  toggleMute() {
    if (!this.ws) return;
    this.muted = !this.muted;
    this.mic?.getTracks().forEach((t) => (t.enabled = !this.muted));
    this.setState(this.muted ? "muted" : "live");
  }

  send(obj) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj)); }

  onMic({ pcm, rms }) {
    if (this.state !== "live") return;
    if (this.cfg.halfDuplex && this.playing) return;

    // Barge-in: Gemini often finishes generating long before playback ends, so it can't
    // interrupt audio already queued here. If you talk over the cat, cut it off locally.
    // (Echo cancellation removes the cat's own voice from the mic; the higher threshold
    // while it's speaking guards against leftover echo.)
    const bargeAt = this.cfg.bargeThreshold ?? 0.06;
    if (this.playing) {
      this.barge = rms > bargeAt ? (this.barge || 0) + 1 : 0;
      if (this.barge >= 5) { // ~200 ms of you talking
        this.barge = 0;
        this.stopPlayback();
        if (this.generating) this.skipTurn = true; // ignore the rest of the reply still streaming in
        this.emit("talking", false);
        this.emit("barge-in");
        this.userSpeaking = true; this.loud = 4; this.quiet = 0;
        this.emit("listening", true);
      }
    } else {
      this.barge = 0;
    }

    // local voice-activity estimate for the cat's ears
    if (rms > 0.035 && !this.playing) { this.loud++; this.quiet = 0; } else { this.quiet++; this.loud = 0; }
    if (!this.userSpeaking && this.loud >= 4) { this.userSpeaking = true; this.emit("listening", true); }
    if (this.userSpeaking && this.quiet >= 20) { this.userSpeaking = false; this.emit("listening", false); setTimeout(() => this.flush(), 400); }
    this.send({ realtimeInput: { audio: { data: b64FromBuffer(pcm), mimeType: "audio/pcm;rate=16000" } } });
  }

  onServer(m) {
    if (m.cadbury === "pong") return;
    if (m.cadbury === "ready") {
      const quiet = m.resumed && this.everLive; // silent resume after a reconnect
      this.everLive = true;
      this.responding = false;
      if (quiet) { this.state = this.muted ? "muted" : "live"; this.emit("state-quiet", this.state); }
      else this.setState(this.muted ? "muted" : "live");
      this.flush();
      return;
    }
    if (m.cadbury === "rate-limited") { this.stopPlayback(); this.responding = false; this.emit("rate-limited", m.wait); return; }
    if (m.cadbury === "reconnecting") { this.stopPlayback(); this.responding = false; this.emit("reconnecting", m.attempt); return; }
    if (m.cadbury === "error") { this.fatal = /quota|exhausted|api key|permission|billing|not set/i.test(m.message || ""); this.emit("error", m.message); return; }
    if (m.toolCall) {
      this.responding = true;
      for (const f of m.toolCall.functionCalls ?? []) this.emit("tool", { name: f.name, args: f.args ?? {} });
      return;
    }
    const sc = m.serverContent;
    if (!sc) return;
    if (sc.interrupted) { this.stopPlayback(); this.emit("talking", false); }
    if (sc.modelTurn) this.generating = true;
    if (sc.inputTranscription?.text) this.userText += sc.inputTranscription.text;
    for (const p of sc.modelTurn?.parts ?? []) {
      if (p.inlineData?.data && p.inlineData.mimeType?.startsWith("audio") && !this.skipTurn) { this.responding = true; this.play(pcmFromB64(p.inlineData.data)); }
    }
    if (sc.outputTranscription?.text) {
      if (this.userText.trim()) { this.emit("user-text", this.userText.trim()); this.userText = ""; }
      this.catText += sc.outputTranscription.text;
      this.emit("cat-text", { text: this.catText, done: false });
    }
    if (sc.turnComplete || sc.interrupted) {
      this.generating = false;
      this.skipTurn = false;
      if (this.catText.trim()) this.emit("cat-text", { text: this.catText.trim(), done: true });
      if (this.userText.trim()) this.emit("user-text", this.userText.trim());
      this.catText = ""; this.userText = "";
      this.responding = false;
      if (!this.playing) setTimeout(() => this.flush(), 300);
    }
  }

  play(f32) {
    const ctx = this.outCtx;
    if (!ctx) return;
    const buf = ctx.createBuffer(1, f32.length, 24000);
    buf.copyToChannel(f32, 0);
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.connect(this.analyser);
    const t = Math.max(ctx.currentTime + 0.03, this.nextTime);
    s.start(t);
    this.nextTime = t + buf.duration;
    if (!this.playing) this.emit("talking", true);
    this.sources.add(s);
    s.onended = () => {
      this.sources.delete(s);
      if (!this.playing) { this.emit("talking", false); if (!this.responding) setTimeout(() => this.flush(), 300); }
    };
  }
  stopPlayback() {
    for (const s of this.sources) { try { s.onended = null; s.stop(); } catch {} }
    this.sources.clear();
    this.nextTime = 0;
  }

  /** Harness message ([system] …): spoken at the next quiet moment. */
  inject(text, { speak = true } = {}) {
    if (!this.ws || this.state === "off" || this.state === "connecting") return false;
    this.queue.push(text);
    this.flush();
    return true;
  }
  flush() {
    if (this.responding || this.playing || this.userSpeaking || !this.queue.length || this.ws?.readyState !== WebSocket.OPEN) return;
    const text = this.queue.splice(0).join("\n\n");
    this.responding = true;
    this.send({ realtimeInput: { text } });
  }
  sayText(text) { this.responding = true; this.send({ realtimeInput: { text } }); }

  meter() {
    const buf = new Uint8Array(512);
    const tick = () => {
      if (!this.outCtx) return;
      this.analyser.getByteTimeDomainData(buf);
      let sum = 0; for (const v of buf) { const x = (v - 128) / 128; sum += x * x; }
      this.level = this.level * 0.6 + Math.min(1, Math.sqrt(sum / buf.length) * 4) * 0.4;
      this.emit("level", this.level);
      requestAnimationFrame(tick);
    };
    tick();
  }
}
window.GeminiVoice = GeminiVoice;
