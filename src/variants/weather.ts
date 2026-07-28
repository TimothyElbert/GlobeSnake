import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Color, LineBasicMaterial, LineSegments, Mesh,
  ShaderMaterial, Vector3,
} from 'three';
import { DEG, anyTangent, fromLatLon, step, turn } from '@core/sphere';
import { WorldData, isWater } from '@core/world';

/**
 * Tempest's weather.
 *
 * Explicitly **not a simulation**. It is an analytic tangent vector field
 * evaluated per query: latitude-banded jet streams, trade winds, a handful of
 * ocean gyres, a curl-noise wobble, and moving vortex kernels for hurricanes.
 * That is a couple of hundred lines on top of the existing stepper instead of a
 * fluid solver, it is perfectly deterministic, and it costs nothing to sample a
 * thousand times a frame for the streamlines.
 *
 * The one design rule everything here answers to: **the wind is always visible
 * before it touches you.** Sol's objection to a weather variant was that being
 * shoved makes deaths feel arbitrary, and that objection is correct for
 * *invisible* forces. Streamlines are drawn over the whole visible hemisphere
 * and storms are drawn as spirals you can see from a continent away, so being
 * pushed is a navigation problem you chose to walk into — never a surprise.
 */

const _east = new Vector3();
const _north = new Vector3();
const _pole = new Vector3(0, 1, 0);

/** Local east/north basis at a point on the sphere. */
function basis(p: Vector3): void {
  _north.copy(_pole).addScaledVector(p, -p.y);
  if (_north.lengthSq() < 1e-10) {
    anyTangent(p, _north);
  } else {
    _north.normalize();
  }
  _east.copy(_north).cross(p).normalize(); // east = north × up
}

function gauss(x: number, sigma: number): number {
  const t = x / sigma;
  return Math.exp(-t * t);
}

/** Cheap deterministic value noise on the sphere. */
function noise3(x: number, y: number, z: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return s - Math.floor(s);
}

export interface Storm {
  /** Centre, a unit vector. */
  pos: Vector3;
  /** Travel direction, a unit tangent. */
  dir: Vector3;
  /** Peak tangential speed, degrees of arc per second. */
  strength: number;
  /** Angular radius of influence, radians. */
  radius: number;
  /** +1 northern (anticlockwise), −1 southern. */
  spin: number;
  age: number;
  life: number;
}

export interface WindOptions {
  jetStrength?: number;
  tradeStrength?: number;
  gyreStrength?: number;
  turbulence?: number;
  stormCount?: number;
}

export class WindField {
  readonly storms: Storm[] = [];
  private readonly jet: number;
  private readonly trade: number;
  private readonly gyre: number;
  private readonly turb: number;
  private readonly stormCount: number;
  private time = 0;

  /** The great ocean gyres, as centre + sense of rotation. */
  private readonly gyres: { pos: Vector3; spin: number; radius: number }[] = [
    { pos: fromLatLon(30, -45), spin: 1, radius: 0.55 },   // North Atlantic
    { pos: fromLatLon(-25, -25), spin: -1, radius: 0.55 }, // South Atlantic
    { pos: fromLatLon(30, -150), spin: 1, radius: 0.7 },   // North Pacific
    { pos: fromLatLon(-30, -120), spin: -1, radius: 0.7 }, // South Pacific
    { pos: fromLatLon(-30, 75), spin: -1, radius: 0.55 },  // Indian
  ];

  constructor(private readonly world: WorldData, opts: WindOptions = {}) {
    // Calibrated against a 3.6°/s snake: a jet is worth roughly +45% down-wind
    // and a comparable tax up-wind. Enough to reroute for, not enough to
    // override steering.
    this.jet = opts.jetStrength ?? 1.55;
    this.trade = opts.tradeStrength ?? 0.55;
    this.gyre = opts.gyreStrength ?? 0.9;
    this.turb = opts.turbulence ?? 0.35;
    this.stormCount = opts.stormCount ?? 4;
  }

  reset(rng: () => number): void {
    this.storms.length = 0;
    for (let i = 0; i < this.stormCount; i++) this.spawnStorm(rng);
    this.time = 0;
  }

