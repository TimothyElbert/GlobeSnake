import {
  AdditiveBlending, BufferAttribute, BufferGeometry, LinearFilter, Mesh, OrthographicCamera,
  RGBAFormat, Scene, ShaderMaterial, UnsignedByteType, Vector3, WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';

/**
 * The reveal texture for Terra Incognita.
 *
 * An equirectangular render target that the snake stamps into as it travels.
 * It accumulates on the GPU and is never read back, never re-uploaded, and
 * never cleared mid-run — which is the whole point, because in this world the
 * line you draw is permanent.
 *
 * The obvious alternative, drawing into a 2D canvas and re-uploading it as a
 * texture, would push two megabytes across the bus every frame to change a few
 * hundred pixels. This costs one 64-pixel quad per stamp.
 */

const STAMP_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const STAMP_FRAG = /* glsl */ `
  precision highp float;
  uniform float uStrength;
  varying vec2 vUv;
  void main() {
    float d = length(vUv - 0.5) * 2.0;
    if (d > 1.0) discard;
    // Soft-edged nib: hard in the middle, feathering out, so overlapping
    // strokes build up like real ink rather than tiling into visible discs.
    float a = pow(1.0 - d, 1.8);
    gl_FragColor = vec4(vec3(a * uStrength), 1.0);
  }
`;

export class InkMap {
  private readonly rt: WebGLRenderTarget;
  private readonly scene = new Scene();
  private readonly camera: OrthographicCamera;
  private readonly quad: Mesh;
  private readonly material: ShaderMaterial;
  private readonly width: number;
  private readonly height: number;
  private needsClear = true;

  constructor(width = 2048, height = 1024) {
    this.width = width;
    this.height = height;
    this.rt = new WebGLRenderTarget(width, height, {
      format: RGBAFormat,
      type: UnsignedByteType,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    // The globe shader samples this with the same convention as world.bin:
    // v = 0 is the north pole.
    this.rt.texture.flipY = false;

    // A unit-square orthographic space so stamp coordinates are just UVs.
    this.camera = new OrthographicCamera(0, 1, 1, 0, -1, 1);

    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
    ]), 3));
    geo.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    geo.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));

    this.material = new ShaderMaterial({
      vertexShader: STAMP_VERT,
      fragmentShader: STAMP_FRAG,
      uniforms: { uStrength: { value: 0.55 } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: AdditiveBlending,
    });

    this.quad = new Mesh(geo, this.material);
    this.scene.add(this.quad);
  }

  get texture() {
    return this.rt.texture;
  }

  /** Dev only: how much of the map has been inked, as a 0..1 fraction. */
  coverage(renderer: WebGLRenderer): number {
    const w = 64;
    const h = 32;
    const buf = new Uint8Array(w * h * 4);
    renderer.readRenderTargetPixels(this.rt, 0, 0, w, h, buf);
    let sum = 0;
    for (let i = 0; i < w * h; i++) sum += buf[i * 4];
    return sum / (w * h * 255);
  }

  /** Wipe the map. Called at the start of a run, never during one. */
  clear(renderer: WebGLRenderer): void {
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.rt);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, false, false);
    renderer.setRenderTarget(prev);
    this.needsClear = false;
  }

  /**
   * Ink a point on the sphere.
   * @param radiusDeg how wide the nib is, in degrees of arc
   */
  stamp(renderer: WebGLRenderer, p: Vector3, radiusDeg: number, strength = 0.55): void {
    if (this.needsClear) this.clear(renderer);

    const lat = Math.asin(Math.max(-1, Math.min(1, p.y))) * (180 / Math.PI);
    const lon = Math.atan2(-p.z, p.x) * (180 / Math.PI);
    const u = lon / 360 + 0.5;
    const v = 0.5 - lat / 180;   // 0 at the north pole, matching world.bin

    // Longitude compresses toward the poles, so a fixed-size quad would be a
    // needle at the equator and a smear in the Arctic. Widen in u by 1/cos(lat)
    // and cap it, or an Arctic stroke would try to cover the whole width.
    const clat = Math.max(0.12, Math.cos((lat * Math.PI) / 180));
    const sv = (radiusDeg * 2) / 180;
    const su = Math.min(1.0, (radiusDeg * 2) / 360 / clat);

    const prev = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.rt);
    this.material.uniforms.uStrength.value = strength;

    this.quad.scale.set(su, sv, 1);
    this.quad.position.set(u, v, 0);
    this.quad.updateMatrixWorld(true);
    renderer.render(this.scene, this.camera);

    // The antimeridian is a seam in UV space but not on the planet; stamp the
    // wrapped copy so a stroke across the Pacific does not get cut in half.
    if (u < su) {
      this.quad.position.set(u + 1, v, 0);
      this.quad.updateMatrixWorld(true);
      renderer.render(this.scene, this.camera);
    } else if (u > 1 - su) {
      this.quad.position.set(u - 1, v, 0);
      this.quad.updateMatrixWorld(true);
      renderer.render(this.scene, this.camera);
    }

    renderer.setRenderTarget(prev);
    renderer.autoClear = prevAuto;
  }

  markForClear(): void {
    this.needsClear = true;
  }

  get size(): [number, number] {
    return [this.width, this.height];
  }

  dispose(): void {
    this.rt.dispose();
    this.quad.geometry.dispose();
    this.material.dispose();
  }
}
