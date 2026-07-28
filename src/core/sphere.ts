import { Vector3 } from 'three';

/**
 * Spherical locomotion primitives.
 *
 * The whole game runs on unit vectors on S². There is deliberately no lat/lon in
 * the simulation loop: lat/lon has singularities at the poles and non-uniform
 * spacing everywhere, both of which show up as gameplay bugs. Positions are unit
 * vectors, headings are unit tangents, and movement is rotation.
 *
 * Coordinate convention (used identically by the shaders, so visuals and physics
 * cannot drift apart):
 *
 *   x = cos(lat) * cos(lon)
 *   y = sin(lat)
 *   z = cos(lat) * sin(lon)
 *
 * so +y is the north pole, and lon 0 (Greenwich) points along +x.
 */

export const EARTH_RADIUS_KM = 6371;
const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/** Scratch vectors. The sim runs at 120 Hz; nothing in here may allocate. */
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();

export function fromLatLon(latDeg: number, lonDeg: number, out = new Vector3()): Vector3 {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  const cl = Math.cos(lat);
  return out.set(cl * Math.cos(lon), Math.sin(lat), cl * Math.sin(lon));
}

/** Returns [latDeg, lonDeg]. Allocates a 2-tuple; not for the hot path. */
export function toLatLon(p: Vector3): [number, number] {
  return [Math.asin(clamp(p.y, -1, 1)) * RAD, Math.atan2(p.z, p.x) * RAD];
}

export function latOf(p: Vector3): number {
  return Math.asin(clamp(p.y, -1, 1)) * RAD;
}

export function lonOf(p: Vector3): number {
  return Math.atan2(p.z, p.x) * RAD;
}

/**
 * Advance along the great circle defined by (p, h) by angle theta.
 *
 * With a = normalize(p × h) we have a × p = h and a × h = -p exactly, so
 * Rodrigues' rotation about a collapses to a plain 2D rotation inside the
 * (p, h) plane. No quaternions, no trig beyond one sin/cos pair, no drift
 * from an accumulated rotation matrix.
 */
export function step(p: Vector3, h: Vector3, theta: number): void {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const px = p.x, py = p.y, pz = p.z;
  const hx = h.x, hy = h.y, hz = h.z;
  p.set(px * c + hx * s, py * c + hy * s, pz * c + hz * s);
  h.set(hx * c - px * s, hy * c - py * s, hz * c - pz * s);
}

/** Rotate the heading about the surface normal by `angle` radians (+ve = right). */
export function turn(p: Vector3, h: Vector3, angle: number): void {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  // r = p × h is a unit vector because p ⊥ h and both are unit.
  const rx = p.y * h.z - p.z * h.y;
  const ry = p.z * h.x - p.x * h.z;
  const rz = p.x * h.y - p.y * h.x;
  h.set(h.x * c + rx * s, h.y * c + ry * s, h.z * c + rz * s);
}

/**
 * Re-establish |p| = |h| = 1 and h ⊥ p. Floating point error accumulates over
 * tens of thousands of steps and eventually the snake spirals off the sphere;
 * calling this once per tick is cheap insurance.
 */
export function reorthonormalize(p: Vector3, h: Vector3): void {
  p.normalize();
  h.addScaledVector(p, -h.dot(p)).normalize();
}

/**
 * Angular distance in radians. atan2 of the cross/dot pair rather than acos of
 * the dot: acos loses catastrophic precision for nearly-parallel vectors, which
 * is exactly the regime self-collision cares about.
 */
export function angleBetween(a: Vector3, b: Vector3): number {
  _a.copy(a).cross(b);
  return Math.atan2(_a.length(), a.dot(b));
}

/** Great-circle surface distance in kilometres. */
export function distanceKm(a: Vector3, b: Vector3): number {
  return angleBetween(a, b) * EARTH_RADIUS_KM;
}

