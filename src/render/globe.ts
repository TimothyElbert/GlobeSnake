import {
  AdditiveBlending, BackSide, Color, Mesh, ShaderMaterial, Texture, Vector3, type WebGLRenderer,
} from 'three';
import { makeGlobeGeometry } from './globeGeometry';
import type { WorldData } from '@core/world';

/**
 * The Earth.
 *
 * One shader does the lot: day/night with a soft terminator and city lights,
 * an ocean specular lobe keyed off the *gameplay* terrain class rather than a
 * separate mask, country borders and a graticule derived from the same data the
 * simulation reads, and every hint overlay.
 *
 * Putting the hints in the globe shader rather than in geometry matters: a
 * highlight that is painted onto the surface curves with the planet, is
 * occluded by the horizon for free, and cannot z-fight with the snake.
 *
 * The night side is lifted to ~25% rather than going black. A pitch-dark
 * hemisphere is prettier in a screenshot and hostile in a game whose entire
 * verb is "find a place" — you would be hunting Nairobi by braille.
 */

const VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  void main() {
    vUv = uv;
    vNormal = normalize(normalMatrix * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const FRAG = /* glsl */ `
  precision highp float;

  uniform sampler2D uDay;
  uniform sampler2D uNight;
  uniform sampler2D uWorld;
  uniform vec2  uWorldTexel;
  uniform vec3  uSunDir;
  uniform float uTime;
  uniform float uNightLift;
  uniform float uBorders;
  uniform float uGraticule;
  uniform float uSaturation;
  uniform vec3  uAtmosphere;

  uniform float uHighlightCountry;
  uniform float uHighlightStrength;
  uniform vec3  uHighlightTint;

  uniform float uParchment;
  uniform sampler2D uInk;
  uniform float uInkAmount;

  uniform vec3  uWedgeOrigin;
  uniform vec3  uWedgeDir;
  uniform float uWedgeCos;
  uniform float uWedgeStrength;

  uniform vec3  uBandCenter;
  uniform float uBandMin;
  uniform float uBandMax;
  uniform float uBandStrength;

  uniform vec3  uRingCenter;
  uniform float uRingRadius;
  uniform float uRingStrength;

  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vWorldPos;

  // The data texture stores row 0 at the north pole and is uploaded flipY:false,
  // while image textures are flipY:true. One subtraction reconciles them.
  vec2 dataUv(vec2 uv) { return vec2(uv.x, 1.0 - uv.y); }

  float angleTo(vec3 a, vec3 b) {
    return acos(clamp(dot(a, b), -1.0, 1.0));
  }

  void main() {
    vec3 n = normalize(vNormal);
    vec3 sphereDir = normalize(vWorldPos);
    vec4 data = texture2D(uWorld, dataUv(vUv));
    float terrain = floor(data.b * 255.0 + 0.5);
    float country = floor(data.a * 255.0 + 0.5);
    float isWater = step(terrain, 1.5) + step(8.5, terrain) * step(terrain, 9.5);
    isWater = clamp(isWater, 0.0, 1.0);

    vec3 day = texture2D(uDay, vUv).rgb;
    vec3 night = texture2D(uNight, vUv).rgb;

    // Grade the plate for gameplay, not for fidelity. Blue Marble's ocean is a
    // strong saturated blue that, once properly lit, swallows the continents —
    // and the continents are where every target lives. So water is pushed down
    // and desaturated while land is lifted: the map has to be *readable* first
    // and photographic second.
    float lum = dot(day, vec3(0.299, 0.587, 0.114));
    day = mix(vec3(lum), day, mix(uSaturation, 0.80, isWater));
    day = pow(day, vec3(0.94));
    day *= mix(1.06, 0.95, isWater);
    // The bathymetry plate is nearly black over deep water, which renders as a
    // hole in the planet. A deep-ocean floor colour sits underneath it so the
    // sea reads as sea, with the real depth variation still riding on top.
    day += vec3(0.012, 0.052, 0.125) * isWater;

    float sun = dot(n, uSunDir);
    // Widen the terminator to about 12 degrees so dusk is a band, not an edge.
    float daylight = smoothstep(-0.21, 0.21, sun);

    vec3 col = day * mix(uNightLift, 1.0, daylight);
    col += night * (1.0 - daylight) * 1.35 * (1.0 - isWater);
    col *= mix(vec3(0.82, 0.88, 1.0), vec3(1.0), daylight); // cool the dark side

    // Specular glint off water. Kept deliberately tiny and very tight: the sun
    // is often near the camera, and a broad lobe turns the whole ocean into one
    // flat sheet of cyan that erases every coastline on screen.
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    vec3 halfV = normalize(viewDir + uSunDir);
    float spec = pow(max(dot(n, halfV), 0.0), 220.0) * isWater * daylight;
    col += vec3(0.55, 0.70, 0.85) * spec * 0.16;

    // --- country borders, sampled from the same grid the game logic reads ----
    if (uBorders > 0.001) {
      vec2 duv = dataUv(vUv);
      float c0 = country;
      float d = 0.0;
      d += abs(floor(texture2D(uWorld, duv + vec2(uWorldTexel.x, 0.0)).a * 255.0 + 0.5) - c0);
      d += abs(floor(texture2D(uWorld, duv - vec2(uWorldTexel.x, 0.0)).a * 255.0 + 0.5) - c0);
      d += abs(floor(texture2D(uWorld, duv + vec2(0.0, uWorldTexel.y)).a * 255.0 + 0.5) - c0);
      d += abs(floor(texture2D(uWorld, duv - vec2(0.0, uWorldTexel.y)).a * 255.0 + 0.5) - c0);
      col = mix(col, vec3(1.0, 0.92, 0.72), clamp(d, 0.0, 1.0) * 0.45 * uBorders);
    }

    // --- graticule: a stable reference frame so the eye is never lost --------
    if (uGraticule > 0.001) {
      float lat = degrees(asin(clamp(sphereDir.y, -1.0, 1.0)));
      float lon = degrees(atan(sphereDir.z, sphereDir.x));
      float latLine = abs(fract(lat / 15.0 + 0.5) - 0.5);
      float lonLine = abs(fract(lon / 15.0 + 0.5) - 0.5);
      float w = fwidth(lat / 15.0) * 0.9;
      float g = max(1.0 - smoothstep(0.0, w, latLine), 1.0 - smoothstep(0.0, fwidth(lon / 15.0) * 0.9, lonLine));
      // The equator earns a brighter line than the rest.
      float eq = 1.0 - smoothstep(0.0, fwidth(lat) * 1.4, abs(lat));
      col += vec3(0.55, 0.75, 0.95) * (g * 0.10 + eq * 0.16) * uGraticule;
    }

    // --- hint: highlight an entire country ----------------------------------
    if (uHighlightStrength > 0.001 && uHighlightCountry > 0.5) {
      float match = 1.0 - step(0.5, abs(country - uHighlightCountry));
      float pulse = 0.62 + 0.38 * sin(uTime * 3.4);
      col = mix(col, uHighlightTint, match * uHighlightStrength * 0.55 * pulse);
      col += uHighlightTint * match * uHighlightStrength * 0.25 * pulse;
    }

    // --- hint 1: bearing wedge cast from the player's position --------------
    // A purely additive overlay disappears against bright terrain — the first
    // build was invisible over the Sahara and over ocean glare alike. So the
    // wedge *dims everything outside it* as well as lifting what is inside:
    // contrast survives any background, which a glow does not.
    if (uWedgeStrength > 0.001) {
      vec3 toFrag = sphereDir - uWedgeOrigin * dot(uWedgeOrigin, sphereDir);
      float len = length(toFrag);
      if (len > 1e-5) {
        float align = dot(toFrag / len, uWedgeDir);
        float inside = smoothstep(uWedgeCos - 0.05, uWedgeCos + 0.05, align);
        float far = smoothstep(0.015, 0.20, angleTo(sphereDir, uWedgeOrigin));
        float pulse = 0.82 + 0.18 * sin(uTime * 2.2);
        col *= mix(1.0, 0.55, (1.0 - inside) * far * uWedgeStrength);
        col += vec3(0.30, 0.80, 1.0) * inside * far * 0.30 * pulse * uWedgeStrength;
        // A bright leading edge on each side of the wedge so the *bearing*
        // reads, not just a vague brighter region.
        float rim = 1.0 - smoothstep(0.0, 0.02, abs(align - uWedgeCos));
        col += vec3(0.55, 0.95, 1.0) * rim * far * 0.85 * uWedgeStrength;
      }
    }

    // --- hint 1: distance band ----------------------------------------------
    if (uBandStrength > 0.001) {
      float a = angleTo(sphereDir, uBandCenter);
      float band = smoothstep(uBandMin - 0.012, uBandMin + 0.012, a)
                 * (1.0 - smoothstep(uBandMax - 0.012, uBandMax + 0.012, a));
      float edge = (1.0 - smoothstep(0.0, 0.016, abs(a - uBandMin)))
                 + (1.0 - smoothstep(0.0, 0.016, abs(a - uBandMax)));
      col += vec3(0.35, 0.85, 1.0) * (band * 0.14 + edge * 1.1) * uBandStrength;
    }

    // --- hint 2: search circle around the target ----------------------------
    if (uRingStrength > 0.001) {
      float a = angleTo(sphereDir, uRingCenter);
      float fill = 1.0 - smoothstep(uRingRadius - 0.02, uRingRadius, a);
      float edge = 1.0 - smoothstep(0.0, 0.018, abs(a - uRingRadius));
      float pulse = 0.7 + 0.3 * sin(uTime * 2.6);
      col = mix(col, vec3(1.0, 0.86, 0.45), fill * 0.20);
      col += vec3(1.0, 0.82, 0.35) * (fill * 0.08 + edge * 0.85 * pulse) * uRingStrength;
    }

    // --- Terra Incognita: vellum, and ink where you have been ---------------
    // Note this runs *before* the hint overlays, so the wedge, band and ring
    // all still work on a hand-drawn globe without a second code path.
    if (uParchment > 0.5) {
      float inked = clamp(texture2D(uInk, dataUv(vUv)).r * uInkAmount, 0.0, 1.0);

      // Laid paper: two crossed sine grains plus blotchy age. Flat cream reads
      // as a beige bug; grain reads as a material.
      float grain = sin(vUv.x * 2200.0) * 0.5 + sin(vUv.y * 1500.0) * 0.5;
      float blotch = texture2D(uWorld, dataUv(vUv) * 3.0).r;
      vec3 paper = vec3(0.878, 0.827, 0.718)
                 * (1.0 + grain * 0.012)
                 * (0.94 + blotch * 0.10);
      // Age the edges of the visible disc, like a globe gore that has been handled.
      paper *= 1.0 - pow(1.0 - max(dot(n, viewDir), 0.0), 3.0) * 0.22;

      // Coastline, from the same terrain grid the physics reads. Always faintly
      // embossed so navigation is possible from the first second — hiding the
      // map turns "find Paris" into a random walk, which is why both council
      // members killed fog-of-war on sight.
      vec2 duv = dataUv(vUv);
      float w0 = step(terrain, 1.5);
      float edge = 0.0;
      edge += abs(step(floor(texture2D(uWorld, duv + vec2(uWorldTexel.x, 0.0)).b * 255.0 + 0.5), 1.5) - w0);
      edge += abs(step(floor(texture2D(uWorld, duv - vec2(uWorldTexel.x, 0.0)).b * 255.0 + 0.5), 1.5) - w0);
      edge += abs(step(floor(texture2D(uWorld, duv + vec2(0.0, uWorldTexel.y)).b * 255.0 + 0.5), 1.5) - w0);
      edge += abs(step(floor(texture2D(uWorld, duv - vec2(0.0, uWorldTexel.y)).b * 255.0 + 0.5), 1.5) - w0);
      edge = clamp(edge, 0.0, 1.0);

      // Inked land: sepia washes keyed to climate, hachured where it is steep.
      // These have to sit *well* away from the paper colour. The first pass
      // used period-accurate pale washes and the result was invisible: a fully
      // drawn map looked identical to a blank one, which threw away the entire
      // mechanic. An antique plate is low-contrast in the hand and needs real
      // separation on a screen.
      float elev = max(0.0, floor(data.r * 255.0 + 0.5) - 100.0) / 155.0;
      vec3 wash = mix(vec3(0.706, 0.596, 0.400), vec3(0.470, 0.376, 0.231), elev * 1.7);
      wash = mix(wash, vec3(0.404, 0.443, 0.318), step(3.5, terrain) * step(terrain, 4.5) * 0.75);
      wash = mix(wash, vec3(0.796, 0.694, 0.427), step(4.5, terrain) * step(terrain, 5.5) * 0.85);
      wash = mix(wash, vec3(0.804, 0.816, 0.831), step(6.5, terrain) * step(terrain, 7.5) * 0.8);
      vec3 sea = vec3(0.545, 0.596, 0.596);
      // Ruled sea lines, the way an engraver would fill open water.
      sea *= 1.0 - smoothstep(0.35, 0.5, abs(fract(vUv.y * 700.0) - 0.5)) * 0.13;
      vec3 drawn = mix(sea, wash, 1.0 - w0);

      // Hachures on mountains: short strokes running with the slope.
      float hach = step(5.5, terrain) * step(terrain, 6.5);
      drawn *= 1.0 - hach * smoothstep(0.3, 0.5, abs(fract((vUv.x + vUv.y) * 900.0) - 0.5)) * 0.45;

      vec3 ink = vec3(0.192, 0.129, 0.075);
      vec3 pc = mix(paper, drawn, inked);
      // Coast is a whisper until you have been there, then a drawn line.
      pc = mix(pc, ink, edge * (0.20 + 0.80 * inked));
      // Graticule in faded red ochre, as on an old plate.
      float lat2 = degrees(asin(clamp(sphereDir.y, -1.0, 1.0)));
      float lon2 = degrees(atan(sphereDir.z, sphereDir.x));
      float gl = max(
        1.0 - smoothstep(0.0, fwidth(lat2 / 15.0) * 0.9, abs(fract(lat2 / 15.0 + 0.5) - 0.5)),
        1.0 - smoothstep(0.0, fwidth(lon2 / 15.0) * 0.9, abs(fract(lon2 / 15.0 + 0.5) - 0.5)));
      pc = mix(pc, vec3(0.545, 0.298, 0.212), gl * 0.16);

      col = pc;
    }

    // --- limb darkening + atmospheric scatter on the rim --------------------
    // The exponent here matters far more than it looks. The chase camera sits
    // low, so nearly the whole visible surface is at a grazing angle and rim is
    // large almost everywhere — at pow 3.6 this term stopped being a limb glow
    // and became a blue wash over the entire planet. Blue Marble's ocean is
    // almost black, so that wash *was* the ocean colour, and no amount of
    // grading the plate could fix it. At pow 8 it goes back to being the limb.
    float rim = 1.0 - max(dot(n, viewDir), 0.0);
    col += uAtmosphere * pow(rim, 8.0) * (0.35 + 0.65 * daylight) * 0.45;

    gl_FragColor = vec4(col, 1.0);
  }
`;

const ATMO_VERT = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const ATMO_FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uColor;
  uniform vec3 uSunDir;
  uniform float uIntensity;
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  void main() {
    vec3 n = normalize(vNormal);
    vec3 viewDir = normalize(cameraPosition - vWorldPos);

    // Only the far half of this shell is drawn, and only where it escapes the
    // planet's silhouette — so the visible annulus runs from "just outside the
    // horizon" (where the outward normal points well away from the camera) to
    // the shell's own edge (where it is exactly side-on). Keying off -dot puts
    // the glow brightest against the planet and fading into space, which is the
    // way round an atmosphere actually looks. Using 1+dot, as this did at
    // first, produced a hard-edged blue ring floating off the limb.
    float t = clamp(-dot(n, viewDir), 0.0, 1.0);
    float rim = pow(t, 1.1) * (1.0 - smoothstep(0.72, 1.0, t));
    float lit = smoothstep(-0.45, 0.40, dot(normalize(vWorldPos), uSunDir));
    gl_FragColor = vec4(uColor, 1.0) * rim * uIntensity * (0.16 + 0.84 * lit);
  }
`;

export interface GlobeOptions {
  nightLift?: number;
  saturation?: number;
  atmosphere?: number;
  graticule?: number;
  segments?: [number, number];
  /** Terra Incognita: render as inked vellum instead of satellite imagery. */
  parchment?: boolean;
  /** Single-channel reveal texture; red = how thoroughly this texel is drawn. */
  inkTexture?: Texture;
  atmosphereColor?: number;
}

export class Globe {
  readonly mesh: Mesh;
  readonly atmosphere: Mesh;
  readonly material: ShaderMaterial;
  private readonly atmoMaterial: ShaderMaterial;
  private readonly sunDir = new Vector3(1, 0.25, 0.4).normalize();

  constructor(world: WorldData, day: Texture, night: Texture, opts: GlobeOptions = {}) {
    const [ls, lts] = opts.segments ?? [256, 128];
    this.material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uDay: { value: day },
        uNight: { value: night },
        uWorld: { value: world.texture },
        uWorldTexel: { value: [1 / world.width, 1 / world.height] },
        uSunDir: { value: this.sunDir },
        uTime: { value: 0 },
        // The night side stays legible rather than going dark. A real
        // terminator is the best thing on screen, but a game whose only verb is
        // "recognise this place" cannot ask you to do it in the dark for three
        // minutes at a stretch. Dim, cool and completely readable.
        uNightLift: { value: opts.nightLift ?? 0.6 },
        uBorders: { value: 0 },
        uGraticule: { value: opts.graticule ?? 1 },
        uSaturation: { value: opts.saturation ?? 1.18 },
        uAtmosphere: { value: new Color(opts.atmosphereColor ?? 0x4a9fe0) },
        uHighlightCountry: { value: 0 },
        uHighlightStrength: { value: 0 },
        uHighlightTint: { value: new Color(0xffc94a) },
        uParchment: { value: opts.parchment ? 1 : 0 },
        uInk: { value: opts.inkTexture ?? world.texture },
        uInkAmount: { value: 1 },
        uWedgeOrigin: { value: new Vector3(1, 0, 0) },
        uWedgeDir: { value: new Vector3(0, 1, 0) },
        uWedgeCos: { value: Math.cos(Math.PI / 4) },
        uWedgeStrength: { value: 0 },
        uBandCenter: { value: new Vector3(1, 0, 0) },
        uBandMin: { value: 0 },
        uBandMax: { value: 0 },
        uBandStrength: { value: 0 },
        uRingCenter: { value: new Vector3(1, 0, 0) },
        uRingRadius: { value: 0.2 },
        uRingStrength: { value: 0 },
      },
    });

    this.mesh = new Mesh(makeGlobeGeometry(ls, lts, 1), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 0;

    this.atmoMaterial = new ShaderMaterial({
      vertexShader: ATMO_VERT,
      fragmentShader: ATMO_FRAG,
      uniforms: {
        uColor: { value: new Color(opts.atmosphereColor ?? 0x5aa9ff) },
        uSunDir: { value: this.sunDir },
        uIntensity: { value: opts.atmosphere ?? 1.9 },
      },
      side: BackSide,
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    // Wide enough that the halo is a gradient rather than a line, tight enough
    // that it stays a halo. At 1.10 it was a band thicker than Africa.
    this.atmosphere = new Mesh(makeGlobeGeometry(96, 48, 1.045), this.atmoMaterial);
    this.atmosphere.frustumCulled = false;
    this.atmosphere.renderOrder = 2;
  }

  /** Sun position for a given fraction of the day, plus a mild axial tilt. */
  setSunPhase(phase: number): void {
    const a = phase * Math.PI * 2;
    this.sunDir.set(Math.cos(a), 0.32, Math.sin(a)).normalize();
  }

  get sun(): Vector3 {
    return this.sunDir;
  }

  update(time: number): void {
    this.material.uniforms.uTime.value = time;
  }

  setBorders(on: boolean): void {
    this.material.uniforms.uBorders.value = on ? 1 : 0;
  }

  /** Point the parchment shader at the live reveal texture. */
  setInkTexture(tex: Texture): void {
    this.material.uniforms.uInk.value = tex;
  }

  setInkAmount(v: number): void {
    this.material.uniforms.uInkAmount.value = v;
  }

  setGraticule(v: number): void {
    this.material.uniforms.uGraticule.value = v;
  }

  highlightCountry(index: number, strength: number, tint = 0xffc94a): void {
    const u = this.material.uniforms;
    u.uHighlightCountry.value = index;
    u.uHighlightStrength.value = strength;
    (u.uHighlightTint.value as Color).setHex(tint);
  }

  setWedge(origin: Vector3, dir: Vector3, halfAngleRad: number, strength: number): void {
    const u = this.material.uniforms;
    (u.uWedgeOrigin.value as Vector3).copy(origin);
    (u.uWedgeDir.value as Vector3).copy(dir);
    u.uWedgeCos.value = Math.cos(halfAngleRad);
    u.uWedgeStrength.value = strength;
  }

  setBand(centre: Vector3, minRad: number, maxRad: number, strength: number): void {
    const u = this.material.uniforms;
    (u.uBandCenter.value as Vector3).copy(centre);
    u.uBandMin.value = minRad;
    u.uBandMax.value = maxRad;
    u.uBandStrength.value = strength;
  }

  setRing(centre: Vector3, radiusRad: number, strength: number): void {
    const u = this.material.uniforms;
    (u.uRingCenter.value as Vector3).copy(centre);
    u.uRingRadius.value = radiusRad;
    u.uRingStrength.value = strength;
  }

  clearHints(): void {
    const u = this.material.uniforms;
    u.uWedgeStrength.value = 0;
    u.uBandStrength.value = 0;
    u.uRingStrength.value = 0;
    u.uHighlightStrength.value = 0;
  }

  setQuality(renderer: WebGLRenderer, low: boolean): void {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, low ? 1 : 1.5));
    this.atmoMaterial.uniforms.uIntensity.value = low ? 1.2 : 1.9;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.atmosphere.geometry.dispose();
    this.atmoMaterial.dispose();
  }
}
