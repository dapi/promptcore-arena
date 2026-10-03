import { DEFAULT_FIGHTERS, normalizeFighters, avatarUrl } from "./fighters.js";
const same = (a, b) => a?.[0] === b?.[0] && a?.[1] === b?.[1];
const dist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
const ease = (t) => 1 - (1 - t) ** 3;
export class Arena {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.setFighters(DEFAULT_FIGHTERS);
    this.frame = null;
    this.previous = null;
    this.pov = "all";
    this.since = 0;
    this.reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }
  setFighters(value) {
    this.fighters=normalizeFighters(value);
    this.sprites??=new Map();
    for(const f of this.fighters){const url=avatarUrl(f);if(!this.sprites.has(url)){const image=new Image();image.src=url;this.sprites.set(url,image);}}
  }
  setFrame(frame, animate = true) {
    this.previous = this.frame;
    this.frame = frame;
    this.since = performance.now();
    this.animate = animate && !this.reduced;
  }
  setPov(pov) {
    this.pov = pov;
  }
  visible(pos) {
    if (this.pov === "all") return true;
    const s = this.frame.state,
      a = s.agents.find((a) => a.id === this.pov);
    return (
      dist(a.pos, pos) <= (a.scanUntil > 0 && a.scanUntil >= s.turn ? 6 : 3)
    );
  }
  point(p) {
    return [30 + (p[0] + 0.5) * 65, 30 + (p[1] + 0.5) * 65];
  }
  line(from, to, color, width = 1, glow = 0) {
    const c = this.ctx;
    c.beginPath();
    c.moveTo(...from);
    c.lineTo(...to);
    c.strokeStyle = color;
    c.lineWidth = width;
    c.shadowBlur = glow;
    c.shadowColor = color;
    c.stroke();
    c.shadowBlur = 0;
  }
  circle(p, r, color, width = 1, glow = 0, fill = false) {
    const c = this.ctx;
    c.beginPath();
    c.arc(...p, r, 0, Math.PI * 2);
    c.shadowBlur = glow;
    c.shadowColor = color;
    c.lineWidth = width;
    if (fill) {
      c.fillStyle = color;
      c.fill();
    } else {
      c.strokeStyle = color;
      c.stroke();
    }
    c.shadowBlur = 0;
  }
  loop(t) {
    if (this.frame && !document.hidden) this.draw(t);
    requestAnimationFrame(this.loop);
  }
  draw(t) {
    const COLORS=Object.fromEntries(this.fighters.map(f=>[f.id,f.color]));
    const c = this.ctx,
      s = this.frame.state,
      time = this.reduced ? 0 : t * 0.001,
      age = (t - this.since) / 1000,
      mix = this.animate ? ease(Math.min(1, age / 0.7)) : 1;
    c.clearRect(0, 0, 840, 840);
    c.fillStyle = "#09150f";
    c.fillRect(0, 0, 840, 840);
    const bg = c.createRadialGradient(420, 420, 40, 420, 420, 550);
    bg.addColorStop(0, "#203d234d");
    bg.addColorStop(1, "#07110c00");
    c.fillStyle = bg;
    c.fillRect(0, 0, 840, 840);
    c.font = "10px monospace";
    c.textAlign = "center";
    c.fillStyle = "#5f8068";
    for (let i = 0; i < 12; i++) {
      c.fillText(String(i).padStart(2, "0"), 62.5 + i * 65, 18);
      c.fillText(String(i).padStart(2, "0"), 15, 66 + i * 65);
    }
    for (let y = 0; y < 12; y++)
      for (let x = 0; x < 12; x++) {
        const px = 30 + x * 65,
          py = 30 + y * 65;
        c.fillStyle = (x + y) % 2 ? "#14251a" : "#122217";
        c.fillRect(px + 1, py + 1, 63, 63);
        c.strokeStyle = "#32523c55";
        c.lineWidth = 0.65;
        c.strokeRect(px, py, 65, 65);
        c.fillStyle = "#557d5944";
        c.fillRect(px - 1, py - 1, 2, 2);
      }
    for (const p of s.points) {
      const [x, y] = this.point(p);
      c.fillStyle = "#94d95c14";
      c.fillRect(x - 31, y - 31, 62, 62);
      c.strokeStyle = "#b6f58255";
      c.lineWidth = 1;
      c.strokeRect(x - 27, y - 27, 54, 54);
    }
    const pulse = 0.5 + 0.5 * Math.sin(time * 1.8);
    this.circle([420, 420], 54, "#abd67244", 1);
    this.circle([420, 420], 44, "#b6f58233", 1);
    this.line(
      [402, 420],
      [438, 420],
      `rgba(193,248,135,${0.25 + pulse * 0.25})`,
      1,
    );
    this.line(
      [420, 402],
      [420, 438],
      `rgba(193,248,135,${0.25 + pulse * 0.25})`,
      1,
    );
    c.font = "8px monospace";
    c.fillStyle = "#b6f58277";
    c.fillText("CORE", 420, 443);
    for (const p of s.walls) {
      const [x, y] = this.point(p);
      c.fillStyle = "#07120b";
      c.fillRect(x - 24, y - 20, 52, 51);
      c.fillStyle = "#263e2e";
      c.fillRect(x - 26, y - 27, 52, 48);
      c.fillStyle = "#36523d";
      c.fillRect(x - 26, y - 27, 52, 4);
      c.fillStyle = "#192d21";
      c.fillRect(x - 26, y + 17, 52, 10);
      c.strokeStyle = "#4e6e4e77";
      c.lineWidth = 1;
      c.strokeRect(x - 26, y - 27, 52, 44);
      this.line([x - 18, y - 17], [x + 16, y + 6], "#46654b55");
      this.line([x - 18, y - 8], [x + 5, y + 7], "#46654b55");
    }
    for (const v of s.sources) {
      const [x, y] = this.point(v.pos);
      const alpha = 0.35 + (v.amount / 12) * 0.65;
      c.globalAlpha = alpha;
      this.circle([x, y], 21, "#e4bf7533", 1);
      c.save();
      c.translate(x, y);
      c.rotate(Math.PI / 4);
      c.shadowColor = "#f2c779";
      c.shadowBlur = 14 + pulse * 7;
      c.fillStyle = "#e6c57c";
      c.fillRect(-5, -5, 10, 10);
      c.shadowBlur = 0;
      c.strokeStyle = "#f8d89377";
      c.strokeRect(-10, -10, 20, 20);
      c.restore();
      c.globalAlpha = 1;
      c.font = "8px monospace";
      c.fillStyle = "#b9a975";
      c.fillText(v.amount, x, y + 28);
    }
    for (const trap of s.traps) {
      const a = s.agents.find((a) => a.id === this.pov);
      if (
        this.pov !== "all" &&
        trap.owner !== this.pov &&
        dist(a.pos, trap.pos) > 1 &&
        (a.scanUntil === 0 || a.scanUntil < s.turn)
      )
        continue;
      const [x, y] = this.point(trap.pos);
      this.circle([x, y], 14, "#ffa58055", 1);
      this.line([x - 8, y - 8], [x + 8, y + 8], "#f5a07b", 2);
      this.line([x + 8, y - 8], [x - 8, y + 8], "#f5a07b", 2);
    }
    for (const a of s.agents) {
      if (!this.visible(a.pos)) continue;
      const old = this.previous?.state.agents.find((b) => b.id === a.id),
        from = old?.pos ?? a.pos;
      const pos = [
          from[0] + (a.pos[0] - from[0]) * mix,
          from[1] + (a.pos[1] - from[1]) * mix,
        ],
        [x, y] = this.point(pos),
        color = COLORS[a.id];
      if (a.hp <= 0) {
        this.line([x - 12, y - 12], [x + 12, y + 12], color + "66", 2);
        this.line([x + 12, y - 12], [x - 12, y + 12], color + "66", 2);
        continue;
      }
      if (mix < 1 && !same(from, a.pos))
        this.line(this.point(from), [x, y], color + "66", 2, 7);
      const glow = c.createRadialGradient(x, y, 2, x, y, 43);
      glow.addColorStop(0, color + "2a");
      glow.addColorStop(1, color + "00");
      c.fillStyle = glow;
      c.fillRect(x - 43, y - 43, 86, 86);
      this.circle([x, y + 2], 27, color + "44", 1);
      const fighter=this.fighters.find(f=>f.id===a.id);
      const sprite=this.sprites.get(avatarUrl(fighter));
      if(sprite?.complete){c.shadowColor=color;c.shadowBlur=12;c.drawImage(sprite,x-25,y-25,50,50);c.shadowBlur=0;}

      c.fillStyle = "#050b08";
      c.fillRect(x - 22, y + 30, 44, 4);
      c.fillStyle = color;
      c.fillRect(x - 22, y + 30, (44 * a.hp) / 10, 4);
      c.fillStyle = color;
      c.font = "bold 9px monospace";
      c.fillText(a.id, x, y - 31);
      if (this.frame.decisions?.[a.id]?.action === "defend") {
        this.circle([x, y], 32, color + "99", 2, 10);
        this.circle([x, y], 35, color + "22", 1);
      }
    }
    if (this.animate && age < 1.3)
      for (const e of this.frame.events) {
        if (
          (e.pos && !this.visible(e.pos)) ||
          (e.to && !this.visible(e.to)) ||
          (e.from && !this.visible(e.from))
        )
          continue;
        const color = COLORS[e.actor] ?? "#f4bd7a";
        c.globalAlpha = Math.max(0, 1 - age / 1.3);
        if (["attack", "miss"].includes(e.type)) {
          const from = this.point(e.from),
            to = this.point(e.to),
            hit = e.type === "attack";
          this.line(from, to, color, age < 0.2 ? 6 : 2, 18);
          this.line(from, to, "#ffffffbb", 1, 3);
          if (hit) {
            this.circle(to, 8 + age * 42, "#ffdf9a", 2, 18);
            for (let i = 0; i < 10; i++) {
              const a = (i * Math.PI) / 5;
              this.circle(
                [
                  to[0] + Math.cos(a) * age * 75,
                  to[1] + Math.sin(a) * age * 75,
                ],
                2,
                color,
                1,
                9,
                true,
              );
            }
          }
        }
        if (e.type === "scan") {
          this.circle(this.point(e.pos), age * 190, color + "aa", 2, 15);
          this.circle(this.point(e.pos), age * 135, color + "44", 1);
        }
        if (e.type === "explosion" || e.type === "death") {
          const p = this.point(e.to ?? e.pos);
          this.circle(p, age * 80 + 5, "#ffae77", 4, 25);
        }
        if (e.type === "harvest") {
          const from = this.point(e.pos),
            to = this.point(e.to);
          for (let i = 0; i < 5; i++) {
            const f = (age * 1.5 + i * 0.15) % 1;
            this.circle(
              [
                from[0] + (to[0] - from[0]) * f,
                from[1] + (to[1] - from[1]) * f,
              ],
              3,
              "#f4d078",
              1,
              12,
              true,
            );
          }
        }
        if (e.type === "attack" || e.type === "explosion") {
          const p = this.point(e.to);
          c.fillStyle = "#fff2d2";
          c.font = "bold 23px monospace";
          c.fillText(`−${e.damage}`, p[0], p[1] - 25 - age * 40);
        }
        c.globalAlpha = 1;
      }
    if (this.pov !== "all")
      for (let y = 0; y < 12; y++)
        for (let x = 0; x < 12; x++)
          if (!this.visible([x, y])) {
            c.fillStyle = "#050c09";
            c.fillRect(30 + x * 65, 30 + y * 65, 65, 65);
            c.strokeStyle = "#15231a";
            c.strokeRect(30 + x * 65, 30 + y * 65, 65, 65);
          }
    // Slow atmospheric sweep, independent of the turn rate.
    if (!this.reduced) {
      const sy = 30 + ((time * 24) % 780);
      c.fillStyle = "#bbff9910";
      c.fillRect(30, sy, 780, 1);
    }
  }
}
