import {
  AdditiveBlending, BackSide, BufferAttribute, BufferGeometry, Color, ConeGeometry, Group, Mesh,
  MeshBasicMaterial, Object3D, ShaderMaterial, SphereGeometry, Vector3,
} from 'three';
import { climateColor } from '@core/world';

/**
 * Scene furniture: the snake's head, the target pin, and the sky.
 */

const _bin = new Vector3();
const _col = new Color();
const _lookAt = new Vector3();
const _white = new Color(0xffffff);

/**
 * The head.
 *
 * A ribbon alone reads as a racing line, not an animal. Two eyes and a flicking
 * tongue cost almost nothing and are the entire difference between "a coloured
 * curve" and "a snake" — which matters, because the fantasy is what makes a
 * geography quiz feel like a game.
 */
export class SnakeHead {
  readonly group = new Group();
  private readonly skull: Mesh;
  private readonly tongue: Mesh;
  private readonly eyes: Mesh[] = [];
  private readonly material: MeshBasicMaterial;
  private tongueTimer = 0;

  constructor(scale = 1) {
    this.material = new MeshBasicMaterial({ color: 0x4fd18b });
    this.skull = new Mesh(new SphereGeometry(1, 20, 14), this.material);
    // Squash into a wedge: long, low and wider at the back.
    this.skull.scale.set(0.016, 0.010, 0.013).multiplyScalar(scale);
    this.group.add(this.skull);

    const eyeGeo = new SphereGeometry(1, 10, 8);
    const eyeWhite = new MeshBasicMaterial({ color: 0xfff6e0 });
    const pupil = new MeshBasicMaterial({ color: 0x14202a });
    for (const side of [-1, 1]) {
      const e = new Mesh(eyeGeo, eyeWhite);
      e.scale.setScalar(0.0042 * scale);
      e.position.set(0.006 * scale, 0.005 * scale, side * 0.0072 * scale);
      const p = new Mesh(eyeGeo, pupil);
      p.scale.setScalar(0.0024 * scale);
      p.position.set(0.0028 * scale, 0, 0);
      e.add(p);
      this.eyes.push(e);
      this.group.add(e);
    }

    this.tongue = new Mesh(
      new ConeGeometry(0.0016 * scale, 0.014 * scale, 5),
      new MeshBasicMaterial({ color: 0xff5c7a }),
    );
    this.tongue.rotation.z = -Math.PI / 2;
    this.tongue.position.set(0.020 * scale, 0.0005 * scale, 0);
    this.group.add(this.tongue);

    this.group.renderOrder = 3;
  }

  /**
   * Orient from the snake's own basis. Building the matrix by hand from
   * (binormal, normal, heading) is exact and avoids the pole flip that lookAt
   * would introduce when the snake crosses the Arctic.
   */
  update(position: Vector3, heading: Vector3, climate: number, lift: number, time: number): void {
    // makeBasis(x, y, z) wants a right-handed triple, so z = x × y.
    _bin.copy(heading).cross(position).normalize();
    const r = 1 + lift + 0.006;
    this.group.position.copy(position).multiplyScalar(r);
    this.group.matrixAutoUpdate = false;
    this.group.matrix.makeBasis(heading, position, _bin);
    this.group.matrix.setPosition(this.group.position);
    this.group.matrixWorldNeedsUpdate = true;

    _col.setHex(climateColor(climate));
    // A shade brighter than the body it leads — but only a shade. Pushed
    // further it stops reading as a head and starts reading as a white bead
    // stuck on the front.
    this.material.color.copy(_col).lerp(_white, 0.12);

    this.tongueTimer += time;
    const flick = Math.max(0, Math.sin(time * 2.1));
    this.tongue.scale.x = 0.4 + flick * flick * 1.4;
    this.tongue.visible = flick > 0.25;
  }

  setEyeGlow(on: boolean): void {
    for (const e of this.eyes) (e.material as MeshBasicMaterial).color.setHex(on ? 0xa8ffe4 : 0xfff6e0);
  }
}

const PIN_VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorldPos;
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const PIN_FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    // Two expanding rings and a soft core: a radar ping, painted on a quad
    // that always faces the surface normal.
    float d = length(vUv - 0.5) * 2.0;
    if (d > 1.0) discard;
    float core = 1.0 - smoothstep(0.0, 0.22, d);
    float r1 = fract(uTime * 0.65);
    float r2 = fract(uTime * 0.65 + 0.5);
    float ring = 0.0;
    ring += (1.0 - smoothstep(0.0, 0.06, abs(d - r1))) * (1.0 - r1);
    ring += (1.0 - smoothstep(0.0, 0.06, abs(d - r2))) * (1.0 - r2);
    float a = clamp(core * 1.2 + ring * 0.9, 0.0, 1.0) * uOpacity;
    gl_FragColor = vec4(uColor, a);
  }
