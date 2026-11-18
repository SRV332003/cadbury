// Glue: bridge events -> cat mood + bubble; voice events -> mood overlay; desktop/remote UI.
const $ = (s) => document.querySelector(s);
const isRemote = location.pathname.startsWith("/remote") || !window.mochi;
if (isRemote) document.body.classList.add("remote");

const voice = window.MOCHI_VOICE?.provider === "gemini" ? new GeminiVoice(window.MOCHI_VOICE) : new Voice();
let bridgeMood = "idle", bridgeStatus = "";
let overlay = null; // "listening" | "talking" | null
let bubbleTimer;

function renderMood() {
  const mood = overlay ?? bridgeMood;
  document.body.className = document.body.className.replace(/\bmood-\S+/g, "").trim() + ` mood-${mood}`;
  window.catSprite?.setMood(mood);
  $("#chip").textContent = bridgeStatus && bridgeMood !== "idle" ? bridgeStatus : "";
}
function bubble(text, ms = 9000) {
  const b = $("#bubble");
  $("#bubble-text").textContent = text;
  b.classList.remove("hide");
  clearTimeout(bubbleTimer);
  if (ms) bubbleTimer = setTimeout(() => b.classList.add("hide"), ms);
}
function feed(cls, text) {
  const row = document.createElement("div");
  row.className = `row ${cls}`;
  row.textContent = text;
  const f = $("#feed");
  f.appendChild(row);
  while (f.children.length > 200) f.firstChild.remove();
  f.scrollTop = f.scrollHeight;
}
function showDiff(files) {
  const d = $("#diff");
  d.innerHTML = "";
  for (const f of files) {
    const det = document.createElement("details");
    const sum = document.createElement("summary");
    sum.innerHTML = `<span class="add">+${f.additions}</span> <span class="del">-${f.deletions}</span> `;
    sum.append(f.file ?? "?");
    const pre = document.createElement("pre");
    for (const line of (f.patch ?? "").split("\n")) {
      const s = document.createElement("span");
      if (line.startsWith("+") && !line.startsWith("+++")) s.className = "add";
      else if (line.startsWith("-") && !line.startsWith("---")) s.className = "del";
      s.textContent = line + "\n";
      pre.appendChild(s);
    }
    det.append(sum, pre);
    d.appendChild(det);
  }
}
function openPanel(open = true) { $("#panel").classList.toggle("hidden", !open); window.mochi?.panel(open); }

// ---------- bridge event stream ----------
function connectBridge() {
  const es = new EventSource("/api/events");
  es.onmessage = (m) => {
    const e = JSON.parse(m.data);
    switch (e.type) {
      case "mood":
        bridgeMood = e.mood; bridgeStatus = e.status;
        renderMood();
        if (voice.state === "off" && e.mood !== "idle" && e.status) bubble(e.status, e.mood === "asking" ? 0 : 6000);
        break;
      case "activity": feed("act", "• " + e.text); break;
      case "context": {
        const name = e.directory.split("/").pop();
        $("#proj").textContent = "📁 " + name;
        $("#sess").textContent = e.title ?? (e.sessionID ? e.sessionID.slice(0, 14) : "no session yet");
        break;
      }
      case "diff": showDiff(e.files); break;
      case "hotkey": if (!isRemote) talkToggle(); break;
      case "narrate": {
        const spoken = voice.inject(e.text, { speak: e.speak });
        if (!spoken && e.urgent) {
          // voice is off: show the gist in the bubble
          const plain = e.text.replace(/^\[system\][^\n]*\n?/, "").split("\n").find((l) => l.trim()) ?? e.text;
          bubble(plain.slice(0, 220), 0);
          feed("cat", "🐱 " + plain.slice(0, 400));
          window.mochi?.notify(plain.slice(0, 200));
        }
        break;
      }
    }
  };
  es.onerror = () => { es.close(); setTimeout(connectBridge, 1500); };
}
connectBridge();