  private spawnStorm(rng: () => number): void {
    // Real cyclones form over warm water away from the equator; so do these,
    // which also keeps them off the land where most targets live.
    for (let attempt = 0; attempt < 40; attempt++) {
      const lat = (5 + rng() * 22) * (rng() > 0.5 ? 1 : -1);
      const lon = rng() * 360 - 180;
      const pos = fromLatLon(lat, lon);
      if (!isWater(this.world.terrainAt(pos))) continue;
      const dir = new Vector3();
      anyTangent(pos, dir);
      // Track roughly westward then poleward, like the real thing.
      turn(pos, dir, rng() * Math.PI * 2);
      this.storms.push({
        pos,
        dir,
        strength: 2.2 + rng() * 1.8,
        radius: 0.10 + rng() * 0.07,
        spin: lat >= 0 ? 1 : -1,
        age: 0,
        life: 70 + rng() * 90,
      });
      return;
    }
  }

  update(dt: number, rng: () => number): void {
    this.time += dt;
    for (let i = this.storms.length - 1; i >= 0; i--) {
      const s = this.storms[i];
      s.age += dt;
      step(s.pos, s.dir, 0.5 * DEG * dt);
      turn(s.pos, s.dir, Math.sin(this.time * 0.15 + i) * 4 * DEG * dt);
      s.pos.normalize();
      s.dir.addScaledVector(s.pos, -s.dir.dot(s.pos)).normalize();
      // Storms weaken over land, exactly as they should.
      if (!isWater(this.world.terrainAt(s.pos))) s.strength *= 1 - dt * 0.5;
      if (s.age > s.life || s.strength < 0.4) {
        this.storms.splice(i, 1);
        this.spawnStorm(rng);
      }
    }
  }

  /**
   * Wind at a point, as a tangent vector whose magnitude is degrees per second.
   * Writes into `out`; allocation-free so the streamline pass can call it
   * thousands of times per frame.
   */
  sample(p: Vector3, out: Vector3): Vector3 {
    basis(p);
    const lat = Math.asin(Math.max(-1, Math.min(1, p.y))) * (180 / Math.PI);

    // Jet streams: two eastward cores per hemisphere.
    let u = this.jet * (gauss(lat - 32, 9) + gauss(lat + 32, 9));
    u += this.jet * 0.75 * (gauss(lat - 58, 8) + gauss(lat + 58, 8));
    // Trade winds blow from the east across the tropics.
    u -= this.trade * gauss(lat, 13);

    // A slow meridional wobble so the bands are ribbons, not stripes.
    let v = 0.22 * Math.sin(Math.atan2(-p.z, p.x) * 3 + this.time * 0.08) * gauss(lat, 60);

    // Turbulence from cheap value noise, biased small.
    const n1 = noise3(p.x * 7.3, p.y * 7.3, p.z * 7.3 + this.time * 0.05) - 0.5;
    const n2 = noise3(p.x * 5.1 + 11, p.y * 5.1, p.z * 5.1 - this.time * 0.04) - 0.5;
    u += n1 * this.turb * 2;
    v += n2 * this.turb * 2;

    out.copy(_east).multiplyScalar(u).addScaledVector(_north, v);

    // Ocean gyres, only where there is ocean to turn.
    if (isWater(this.world.terrainAt(p))) {
      for (const g of this.gyres) {
        const a = Math.acos(Math.max(-1, Math.min(1, p.dot(g.pos))));
        if (a > g.radius) continue;
        const falloff = Math.sin((a / g.radius) * Math.PI) * this.gyre;
        // Tangential flow: rotate the outward direction 90° about the surface.
        _tangential.copy(g.pos).addScaledVector(p, -p.dot(g.pos));
        if (_tangential.lengthSq() < 1e-10) continue;
        _tangential.normalize();
        _swirl.copy(_tangential).cross(p).multiplyScalar(g.spin * falloff);
        out.add(_swirl);
      }
    }

    // Hurricanes: a rotating vortex with an inward drift, so the eye pulls.
    for (const s of this.storms) {
      const a = Math.acos(Math.max(-1, Math.min(1, p.dot(s.pos))));
      if (a > s.radius) continue;
      const t = a / s.radius;
      // Zero at the dead centre and at the edge, peaking in the eyewall.
      const mag = s.strength * Math.sin(t * Math.PI) * (0.35 + 0.65 * t);
      _tangential.copy(s.pos).addScaledVector(p, -p.dot(s.pos));
      if (_tangential.lengthSq() < 1e-10) continue;
      _tangential.normalize();
      _swirl.copy(_tangential).cross(p).multiplyScalar(s.spin * mag);
      out.add(_swirl);
      out.addScaledVector(_tangential, mag * 0.18); // gentle inward pull
    }

    // Keep it strictly tangent; numerical drift here becomes altitude drift.
    out.addScaledVector(p, -out.dot(p));
    return out;
  }
}