`;

/** The exact-location pin. Only ever shown at hint level 3, or on capture. */
export class TargetPin {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;

  constructor(color = 0xffc94a, sizeRad = 0.06) {
    const geo = new BufferGeometry();
    const s = sizeRad;
    geo.setAttribute('position', new BufferAttribute(new Float32Array([
      -s, -s, 0, s, -s, 0, s, s, 0, -s, s, 0,
    ]), 3));
    geo.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    geo.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));

    this.material = new ShaderMaterial({
      vertexShader: PIN_VERT,
      fragmentShader: PIN_FRAG,
      uniforms: {
        uColor: { value: new Color(color) },
        uTime: { value: 0 },
        uOpacity: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.mesh = new Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.mesh.visible = false;
  }

  setPosition(unit: Vector3, lift = 0.004): void {
    this.mesh.position.copy(unit).multiplyScalar(1 + lift);
    // Lay the quad flat against the sphere. The up vector has to be chosen
    // *before* lookAt reads it, and it must not be parallel to the surface
    // normal — otherwise the pin degenerates at the poles.
    this.mesh.up.set(0, 1, 0);
    if (Math.abs(unit.y) > 0.99) this.mesh.up.set(1, 0, 0);
    _lookAt.copy(this.mesh.position).add(unit);
    this.mesh.lookAt(_lookAt);
  }

  setOpacity(v: number): void {
    this.material.uniforms.uOpacity.value = v;
    this.mesh.visible = v > 0.01;
  }

  setColor(hex: number): void {
    (this.material.uniforms.uColor.value as Color).setHex(hex);
  }

  update(time: number): void {
    this.material.uniforms.uTime.value = time;
  }
}

const SKY_FRAG = /* glsl */ `
  precision highp float;
  uniform float uTime;
  uniform float uBrightness;
  uniform vec3 uTint;
  varying vec3 vDir;

  float hash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  void main() {
    vec3 dir = normalize(vDir);
    // Three octaves of a cell-based star field: cheap, stable under rotation,
    // and no 4 MB cube map to download.
    vec3 col = vec3(0.0);
    for (int i = 0; i < 3; i++) {
      float scale = 90.0 + float(i) * 130.0;
      vec3 cell = floor(dir * scale);
      float h = hash(cell);
      if (h > 0.9945 - float(i) * 0.0012) {
        vec3 centre = (cell + 0.5 + (vec3(hash(cell + 1.0), hash(cell + 2.0), hash(cell + 3.0)) - 0.5) * 0.7) / scale;
        float d = length(normalize(centre) - dir) * scale;
        float star = exp(-d * d * 5.0);
        float twinkle = 0.75 + 0.25 * sin(uTime * 1.6 + h * 40.0);
        // Give a few of them colour so the sky is not all white pinpricks.
        vec3 tint = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.86, 0.7), hash(cell + 7.0));
        col += star * twinkle * tint * (0.6 + h * 0.9);
      }
    }
    // A faint band of Milky Way haze across the sky.
    float band = exp(-pow(dot(dir, normalize(vec3(0.35, 0.82, -0.45))), 2.0) * 12.0);
    col += uTint * band * 0.035;
    gl_FragColor = vec4(col * uBrightness, 1.0);
  }
`;

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export class Starfield {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;

  constructor(brightness = 1, tint = 0x6d8fd0) {
    this.material = new ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uBrightness: { value: brightness },
        uTint: { value: new Color(tint) },
      },
      side: BackSide,
      depthWrite: false,
    });
    this.mesh = new Mesh(new SphereGeometry(40, 24, 16), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
  }

  update(time: number): void {
    this.material.uniforms.uTime.value = time;
  }

  setBrightness(v: number): void {
    this.material.uniforms.uBrightness.value = v;
  }
}

/** Keep an object planted on the sphere, tangent-aligned. */
export function orientOnSphere(obj: Object3D, unit: Vector3, forward: Vector3, lift: number): void {
  _bin.copy(forward).cross(unit).normalize();
  obj.position.copy(unit).multiplyScalar(1 + lift);
  obj.matrixAutoUpdate = false;
  obj.matrix.makeBasis(forward, unit, _bin);
  obj.matrix.setPosition(obj.position);
  obj.matrixWorldNeedsUpdate = true;
}