// ---------- voice wiring ----------
voice.addEventListener("state", (e) => {
  const dot = $("#mic-dot");
  dot.className = { live: "live", muted: "muted", connecting: "connecting" }[e.detail] ?? "";
  $("#btn-talk")?.classList.toggle("on", e.detail === "live");
  if ($("#btn-talk")) $("#btn-talk").textContent = e.detail === "off" ? "🎙 Talk" : e.detail === "muted" ? "🔇 Muted" : "🎙 Listening";
  if (e.detail === "live") bubble("I'm listening 👂", 3000);
  if (e.detail === "off") { overlay = null; renderMood(); }
});
voice.addEventListener("listening", (e) => { overlay = e.detail ? "listening" : null; renderMood(); });
voice.addEventListener("talking", (e) => { overlay = e.detail ? "talking" : null; renderMood(); });
voice.addEventListener("level", (e) => window.catSprite?.setLevel(e.detail));
voice.addEventListener("cat-text", (e) => { bubble(e.detail.text, e.detail.done ? 10000 : 0); if (e.detail.done) feed("cat", "🐱 " + e.detail.text); });
voice.addEventListener("user-text", (e) => feed("you", "🧑 " + e.detail));
voice.addEventListener("tool", (e) => feed("act", `⚙ ${e.detail.name} ${e.detail.args?.instruction ? "— " + e.detail.args.instruction : ""}`));
voice.addEventListener("error", (e) => { bubble("😿 " + e.detail, 8000); feed("act", "error: " + e.detail); });
let dropCount = 0, dropReset;
voice.addEventListener("dropped", () => {
  // back off if it keeps failing; reset after a stable minute
  dropCount++;
  clearTimeout(dropReset);
  const wait = Math.min(15000, 1000 * 2 ** (dropCount - 1));
  bubble("connection hiccup, reconnecting… 🐾", wait + 2000);
  setTimeout(() => voice.start(), wait);
});
voice.addEventListener("state", (e) => { if (e.detail === "live") dropReset = setTimeout(() => (dropCount = 0), 60000); });
voice.addEventListener("reconnecting", () => { $("#mic-dot").className = "connecting"; });
voice.addEventListener("rate-limited", (e) => { $("#mic-dot").className = "connecting"; bubble(`Gemini free limit hit 😿 thoda ruko, retrying in ${e.detail}s`, e.detail * 1000); });
voice.addEventListener("state-quiet", (e) => { $("#mic-dot").className = e.detail === "muted" ? "muted" : "live"; });

function talkToggle() {
  if (voice.state === "off") voice.start();
  else voice.toggleMute();
}

