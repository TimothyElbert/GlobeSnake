import '@ui/launcher.css';

/**
 * Launcher backdrop: a slowly turning wireframe globe with a snake tracing a
 * great circle around it.
 *
 * Deliberately hand-drawn on a 2D canvas rather than spun up as a fourth
 * Three.js scene — the front page must paint instantly on a cold load, and
 * nobody should download a WebGL renderer and a 2 MB planet just to read what
 * the game is.
 */

const canvas = document.getElementById('backdrop') as HTMLCanvasElement | null;
if (canvas) {
  const ctx = canvas.getContext('2d')!;
  let w = 0;
  let h = 0;
  let dpr = 1;

  const resize = (): void => {
    dpr = Math.min(window.devicePixelRatio, 2);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  window.addEventListener('resize', resize);

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Stars, fixed in place so the eye has something still to rest on.
  const stars = Array.from({ length: 220 }, () => ({
    x: Math.random(),
    y: Math.random(),
    r: Math.random() * 1.25 + 0.25,
    a: Math.random() * 0.5 + 0.15,
    tw: Math.random() * Math.PI * 2,
  }));

  const project = (lat: number, lon: number, spin: number, cx: number, cy: number, R: number) => {
    const la = (lat * Math.PI) / 180;
    const lo = ((lon + spin) * Math.PI) / 180;
    const x = Math.cos(la) * Math.cos(lo);
    const y = Math.sin(la);
    const z = Math.cos(la) * Math.sin(lo);
    // Tilt the pole toward the viewer a little; a dead-on equator reads flat.
    const tilt = 0.32;
    const yt = y * Math.cos(tilt) - z * Math.sin(tilt);
    const zt = y * Math.sin(tilt) + z * Math.cos(tilt);
    return { x: cx + x * R, y: cy - yt * R, front: zt > 0 };
  };

  let t = 0;
  const draw = (): void => {
    t += reduced ? 0 : 0.0022;
    ctx.clearRect(0, 0, w, h);

    for (const s of stars) {
      const a = s.a * (0.65 + 0.35 * Math.sin(t * 40 + s.tw));
      ctx.fillStyle = `rgba(190, 214, 245, ${a})`;
      ctx.beginPath();
      ctx.arc(s.x * w, s.y * h, s.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // The globe sits off to the right and mostly below the fold, so it frames
    // the text instead of competing with it.
    const R = Math.min(w, h) * (w < 760 ? 0.52 : 0.44);
    const cx = w * (w < 760 ? 0.78 : 0.80);
    const cy = h * 0.56;
    const spin = t * 24;

    ctx.lineWidth = 1;
    for (let lat = -60; lat <= 60; lat += 20) {
      ctx.beginPath();
      let started = false;
      for (let lon = -180; lon <= 180; lon += 4) {
        const p = project(lat, lon, spin, cx, cy, R);
        if (!p.front) { started = false; continue; }
        if (started) ctx.lineTo(p.x, p.y);
        else { ctx.moveTo(p.x, p.y); started = true; }
      }
      ctx.strokeStyle = `rgba(110, 165, 215, ${lat === 0 ? 0.20 : 0.09})`;
      ctx.stroke();
    }
    for (let lon = -180; lon < 180; lon += 20) {
      ctx.beginPath();
      let started = false;
      for (let lat = -88; lat <= 88; lat += 4) {
        const p = project(lat, lon, spin, cx, cy, R);
        if (!p.front) { started = false; continue; }
        if (started) ctx.lineTo(p.x, p.y);
        else { ctx.moveTo(p.x, p.y); started = true; }
      }
      ctx.strokeStyle = 'rgba(110, 165, 215, 0.075)';
      ctx.stroke();
    }

    // Limb.
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(120, 180, 235, 0.22)';
    ctx.stroke();

    // A snake, riding an inclined great circle.
    const inc = 34;
    const len = 78;
    const headLon = -(t * 150) % 360;
    ctx.lineCap = 'round';
    for (let i = 0; i < len; i++) {
      const f = i / len;
      const lon = headLon + i * 2.1;
      const lat = Math.sin((lon * Math.PI) / 180) * inc;
      const p = project(lat, lon, spin, cx, cy, R * 1.012);
      if (!p.front) continue;
      const hue = 150 + Math.sin(lon * 0.03) * 40;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3.4 * (1 - f * 0.75), 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${hue}, 62%, ${58 - f * 12}%, ${0.92 - f * 0.7})`;
      ctx.fill();
    }

    requestAnimationFrame(draw);
  };
  draw();
}
