import { BufferGeometry, BufferAttribute } from 'three';
import { DEG } from '@core/sphere';

/**
 * A sphere built to our own coordinate convention rather than Three's.
 *
 * SphereGeometry's UVs run the wrong way round for an equirectangular map
 * (u = 0.5 lands on Greenwich, not the antimeridian), and reconciling that in
 * the shader means computing UVs from atan2 — which detonates the derivative
 * at the ±180° seam and produces a visible mipmap scar down the Pacific.
 *
 * Generating the sphere directly costs twenty lines and gives us:
 *   - u = 0 exactly at lon −180, u = 1 exactly at lon +180
 *   - v = 1 at the north pole, matching a flipY image texture
 *   - duplicated vertices along the seam, so nothing interpolates across it
 * and, most importantly, positions produced by the same fromLatLon the physics
 * uses. Visuals and simulation cannot drift apart because they are the same map.
 */
export function makeGlobeGeometry(lonSegments = 256, latSegments = 128, radius = 1): BufferGeometry {
  const cols = lonSegments + 1;
  const rows = latSegments + 1;
  const count = cols * rows;

  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);

  let p = 0;
  let t = 0;
  for (let r = 0; r < rows; r++) {
    const v = r / latSegments;             // 0 at north pole
    const lat = (90 - v * 180) * DEG;
    const cl = Math.cos(lat);
    const sl = Math.sin(lat);
    for (let c = 0; c < cols; c++) {
      const u = c / lonSegments;           // 0 at lon −180
      const lon = (-180 + u * 360) * DEG;
      const x = cl * Math.cos(lon);
      const y = sl;
      const z = cl * Math.sin(lon);
      normals[p] = x; normals[p + 1] = y; normals[p + 2] = z;
      positions[p] = x * radius; positions[p + 1] = y * radius; positions[p + 2] = z * radius;
      p += 3;
      uvs[t] = u; uvs[t + 1] = 1 - v;      // v = 1 at the north pole
      t += 2;
    }
  }

  const indices = new Uint32Array(lonSegments * latSegments * 6);
  let i = 0;
  for (let r = 0; r < latSegments; r++) {
    for (let c = 0; c < lonSegments; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const d = a + cols;
      const e = d + 1;
      indices[i++] = a; indices[i++] = d; indices[i++] = b;
      indices[i++] = b; indices[i++] = d; indices[i++] = e;
    }
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(positions, 3));
  geo.setAttribute('normal', new BufferAttribute(normals, 3));
  geo.setAttribute('uv', new BufferAttribute(uvs, 2));
  geo.setIndex(new BufferAttribute(indices, 1));
  geo.computeBoundingSphere();
  return geo;
}