// ---------- desktop interactions: drag / click / menu ----------
const wrap = $("#cat-wrap");
let drag = null;
wrap.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  drag = { x: e.screenX, y: e.screenY, moved: false };
  wrap.setPointerCapture(e.pointerId);
});
wrap.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const dx = e.screenX - drag.x, dy = e.screenY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  drag.moved = true;
  if (window.mochi) { window.mochi.moveBy(dx, dy); drag.x = e.screenX; drag.y = e.screenY; }
});
wrap.addEventListener("pointerup", () => {
  if (drag && !drag.moved) talkToggle();
  drag = null;
});
wrap.addEventListener("dblclick", () => openPanel($("#panel").classList.contains("hidden")));
wrap.addEventListener("contextmenu", async (e) => {
  e.preventDefault();
  if (!window.mochi) return openPanel(true);
  const proj = await fetch("/api/tool/list_projects", { method: "POST" }).then((r) => r.json()).catch(() => ({ projects: [] }));
  window.mochi.menu({ projects: proj.projects, current: proj.current, voice: voice.state });
});
window.mochi?.onMenu(async (action, arg) => {
  const tool = (n, a = {}) => fetch(`/api/tool/${n}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(a) }).then((r) => r.json());
  if (action === "talk") talkToggle();
  if (action === "hangup") voice.stop();
  if (action === "panel") openPanel($("#panel").classList.contains("hidden"));
  if (action === "stop") tool("stop_task");
  if (action === "new") { await tool("new_session"); bubble("fresh session ✨", 3000); }
  if (action === "diff") { await tool("show_diff"); openPanel(true); }
  if (action === "project") { const r = await tool("switch_project", { name: arg }); bubble(r.ok ? `now in ${r.project} 📁` : r.reason, 4000); }
});
window.mochi?.onHotkey(() => talkToggle());

$("#close-panel").onclick = () => openPanel(false);
$("#typebox").onsubmit = async (e) => {
  e.preventDefault();
  const t = $("#typein").value.trim();
  if (!t) return;
  $("#typein").value = "";
  feed("you", "🧑 " + t);
  if (voice.state !== "off") voice.sayText(t);
  else {
    await fetch("/api/tool/code_task", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ instruction: t }) });
    bubble("on it! 🐾", 3000);
  }
};

// remote (phone) buttons
$("#btn-talk").onclick = talkToggle;
$("#btn-panel").onclick = () => openPanel($("#panel").classList.contains("hidden"));
$("#btn-stop").onclick = () => fetch("/api/tool/stop_task", { method: "POST" });
if (isRemote && "wakeLock" in navigator) {
  const lock = () => navigator.wakeLock.request("screen").catch(() => {});
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && lock());
  lock();
}

renderMood();

// ---------- personality: random antics, petting, eyes follow cursor ----------
const ANTICS = [
  // [name, durationMs, weight, optional bubble lines]
  ["wave", 1300, 3, ["hi hooman", "o/"]],
  ["hop", 1200, 3, ["boing"]],
  ["zoom", 2300, 2, ["ZOOMIES", "nyoom"]],
  ["groom", 3000, 3, ["*inspects paw*"]],
  ["beg", 2600, 2, ["treat?", "pspsps yourself"]],
  ["sulk", 3200, 2, ["hmph.", "*flops dramatically*"]],
  ["look", 3200, 3, ["did you hear that?", "a bug! …a real one"]],
  ["stretch", 2100, 2],
  ["peek", 3300, 2, ["peekaboo"]],
  ["spin", 1700, 1, ["where is my tail"]],
  ["shake", 1100, 2, ["achoo!"]],
  ["roll", 1500, 1, ["wheee"]],
];
const MEOWS = ["mrrp?", "nya~", "*knocks your coffee off the desk*", "feed me bugs to fix", "is it lunch yet", "purr…", "I sat on your keyboard. you're welcome", "meow."];
let anticTimer, anticEnd;
const busyMoods = new Set(["talking", "listening", "asking", "oops"]);

function doAntic(name) {
  const a = ANTICS.find((x) => x[0] === name) ?? ANTICS[0];
  document.body.classList.remove(...ANTICS.map((x) => "antic-" + x[0]));
  void document.body.offsetWidth; // restart animation
  document.body.classList.add("antic-" + a[0]);
  window.catSprite?.antic(a[0], a[1]);
  if (a[3] && Math.random() < 0.5 && voice.state === "off") bubble(a[3][Math.floor(Math.random() * a[3].length)], 2500);
  clearTimeout(anticEnd);
  anticEnd = setTimeout(() => document.body.classList.remove("antic-" + a[0]), a[1]);
}
function pickAntic() {
  const mood = overlay ?? bridgeMood;
  let pool = ANTICS;
  if (mood === "working" || mood === "thinking") pool = ANTICS.filter((a) => ["look", "groom"].includes(a[0]));
  const total = pool.reduce((s, a) => s + a[2], 0);
  let r = Math.random() * total;
  for (const a of pool) { if ((r -= a[2]) <= 0) return a[0]; }
  return pool[0][0];
}
function scheduleAntic() {
  clearTimeout(anticTimer);
  anticTimer = setTimeout(() => {
    const mood = overlay ?? bridgeMood;
    if (!busyMoods.has(mood) && mood !== "sleeping" && !document.body.classList.contains("petting")) {
      doAntic(pickAntic());
      if (mood === "idle" && voice.state === "off" && Math.random() < 0.12) setTimeout(() => bubble(MEOWS[Math.floor(Math.random() * MEOWS.length)], 3000), 1200);
    }
    scheduleAntic();
  }, 6000 + Math.random() * 12000);
}
scheduleAntic();
window.mochiAntic = doAntic; // try it from devtools: mochiAntic("zoom")

// petting: hover over the cat for a moment → purr
let petTimer;
wrap.addEventListener("pointerenter", () => {
  petTimer = setTimeout(() => {
    if (busyMoods.has(overlay ?? bridgeMood)) return;
    document.body.classList.add("petting");
    window.catSprite?.petting(true);
    if (voice.state === "off") bubble("prrrrrr ♥", 2500);
  }, 900);
});
const unpet = () => { clearTimeout(petTimer); document.body.classList.remove("petting"); window.catSprite?.petting(false); };
wrap.addEventListener("pointerleave", unpet);
wrap.addEventListener("pointerdown", unpet);

// eyes follow the cursor (desktop: whole screen via main process; phone/browser: within page)
function lookAt(screenDX, screenDY) { window.catSprite?.lookAt(screenDX, screenDY); }
function eyeCenter() {
  const r = document.querySelector("#cat").getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height * 0.32 };
}
if (window.mochi?.onCursor) {
  window.mochi.onCursor(({ x, y, winX, winY, zoom = 1 }) => {
    const c = eyeCenter();
    lookAt(x - (winX + c.x * zoom), y - (winY + c.y * zoom));
  });
} else {
  addEventListener("pointermove", (e) => { const c = eyeCenter(); lookAt(e.clientX - c.x, e.clientY - c.y); });
}

// greet on start
setTimeout(() => doAntic("wave"), 800);

// debug/preview: ?mood=working  or  ?antic=zoom  (freezes the cat in that state)
{
  const q = new URLSearchParams(location.search);
  const m = q.get("mood"), a = q.get("antic");
  if (m || a) {
    clearTimeout(anticTimer); anticTimer = setTimeout(() => {}, 1e9);
    window.__debugMood = m || "idle";
    const force = () => { bridgeMood = window.__debugMood; renderMood(); };
    setInterval(force, 200); force();
    if (a) { doAntic(a); window.catSprite?.antic(a, 1e9); }
  }
}
