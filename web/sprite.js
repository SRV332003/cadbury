// Sprite-sheet pet renderer (Codex pet v2 format: 8×11 grid of 192×208 frames).
// Pet art: "Maodie" by Octane0411 / maodie-codex-pet contributors, CC BY 4.0
// https://github.com/Octane0411/maodie-codex-pet
(() => {
  const SHEET = { url: "/pets/maodie/spritesheet.webp", w: 1536, h: 2288, fw: 192, fh: 208 };
  const range = (n) => [...Array(n).keys()];

  // row = sheet row, frames = columns to cycle, fps = speed, loop = repeat (false → hold last)
  const ANIMS = {
    idle:     { row: 0, frames: [0, 1, 2, 3, 4, 5, 4, 3, 2, 1], fps: 5 },
    neutral:  { row: 0, frames: [6], fps: 1 },
    runRight: { row: 1, frames: range(8), fps: 14 },
    runLeft:  { row: 2, frames: range(8), fps: 14 },
    wave:     { row: 3, frames: [0, 1, 2, 3, 2, 3, 2, 1, 0], fps: 8, loop: false },
    jump:     { row: 4, frames: range(5), fps: 9, loop: false },
    failed:   { row: 5, frames: [0, 1, 2, 1, 0, 5, 6, 5], fps: 4 },
    sulk:     { row: 5, frames: [2, 3, 4, 4, 4, 4, 4, 3, 2], fps: 3, loop: false },
    sleep:    { row: 5, frames: [4], fps: 1 },
    waiting:  { row: 6, frames: [1, 2, 5, 2], fps: 3 },
    working:  { row: 7, frames: range(6), fps: 6 },
    review:   { row: 8, frames: range(6), fps: 4 },
    stretch:  { row: 8, frames: [0, 4, 4, 4, 4, 0], fps: 3, loop: false },
    pet:      { row: 8, frames: [2], fps: 1 },
  };

  const MOOD_ANIM = {
    idle: "idle", sleeping: "sleep", listening: "neutral", talking: "talk", thinking: "review",
    working: "working", asking: "waiting", happy: "happy", oops: "failed",
  };
  const ANTIC_ANIM = {
    wave: "wave", hop: "jump", groom: "review", beg: "waiting", sulk: "sulk", stretch: "stretch",
    zoom: "zoom", look: "lookSweep", peek: "neutral", spin: "idle", shake: "failed", roll: "jump",
  };

  const el = document.getElementById("cat");
  let scale = 1;
  let mood = "idle", antic = null, anticStart = 0, anticMs = 0, petting = false;
  let level = 0, look = null, lookAtTime = 0;
  let animName = "", animStart = performance.now(), lastFrame = "";

  function resize() {
    scale = el.clientWidth / SHEET.fw;
    el.style.backgroundSize = `${SHEET.w * scale}px ${SHEET.h * scale}px`;
    lastFrame = "";
  }
  new ResizeObserver(resize).observe(el);

  function show(row, col) {
    const key = row + ":" + col;
    if (key === lastFrame) return;
    lastFrame = key;
    el.style.backgroundPosition = `${-col * SHEET.fw * scale}px ${-row * SHEET.fh * scale}px`;
  }
  // 16 look directions, compass degrees (0 = up, clockwise) → rows 9–10
  function showLook(deg) {
    const i = Math.round((((deg % 360) + 360) % 360) / 22.5) % 16;
    show(9 + Math.floor(i / 8), i % 8);
  }

  function frameOf(name, t) {
    const a = ANIMS[name];
    const n = Math.floor((t / 1000) * a.fps);
    const idx = a.loop === false ? Math.min(n, a.frames.length - 1) : n % a.frames.length;
    show(a.row, a.frames[idx]);
  }

  function currentAnim(now) {
    if (antic && now - anticStart < anticMs) return ANTIC_ANIM[antic] ?? "idle";
    antic = null;
    if (petting) return "pet";
    return MOOD_ANIM[mood] ?? "idle";
  }

  function tick(now) {
    const name = currentAnim(now);
    if (name !== animName) { animName = name; animStart = now; }
    const t = now - animStart;

    if (name === "happy") {
      const jumpMs = (ANIMS.jump.frames.length / ANIMS.jump.fps) * 1000;
      t < jumpMs ? frameOf("jump", t) : frameOf("wave", t - jumpMs);
    } else if (name === "talk") {
      show(6, level > 0.12 ? 3 : 0); // mouth open / closed with the voice
    } else if (name === "zoom") {
      const f = (now - anticStart) / anticMs; // matches CSS: left, then right, then back
      frameOf(f < 0.22 ? "runLeft" : f < 0.58 ? "runRight" : "runLeft", t);
    } else if (name === "lookSweep") {
      const f = Math.min(1, (now - anticStart) / anticMs);
      showLook(270 + f * 180); // left → up → right
    } else if (look && (name === "idle" || name === "neutral") && now - lookAtTime < 2500) {
      showLook(look);
    } else {
      frameOf(name, t);
    }
    requestAnimationFrame(tick);
  }

  el.style.backgroundImage = `url(${SHEET.url})`;
  resize();
  requestAnimationFrame(tick);

  window.catSprite = {
    setMood(m) { if (m !== mood) { mood = m; animName = ""; } },
    antic(name, ms) { antic = name; anticStart = performance.now(); anticMs = ms; },
    setLevel(l) { level = l; },
    petting(on) { petting = on; },
    /** dx, dy = cursor offset from the cat's face, in px */
    lookAt(dx, dy) {
      const d = Math.hypot(dx, dy);
      if (d < 70) { look = null; return; }
      const deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
      if (look === null || Math.abs(deg - look) > 4) lookAtTime = performance.now();
      look = deg;
    },
  };
})();
