import { BufferGeometry, Float32BufferAttribute } from 'three';

/** World metres and fixed simulation seconds. Rendering never owns this clock. */
export const OCEAN_WAVES = Object.freeze([
  Object.freeze({ amplitude: 0.9, x: 0.0023, z: 0.0013, speed: -0.7 }),
  Object.freeze({ amplitude: 0.42, x: -0.0039, z: 0.0031, speed: 0.46 }),
]);
export const OCEAN_MAX_HEIGHT = OCEAN_WAVES.reduce((sum, w) => sum + w.amplitude, 0);
export const OCEAN_MAX_SLOPE = OCEAN_WAVES.reduce((sum, w) => sum + w.amplitude * Math.hypot(w.x, w.z), 0);
export const OCEAN_MAX_CURVATURE = OCEAN_WAVES.reduce((sum, w) => sum + w.amplitude * (w.x * w.x + w.z * w.z), 0);

export function oceanHeight(x: number, z: number, time: number): number {
  let height = 0;
  for (const w of OCEAN_WAVES)
    height += w.amplitude * Math.sin(x * w.x + z * w.z + time * w.speed);
  return height;
}

const glslNumber = (n: number) => Number.isInteger(n) ? `${n}.0` : String(n);
const phase = (w: typeof OCEAN_WAVES[number]) =>
  `p.x*${glslNumber(w.x)}+p.y*${glslNumber(w.z)}+time*${glslNumber(w.speed)}`;
/** Generated from the CPU coefficients, not a separately maintained approximation. */
export const OCEAN_GLSL = `
float oceanHeight(vec2 p,float time){
 return ${OCEAN_WAVES.map(w => `${glslNumber(w.amplitude)}*sin(${phase(w)})`).join('+')};
}
vec2 oceanGradient(vec2 p,float time){
 return ${OCEAN_WAVES.map(w => `vec2(${glslNumber(w.amplitude * w.x)},${glslNumber(w.amplitude * w.z)})*cos(${phase(w)})`).join('+')};
}`;

export const OCEAN_GRID_STEP = 8;
export const OCEAN_NEAR_RADIUS = 256;
const FAR_RADIUS = 25000;

/** Snap to the same world lattice: following the player cannot change local waves. */
export function oceanAnchor(coordinate: number): number {
  return Math.round(coordinate / OCEAN_GRID_STEP) * OCEAN_GRID_STEP;
}

/**
 * One watertight mesh, dense only near the aircraft. 8 m cells within 256 m,
 * progressively larger cells at distance. Fewer triangles than the old 128²
 * grid, whose 390 m cells could disagree with the physical water by decimetres.
 * The near-cell analytic interpolation error is bounded by H * step² (<1.1 mm).
 */
export function createOceanGeometry(): BufferGeometry {
  const positive = [0];
  for (let x = OCEAN_GRID_STEP; x <= OCEAN_NEAR_RADIUS; x += OCEAN_GRID_STEP) positive.push(x);
  let edge = OCEAN_NEAR_RADIUS, step = OCEAN_GRID_STEP;
  while (edge < FAR_RADIUS) {
    step *= 1.35;
    edge = Math.min(FAR_RADIUS, edge + step);
    positive.push(edge);
  }
  const axis = [...positive.slice(1).reverse().map(x => -x), ...positive];
  const vertices: number[] = [], indices: number[] = [];
  for (const z of axis) for (const x of axis) vertices.push(x, 0, z);
  const row = axis.length;
  for (let z = 0; z < row - 1; z++) for (let x = 0; x < row - 1; x++) {
    const a = z * row + x, b = a + 1, c = a + row, d = c + 1;
    indices.push(a, c, b, b, c, d);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}
