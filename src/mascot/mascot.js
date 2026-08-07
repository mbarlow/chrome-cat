// Mascot engine: renders ASCII pixel frames from mascot.json onto a small
// canvas, monochrome in the theme's --fg. The app drives coarse states
// (idle/scanning/replying/working); the engine layers cat behavior on idle —
// blink, swat, pounce, stretch, and sleep after inactivity. Swap the mascot
// by editing the JSON; no code changes, no binary assets.

export async function loadMascotConfig() {
  const res = await fetch(chrome.runtime.getURL("src/mascot/mascot.json"));
  if (!res.ok) throw new Error(`mascot.json: ${res.status}`);
  return res.json();
}

export class Mascot {
  constructor(canvas, config) {
    this.canvas = canvas;
    this.config = config;
    this.cell = config.cell || 2;
    canvas.width = config.canvas.cols * this.cell;
    canvas.height = config.canvas.rows * this.cell;
    this.timer = null;
    this.frame = 0;
    this._cur = null;      // state actually playing (may be a behavior)
    this._extState = "idle"; // state the app asked for
    this.lastActivity = Date.now();
    this._play("idle");
  }

  color() {
    return getComputedStyle(document.documentElement).getPropertyValue("--fg").trim() || "#e6edf3";
  }

  // App API. Unknown states fall back to idle so config swaps can't crash UI.
  setState(name) {
    if (!this.config.states[name]) name = "idle";
    this._extState = name;
    this.lastActivity = Date.now();
    if (this._cur !== name) this._play(name);
  }

  wake() {
    this.lastActivity = Date.now();
    if (this._cur === "sleeping") this._play("idle");
  }

  destroy() {
    clearInterval(this.timer);
  }

  _play(name) {
    const st = this.config.states[name];
    if (!st) return;
    this._cur = name;
    this.frame = 0;
    clearInterval(this.timer);
    this._draw();
    this.timer = setInterval(() => this._tick(), 1000 / (st.fps || this.config.defaultFps || 3));
  }

  _tick() {
    const st = this.config.states[this._cur];
    this.frame++;
    if (this.frame >= st.frames.length) {
      if (st.once) {
        // One-shots return to whatever the app currently wants.
        this._play(this._extState === this._cur ? "idle" : this._extState);
        return;
      }
      this.frame = 0;
      if (this._cur === "idle") this._idleAntics();
    }
    this._draw();
  }

  // Rolled once per idle loop: sleep beats everything after the timeout,
  // otherwise one weighted behavior may fire.
  _idleAntics() {
    if (this._extState !== "idle") return;
    const sleepAfter = this.config.sleepAfterMs ?? 60_000;
    if (this.config.states.sleeping && Date.now() - this.lastActivity > sleepAfter) {
      this._play("sleeping");
      return;
    }
    for (const b of this.config.idleBehaviors || []) {
      if (this.config.states[b.state] && Math.random() < b.chance) {
        this._play(b.state);
        return;
      }
    }
  }

  _draw() {
    const st = this.config.states[this._cur];
    const rows = st.frames[Math.min(this.frame, st.frames.length - 1)];
    const ctx = this.canvas.getContext("2d");
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.fillStyle = this.color();
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        if (row[x] === "#") ctx.fillRect(x * this.cell, y * this.cell, this.cell, this.cell);
      }
    });
  }
}