/** Unit tangent at `p` pointing along the great circle toward `q`. */
export function tangentToward(p: Vector3, q: Vector3, out = new Vector3()): Vector3 {
  out.copy(q).addScaledVector(p, -p.dot(q));
  const len = out.length();
  if (len < 1e-9) {
    // p and q are coincident or antipodal: any tangent is as good as any other.
    return out.set(0, 1, 0).addScaledVector(p, -p.y).normalize();
  }
  return out.divideScalar(len);
}

/**
 * Signed angle from the current heading to the direction of `q`, in radians.
 * Positive means "turn right". This is the single value the steering controller
 * needs, whether it came from a keyboard, a mouse ray, or a chasing ship.
 */
export function signedTurnToward(p: Vector3, h: Vector3, q: Vector3): number {
  tangentToward(p, q, _b);
  _c.copy(p).cross(h); // right-hand normal in the tangent plane
  return Math.atan2(_c.dot(_b), h.dot(_b));
}

/** Compass bearing in degrees (0 = north, 90 = east) of `q` as seen from `p`. */
export function bearingDeg(p: Vector3, q: Vector3): number {
  tangentToward(p, q, _b);
  // North at p is the projection of the pole onto p's tangent plane.
  _a.set(0, 1, 0).addScaledVector(p, -p.y);
  if (_a.lengthSq() < 1e-12) return 0; // standing on a pole
  _a.normalize();
  _c.copy(p).cross(_a); // east
  const deg = Math.atan2(_c.dot(_b), _a.dot(_b)) * RAD;
  return (deg + 360) % 360;
}

/** Spherical linear interpolation between two points on the sphere. */
export function slerpPoint(a: Vector3, b: Vector3, t: number, out = new Vector3()): Vector3 {
  const omega = angleBetween(a, b);
  if (omega < 1e-6) return out.copy(b);
  const so = Math.sin(omega);
  return out
    .copy(a)
    .multiplyScalar(Math.sin((1 - t) * omega) / so)
    .addScaledVector(b, Math.sin(t * omega) / so)
    .normalize();
}

/**
 * Shortest angular distance from point `x` to the great-circle *segment* a→b.
 *
 * Node-only collision checks let a fast head tunnel between two trail samples;
 * this closes that hole by testing the segment properly. If the foot of the
 * perpendicular falls outside the arc we fall back to the nearer endpoint.
 */
export function angleToArc(x: Vector3, a: Vector3, b: Vector3): number {
  _a.copy(a).cross(b);
  const nLen = _a.length();
  if (nLen < 1e-9) return angleBetween(x, a); // degenerate arc

  _a.divideScalar(nLen); // unit normal of the arc's plane
  // Project x into the plane and normalise: the closest point on the full circle.
  _b.copy(x).addScaledVector(_a, -x.dot(_a));
  if (_b.lengthSq() < 1e-12) return Math.PI / 2; // x sits on the arc's pole

  _b.normalize();

  // Inside the arc iff the projection lies between a and b along the circle.
  const ab = Math.atan2(nLen, a.dot(b));
  const ap = angleBetween(a, _b);
  const pb = angleBetween(_b, b);
  if (ap + pb <= ab + 1e-6) return angleBetween(x, _b);

  return Math.min(angleBetween(x, a), angleBetween(x, b));
}

/** Build an arbitrary unit tangent at `p` (used for spawn headings). */
export function anyTangent(p: Vector3, out = new Vector3()): Vector3 {
  // Cross with whichever axis is least parallel to p to stay well-conditioned.
  const ax = Math.abs(p.x), ay = Math.abs(p.y), az = Math.abs(p.z);
  if (ax <= ay && ax <= az) out.set(1, 0, 0);
  else if (ay <= az) out.set(0, 1, 0);
  else out.set(0, 0, 1);
  return out.cross(p).normalize();
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Frame-rate independent exponential smoothing. `tau` is the time constant. */
export function damp(current: number, target: number, tau: number, dt: number): number {
  return lerp(target, current, Math.exp(-dt / Math.max(tau, 1e-6)));
}

export function shortestAngleDelta(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export { DEG, RAD };