const _tangential = new Vector3();
const _swirl = new Vector3();
const _axis = new Vector3();
const _tip = new Vector3();

/** How many seconds of travel each streak depicts, and its float height. */
const STREAK_SECONDS = 0.038;
const LIFT = 1.004;

/**
 * Streamlines.
 *
 * A cloud of massless particles advected by the field and drawn as short
 * fading streaks. This is the honesty mechanism: every push the player will
 * feel is legible several seconds before it arrives.
 */
export class WindStreaks {
  readonly lines: LineSegments;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly particles: { p: Vector3; age: number; life: number }[] = [];
  private readonly wind = new Vector3();
  private readonly count: number;

  constructor(private readonly field: WindField, count = 1400) {
    this.count = count;
    this.positions = new Float32Array(count * 6);
    this.colors = new Float32Array(count * 6);
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(this.positions, 3).setUsage(35048));
    geo.setAttribute('color', new BufferAttribute(this.colors, 3).setUsage(35048));
    geo.boundingSphere = null;
    this.lines = new LineSegments(geo, new LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.72,
      blending: AdditiveBlending,
      depthWrite: false,
    }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 2;

    for (let i = 0; i < count; i++) {
      this.particles.push({ p: new Vector3(1, 0, 0), age: 0, life: 0 });
    }
  }

  /** Seed particles near the head so the streaks are where the player is. */
  private respawn(i: number, centre: Vector3, rng: () => number): void {
    const q = this.particles[i];
    q.p.copy(centre);
    const dir = new Vector3();
    anyTangent(q.p, dir);
    turn(q.p, dir, rng() * Math.PI * 2);
    step(q.p, dir, (rng() ** 0.6) * 70 * DEG);
    q.p.normalize();
    q.age = 0;
    q.life = 1.6 + rng() * 2.4;
  }

  update(dt: number, centre: Vector3, rng: () => number): void {
    const pos = this.positions;
    const col = this.colors;
    for (let i = 0; i < this.count; i++) {
      const q = this.particles[i];
      q.age += dt;
      if (q.age > q.life || q.p.dot(centre) < 0.05) this.respawn(i, centre, rng);

      const o = i * 6;
      this.field.sample(q.p, this.wind);
      const speed = this.wind.length();

      // The streak is the *velocity vector*, not the distance moved since the
      // last frame. Drawing a per-frame delta made every streak a sub-pixel
      // dot that vanished at any frame rate, and worse, made the visuals
      // depend on frame rate. Now length reads directly as wind speed, which
      // is the whole promise of this variant: you can see the push coming.
      pos[o] = q.p.x * LIFT; pos[o + 1] = q.p.y * LIFT; pos[o + 2] = q.p.z * LIFT;
      if (speed > 1e-6) {
        _axis.copy(q.p).cross(this.wind).normalize();
        _tip.copy(q.p).applyAxisAngle(_axis, Math.min(speed * STREAK_SECONDS, 0.10)).normalize();
        pos[o + 3] = _tip.x * LIFT; pos[o + 4] = _tip.y * LIFT; pos[o + 5] = _tip.z * LIFT;
        q.p.applyAxisAngle(_axis, speed * DEG * dt * 6).normalize();
      } else {
        pos[o + 3] = pos[o]; pos[o + 4] = pos[o + 1]; pos[o + 5] = pos[o + 2];
      }

      // Fade in and out so streaks do not pop, and colour by wind speed:
      // cool blue when calm, hot white in a jet or an eyewall. Bright, because
      // these are drawn additively over a sunlit Sahara as often as over a
      // night ocean, and they have to survive both.
      const fade = Math.min(1, q.age / 0.35) * Math.min(1, (q.life - q.age) / 0.6);
      const heat = Math.min(1, speed / 2.4);
      const amp = (0.55 + heat * 1.35) * fade;
      const r = (0.34 + heat * 0.66) * amp;
      const g = (0.72 + heat * 0.28) * amp;
      const b = amp;
      // Dark at the tail, bright at the head, so each streak reads directionally.
      col[o] = r * 0.15; col[o + 1] = g * 0.15; col[o + 2] = b * 0.15;
      col[o + 3] = r; col[o + 4] = g; col[o + 5] = b;
    }
    const geo = this.lines.geometry;
    (geo.getAttribute('position') as BufferAttribute).needsUpdate = true;
    (geo.getAttribute('color') as BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.lines.geometry.dispose();
    (this.lines.material as LineBasicMaterial).dispose();
  }
}

