// OpenAI Realtime over WebRTC. Audio flows phone/desktop <-> OpenAI directly;
// tool calls arrive on the data channel and are executed via the bridge.
class Voice extends EventTarget {
  constructor() {
    super();
    this.pc = null; this.dc = null; this.micTrack = null;
    this.state = "off"; // off | connecting | live | muted
    this.responding = false; this.userSpeaking = false;
    this.queue = []; // proactive [system] messages waiting for a quiet moment
    this.level = 0;
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  setState(s) { this.state = s; this.emit("state", s); }

  async start() {
    if (this.pc) return;
    this.setState("connecting");
    try {
      const tok = await fetch("/api/realtime-token", { method: "POST" }).then((r) => r.json());
      if (tok.error) throw new Error(tok.error);

      const pc = (this.pc = new RTCPeerConnection());
      const audio = (this.audioEl = new Audio());
      audio.autoplay = true;
      pc.ontrack = (e) => { audio.srcObject = e.streams[0]; this.watchLevel(e.streams[0]); };

      const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      this.micTrack = mic.getTracks()[0];
      pc.addTrack(this.micTrack, mic);

      const dc = (this.dc = pc.createDataChannel("oai-events"));
      dc.onmessage = (e) => this.onServerEvent(JSON.parse(e.data));
      dc.onopen = () => { this.setState("live"); this.flush(); };

      pc.onconnectionstatechange = () => {
        if (["failed", "closed", "disconnected"].includes(pc.connectionState)) this.stop(true);
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const res = await fetch(`https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(tok.model)}`, {
        method: "POST",
        body: offer.sdp,
        headers: { Authorization: `Bearer ${tok.value}`, "Content-Type": "application/sdp" },
      });
      if (!res.ok) throw new Error(`realtime connect failed: ${res.status} ${await res.text()}`);
      await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });
    } catch (e) {
      console.error(e);
      this.emit("error", e?.name === "NotAllowedError"
        ? "mic blocked. On a Mac: System Settings → Privacy & Security → Microphone → turn on your terminal app, then restart it"
        : e.message || String(e));
      this.stop();
    }
  }

  stop(dropped = false) {
    try { this.dc?.close(); } catch {}
    try { this.pc?.close(); } catch {}
    this.micTrack?.stop();
    this.pc = this.dc = this.micTrack = null;
    this.responding = false;
    this.setState("off");
    if (dropped) this.emit("dropped");
  }

  toggleMute() {
    if (!this.micTrack) return;
    this.micTrack.enabled = !this.micTrack.enabled;
    this.setState(this.micTrack.enabled ? "live" : "muted");
  }

  send(obj) { if (this.dc?.readyState === "open") this.dc.send(JSON.stringify(obj)); }

  /** Inject a harness message. urgent → speak as soon as the current turn ends. */
  inject(text, { speak = true } = {}) {
    if (!this.dc || this.dc.readyState !== "open") return false;
    this.queue.push({ text, speak });
    this.flush();
    return true;
  }
  flush() {
    if (this.responding || this.userSpeaking || !this.queue.length) return;
    // merge everything queued into one turn
    const items = this.queue.splice(0);
    const text = items.map((i) => i.text).join("\n\n");
    this.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
    if (items.some((i) => i.speak)) { this.responding = true; this.send({ type: "response.create" }); }
  }

  sayText(text) {
    // typed message from the panel
    this.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
    this.responding = true;
    this.send({ type: "response.create" });
  }

  async onServerEvent(ev) {
    switch (ev.type) {
      case "input_audio_buffer.speech_started": this.userSpeaking = true; this.emit("listening", true); break;
      case "input_audio_buffer.speech_stopped": this.userSpeaking = false; this.emit("listening", false); break;
      case "conversation.item.input_audio_transcription.completed": this.emit("user-text", ev.transcript); break;
      case "response.created": this.responding = true; this.transcript = ""; break;
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta":
        this.transcript = (this.transcript || "") + ev.delta; this.emit("cat-text", { text: this.transcript, done: false }); break;
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
        this.emit("cat-text", { text: ev.transcript, done: true }); break;
      case "output_audio_buffer.started": this.emit("talking", true); break;
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared": this.emit("talking", false); break;
      case "response.done": {
        this.responding = false;
        const calls = (ev.response?.output ?? []).filter((o) => o.type === "function_call");
        if (calls.length) {
          for (const c of calls) await this.runTool(c);
          this.responding = true;
          this.send({ type: "response.create" });
        } else {
          setTimeout(() => this.flush(), 300);
        }
        break;
      }
      case "error": console.warn("realtime error", ev.error); this.emit("error", ev.error?.message); break;
    }
  }

  async runTool(call) {
    let args = {};
    try { args = JSON.parse(call.arguments || "{}"); } catch {}
    this.emit("tool", { name: call.name, args });
    let output;
    try {
      output = await fetch(`/api/tool/${call.name}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args),
      }).then((r) => r.json());
    } catch (e) { output = { error: String(e) }; }
    this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: call.call_id, output: JSON.stringify(output) } });
  }

  watchLevel(stream) {
    try {
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser(); an.fftSize = 512;
      src.connect(an);
      const buf = new Uint8Array(an.fftSize);
      const tick = () => {
        an.getByteTimeDomainData(buf);
        let sum = 0; for (const v of buf) { const x = (v - 128) / 128; sum += x * x; }
        const rms = Math.sqrt(sum / buf.length);
        this.level = this.level * 0.6 + Math.min(1, rms * 4) * 0.4;
        this.emit("level", this.level);
        requestAnimationFrame(tick);
      };
      tick();
    } catch (e) { console.warn("level meter unavailable", e); }
  }
}
window.Voice = Voice;
