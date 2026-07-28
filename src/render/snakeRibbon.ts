import {
  BufferAttribute, BufferGeometry, Color, DoubleSide, Mesh, ShaderMaterial, Vector3,
} from 'three';
import type { Snake } from '@core/snake';
import { RELIEF_SCALE, climateColor } from '@core/world';

/**
 * The snake's body, as a ribbon laid on the sphere.
 *
 * The body is coloured by the climate of the ground it was laid on, node by
 * node — so a long snake becomes a readable record of the journey: emerald
 * where it crossed the Congo, amber through the Sahara, ice-blue over Siberia.
 * That is also, not incidentally, the artwork on the end-of-run share card,
 * which is why the colours are chosen to sit next to each other rather than to
 * look good in isolation.
 *
 * Geometry is rebuilt each frame from the trail, but the vertex budget is
 * capped: the ribbon only ever draws the most recent MAX_RIBBON_NODES samples,
 * so a fifteen-minute run costs exactly what the first minute did. Variants
 * that keep an indelible path (Terra Incognita) paint the older history into a
 * texture instead of carrying it as triangles.
 */

const DEFAULT_MAX_NODES = 4096;
/** Nodes over which the head swells and the tail tapers to a point. */
const TAPER_NODES = 90;

const VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aAlong;   // 0 at the tail, 1 at the head
  attribute float aSide;    // -1 or +1 across the ribbon
  varying vec3 vColor;
  varying float vAlong;
  varying float vSide;
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  void main() {
    vColor = aColor;
    vAlong = aAlong;
    vSide = aSide;
    vNormal = normalize(normalMatrix * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  uniform vec3  uSunDir;
  uniform float uTime;
  uniform float uWake;        // 0..1 draft charge
  uniform float uWakeAlong;   // where along the body the drafted segment sits
  uniform vec3  uRimColor;
  uniform float uScalePitch;
  varying vec3 vColor;
  uniform float uHeadAlong;
  varying float vAlong;
  varying float vSide;
  varying vec3 vNormal;
  varying vec3 vWorldPos;

  void main() {
    vec3 n = normalize(vNormal);
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    // Distance behind the head, in the same units aAlong is measured in.
    float behind = uHeadAlong - vAlong;

    // Fake a rounded cross-section: shade as if the flat ribbon were a tube.
    float across = clamp(vSide, -1.0, 1.0);
    float bulge = sqrt(max(0.0, 1.0 - across * across));
    vec3 col = vColor;

    // Scales: a diamond lattice running along the body.
    float scales = sin(vAlong * uScalePitch + across * 3.0) * sin(across * 7.0);
    col *= 0.90 + 0.12 * scales;

    float lambert = 0.42 + 0.58 * clamp(dot(n, uSunDir) * 0.5 + 0.5, 0.0, 1.0);
    col *= lambert * (0.68 + 0.42 * bulge);

    // A darker belly line and a lit spine give the tube a readable axis.
    col *= 1.0 - 0.22 * smoothstep(0.55, 1.0, abs(across));
    col += vColor * 0.22 * pow(bulge, 6.0);

    // Rim light picks the body off the planet behind it. Kept low: at half
    // strength it bleached the body to near-white and threw away the entire
    // point of colouring it by biome.
    float rim = pow(1.0 - max(dot(n, viewDir), 0.0), 2.4);
    col += uRimColor * rim * 0.22;

    // Wake-riding: a bright pulse travels the drafted stretch of body.
    if (uWake > 0.001) {
      float d = abs(vAlong - uWakeAlong);
      float band = exp(-d * d * 3000.0);
      float travel = 0.5 + 0.5 * sin(uTime * 9.0 - vAlong * 9.0);
      col += vec3(0.55, 0.95, 1.0) * band * travel * uWake * 1.4;
      col += vec3(0.2, 0.6, 0.9) * uWake * 0.18;
    }

    // The head end is always slightly hotter, so the eye knows which way is forward.
    col += vColor * (1.0 - smoothstep(0.0, 0.09, behind)) * 0.35;

    gl_FragColor = vec4(col, 1.0);
  }
`;

const _p = new Vector3();
const _prev = new Vector3();
const _next = new Vector3();
const _tan = new Vector3();
const _bin = new Vector3();
const _col = new Color();
const _colB = new Color();
const _dryInk = new Color(0x5a3d22);

export interface RibbonOptions {
  /** Half-width of the body, in globe radii. */
  width?: number;
  /** How far the ribbon floats above the surface, in globe radii. */
  lift?: number;
  rimColor?: number;
  scalePitch?: number;
  /**
   * Vertex budget in trail nodes.
   *
   * This has to cover the *whole* lethal body, not just the pretty part.
   * Terra Incognita keeps its trail forever, so anything the ribbon declined
   * to draw would still kill you — an invisible wall is the single most unfair
   * thing a game like this can do.
   */
  maxNodes?: number;
  /**
   * Terra Incognita only: how many nodes behind the head the body stops being
   * a snake and becomes drawn map.
   *
   * With a permanent trail the honest question is "is the snake supposed to
   * just extend forever?", and if the whole thing keeps rendering as a fat live
   * body the honest answer looks like "yes, and that's a bug". Narrowing and
   * darkening the older stretch into dried ink says what is actually true: the
   * animal is the last few degrees, and everything behind it is the map you
   * drew. It stays clearly visible, because it is still lethal.
   */
  dryAfterNodes?: number;
  dryFadeNodes?: number;
  dryWidth?: number;
  dryColor?: number;
}

export class SnakeRibbon {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;
  private readonly geometry: BufferGeometry;
  private readonly positions: Float32Array;
  private readonly normals: Float32Array;
  private readonly colors: Float32Array;
  private readonly along: Float32Array;
  private readonly sides: Float32Array;
  private readonly width: number;
  private readonly lift: number;
  private readonly maxNodes: number;
  private readonly dryAfter: number;
  private readonly dryFade: number;
  private readonly dryWidth: number;
  /** Window currently resident in the vertex buffer. */
  private builtFirst = -1;
  private builtLast = -1;

  constructor(opts: RibbonOptions = {}) {
    this.width = opts.width ?? 0.0135;
    this.lift = opts.lift ?? 0.0035;
    this.maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES;
    this.dryAfter = opts.dryAfterNodes ?? 0;
    this.dryFade = Math.max(1, opts.dryFadeNodes ?? 90);
    this.dryWidth = opts.dryWidth ?? 0.45;
    _dryInk.setHex(opts.dryColor ?? 0x5a3d22);
    const MAX_RIBBON_NODES = this.maxNodes;

    const verts = MAX_RIBBON_NODES * 2;
    this.positions = new Float32Array(verts * 3);
    this.normals = new Float32Array(verts * 3);
    this.colors = new Float32Array(verts * 3);
    this.along = new Float32Array(verts);
    this.sides = new Float32Array(verts);

    const indices = new Uint32Array((MAX_RIBBON_NODES - 1) * 6);
    for (let i = 0, w = 0; i < MAX_RIBBON_NODES - 1; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      indices[w++] = a; indices[w++] = c; indices[w++] = b;
      indices[w++] = b; indices[w++] = c; indices[w++] = d;
    }

    this.geometry = new BufferGeometry();
    this.geometry.setAttribute('position', new BufferAttribute(this.positions, 3).setUsage(35048));
    this.geometry.setAttribute('normal', new BufferAttribute(this.normals, 3).setUsage(35048));
    this.geometry.setAttribute('aColor', new BufferAttribute(this.colors, 3).setUsage(35048));
    this.geometry.setAttribute('aAlong', new BufferAttribute(this.along, 1).setUsage(35048));
    this.geometry.setAttribute('aSide', new BufferAttribute(this.sides, 1).setUsage(35048));
    this.geometry.setIndex(new BufferAttribute(indices, 1));
    this.geometry.setDrawRange(0, 0);
    // The body wraps the planet; a bounding sphere that big just disables the
    // frustum test anyway, so skip it and save the recompute.
    this.geometry.boundingSphere = null;

    this.material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uSunDir: { value: new Vector3(1, 0, 0) },
        uTime: { value: 0 },
        uWake: { value: 0 },
        uWakeAlong: { value: 0 },
        uRimColor: { value: new Color(opts.rimColor ?? 0x9fe8ff) },
        uScalePitch: { value: opts.scalePitch ?? 2000 },
        uHeadAlong: { value: 0 },
      },
      side: DoubleSide,
    });

    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  /**
   * Write vertices for trail nodes [from, to] into slots relative to `first`.
   *
   * The taper is measured in *nodes from each end* rather than as a fraction
   * of the body. That looks the same, and it means a vertex, once written,
   * never has to change again — which is what makes the incremental path below
   * legal for a trail that never releases its tail.
   */
  private taperNodes = TAPER_NODES;

  private writeRange(snake: Snake, first: number, last: number, from: number, to: number): void {
    this.taperNodes = Math.max(6, Math.min(TAPER_NODES, (last - first) * 0.3));
    const pos = this.positions;
    const nrm = this.normals;
    const cols = this.colors;
    const along = this.along;
    const sides = this.sides;

    for (let i = from; i <= to; i++) {
      // Ride the terrain. Each node remembers the ground height it was laid on,
      // so the body climbs the Andes and drops into the Amazon exactly as the
      // displaced globe does — which is the only way the speed penalty for
      // mountains is legible before you are already crawling.
      const r = 1 + snake.reliefAtNode(i) * RELIEF_SCALE + this.lift;
      const k = i - first;
      snake.nodeAt(i, _p);
      snake.nodeAt(i > first ? i - 1 : i, _prev);
      snake.nodeAt(i < last ? i + 1 : i, _next);

      // Tangent from the neighbours, projected into the tangent plane so the
      // ribbon lies flat on the sphere instead of shearing through it.
      _tan.copy(_next).sub(_prev);
      _tan.addScaledVector(_p, -_tan.dot(_p));
      if (_tan.lengthSq() < 1e-12) _tan.set(0, 1, 0).addScaledVector(_p, -_p.y);
      _tan.normalize();
      _bin.copy(_p).cross(_tan).normalize();

      const fromTail = k;
      const fromHead = last - i;
      // The taper length has to be capped against the body's own length. A
      // fixed 90-node taper on a 58-node starting body meant the *entire*
      // snake was tail, and it rendered as a needle rather than an animal.
      const taperTail = Math.min(1, Math.pow(fromTail / this.taperNodes, 0.5));
      const taperHead = 1 - 0.28 * Math.pow(Math.max(0, 1 - fromHead / 22), 2);
      // 0 while this stretch is still the animal, 1 once it has become map.
      const dry = this.dryAfter > 0
        ? Math.min(1, Math.max(0, (fromHead - this.dryAfter) / this.dryFade))
        : 0;
      const w = this.width * taperTail * taperHead * (1 - dry * (1 - this.dryWidth));

      // Blend each node's climate with its neighbour so biome changes read as
      // gradients rather than as painted stripes.
      _col.setHex(climateColor(snake.climateAtNode(i)));
      _colB.setHex(climateColor(snake.climateAtNode(i > first ? i - 1 : i)));
      _col.lerp(_colB, 0.5);
      if (dry > 0) _col.lerp(_dryInk, dry * 0.88);

      const v0 = k * 2, v1 = v0 + 1;
      const o0 = v0 * 3, o1 = v1 * 3;

      pos[o0] = _p.x * r + _bin.x * w;
      pos[o0 + 1] = _p.y * r + _bin.y * w;
      pos[o0 + 2] = _p.z * r + _bin.z * w;
      pos[o1] = _p.x * r - _bin.x * w;
      pos[o1 + 1] = _p.y * r - _bin.y * w;
      pos[o1 + 2] = _p.z * r - _bin.z * w;

      nrm[o0] = _p.x; nrm[o0 + 1] = _p.y; nrm[o0 + 2] = _p.z;
      nrm[o1] = _p.x; nrm[o1 + 1] = _p.y; nrm[o1 + 2] = _p.z;

      cols[o0] = _col.r; cols[o0 + 1] = _col.g; cols[o0 + 2] = _col.b;
      cols[o1] = _col.r; cols[o1 + 1] = _col.g; cols[o1 + 2] = _col.b;

      // One unit per thousand nodes: a stable coordinate that does not rescale
      // as the body grows, so old vertices stay valid.
      const a = k / 1000;
      along[v0] = a; along[v1] = a;
      sides[v0] = 1; sides[v1] = -1;
    }
  }

  update(snake: Snake, sunDir: Vector3, time: number): void {
    const first = Math.max(snake.firstBodyNode, snake.nodeCount - this.maxNodes);
    const last = snake.nodeCount - 1;
    const n = last - first + 1;
    if (n < 3) {
      this.geometry.setDrawRange(0, 0);
      this.builtFirst = -1;
      return;
    }

    // A vacating tail slides the window every frame, so there is nothing to
    // reuse and a full rebuild is both simplest and cheap (a growing body caps
    // out around 2,700 nodes). A permanent trail keeps `first` pinned at zero,
    // and then only the newly-laid nodes and the moving head taper need
    // rewriting — which is what makes a 40,000-node body affordable at all.
    // The rewrite window has to cover the drying transition as well as the new
    // nodes, because "how far behind the head am I" changes for every node in
    // that band each frame.
    const canReuse = this.builtFirst === first && this.builtLast >= first && this.builtLast <= last;
    const window = 30 + (this.dryAfter > 0 ? this.dryAfter + this.dryFade : 0);
    const from = canReuse ? Math.max(first, this.builtLast - window) : first;
    this.writeRange(snake, first, last, from, last);

    const dirtyStart = (from - first) * 2;
    const dirtyCount = (last - from + 1) * 2;
    for (const name of ['position', 'normal', 'aColor', 'aAlong', 'aSide']) {
      const attr = this.geometry.getAttribute(name) as BufferAttribute;
      attr.updateRanges.length = 0;
      attr.addUpdateRange(dirtyStart * attr.itemSize, dirtyCount * attr.itemSize);
      attr.needsUpdate = true;
    }
    this.geometry.setDrawRange(0, (n - 1) * 6);
    this.builtFirst = first;
    this.builtLast = last;

    const u = this.material.uniforms;
    (u.uSunDir.value as Vector3).copy(sunDir);
    u.uTime.value = time;
    u.uWake.value = snake.wake.charge;
    u.uHeadAlong.value = (last - first) / 1000;
    u.uWakeAlong.value = snake.wake.targetNode >= first
      ? (snake.wake.targetNode - first) / 1000
      : 0;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
