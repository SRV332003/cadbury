// Captures mic audio as 16-bit PCM in ~40 ms chunks (at the AudioContext rate, 16 kHz).
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.round(sampleRate * 0.04);
    this.buf = new Int16Array(this.size);
    this.n = 0;
    this.sum = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      this.sum += s * s;
      this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === this.size) {
        const rms = Math.sqrt(this.sum / this.size);
        this.port.postMessage({ pcm: this.buf.buffer, rms }, [this.buf.buffer]);
        this.buf = new Int16Array(this.size);
        this.n = 0;
        this.sum = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-capture", PcmCapture);