const STORM_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const STORM_FRAG = /* glsl */ `
  precision highp float;
  uniform float uTime;
  uniform float uSpin;
  uniform float uStrength;
  varying vec2 vUv;
  void main() {
    vec2 d = vUv - 0.5;
    float r = length(d) * 2.0;
    if (r > 1.0) discard;
    float a = atan(d.y, d.x);
    // Logarithmic spiral arms, rotating. Two arms, like the satellite image
    // everyone has already seen — recognition matters more than accuracy here.
    float arms = sin(a * 2.0 + log(max(r, 0.04)) * 7.0 - uTime * uSpin * 2.2);
    float band = smoothstep(0.15, 0.95, arms) * smoothstep(1.0, 0.55, r) * smoothstep(0.03, 0.22, r);
    float eye = 1.0 - smoothstep(0.0, 0.09, r);
    float alpha = (band * 0.75 + eye * 0.25) * uStrength;
    vec3 col = mix(vec3(0.62, 0.78, 0.95), vec3(1.0), band * 0.6);
    gl_FragColor = vec4(col, alpha * 0.85);
  }
`;

/** One quad per storm, laid flat on the globe. */
export class StormSprites {
  readonly meshes: Mesh[] = [];
  private readonly materials: ShaderMaterial[] = [];

  constructor(max = 8) {
    for (let i = 0; i < max; i++) {
      const geo = new BufferGeometry();
      geo.setAttribute('position', new BufferAttribute(new Float32Array([
        -1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0,
      ]), 3));
      geo.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
      geo.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
      const mat = new ShaderMaterial({
        vertexShader: STORM_VERT,
        fragmentShader: STORM_FRAG,
        uniforms: { uTime: { value: 0 }, uSpin: { value: 1 }, uStrength: { value: 1 } },
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      });
      const mesh = new Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 3;
      mesh.visible = false;
      this.meshes.push(mesh);
      this.materials.push(mat);
    }
  }

  update(storms: Storm[], time: number): void {
    for (let i = 0; i < this.meshes.length; i++) {
      const mesh = this.meshes[i];
      const s = storms[i];
      if (!s) { mesh.visible = false; continue; }
      mesh.visible = true;
      const scale = Math.sin(s.radius) * 1.02;
      mesh.position.copy(s.pos).multiplyScalar(1.004);
      // Lay the quad tangent to the surface.
      _tangential.copy(s.pos).cross(_pole);
      if (_tangential.lengthSq() < 1e-8) _tangential.set(1, 0, 0);
      _tangential.normalize();
      _swirl.copy(s.pos).cross(_tangential).normalize();
      mesh.matrixAutoUpdate = false;
      mesh.matrix.makeBasis(
        _tangential.clone().multiplyScalar(scale),
        _swirl.clone().multiplyScalar(scale),
        s.pos.clone(),
      );
      mesh.matrix.setPosition(mesh.position);
      mesh.matrixWorldNeedsUpdate = true;
      const mat = this.materials[i];
      mat.uniforms.uTime.value = time;
      mat.uniforms.uSpin.value = s.spin;
      // Fade in on birth and out on death so nothing ever pops into existence.
      const fade = Math.min(1, s.age / 6) * Math.min(1, (s.life - s.age) / 8);
      mat.uniforms.uStrength.value = Math.max(0, Math.min(1, fade)) * Math.min(1, s.strength / 2.4);
    }
  }

  get colorHint(): Color {
    return new Color(0x8ce9ff);
  }
}
