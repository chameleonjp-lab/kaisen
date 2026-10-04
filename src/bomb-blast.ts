import { Triangle, Vector3 } from 'three';
import { CAPITAL_SHIP, NAVAL_HULL_BOTTOM, NAVAL_HULL_BOTTOM_INSET, NAVAL_HULL_SECTIONS, segmentNavalHullEntry } from './naval';

/** Game tuning: water near misses only. Direct contact keeps full bomb damage. */
export const BOMB_BLAST = Object.freeze({ radius: 20, maximumFraction: .25 });

// The same tapered, sloped hull spans as rendering/collision, including the narrow bow.
const triangles: Triangle[] = [];
for (let i = 0; i < NAVAL_HULL_SECTIONS.length - 1; i++) {
  const vertices: Vector3[] = [];
  for (const [z, halfWidth] of NAVAL_HULL_SECTIONS.slice(i, i + 2)) {
    for (const y of [NAVAL_HULL_BOTTOM, CAPITAL_SHIP.deckHeight]) {
      const w = halfWidth * CAPITAL_SHIP.width - (y === NAVAL_HULL_BOTTOM ? NAVAL_HULL_BOTTOM_INSET : 0);
      vertices.push(new Vector3(-w, y, z * CAPITAL_SHIP.length), new Vector3(w, y, z * CAPITAL_SHIP.length));
    }
  }
  for (const [a,b,c,d] of [[0,1,3,2],[4,6,7,5],[0,4,5,1],[2,3,7,6],[0,2,6,4],[1,5,7,3]]) {
    triangles.push(new Triangle(vertices[a],vertices[b],vertices[c]), new Triangle(vertices[a],vertices[c],vertices[d]));
  }
}

/** Closest physical hull surface in metres, in the ship's scaled local frame. */
export function closestBombHullPoint(point: Vector3, scale: Vector3): Vector3 {
  const normalized = point.clone().divide(scale);
  if (segmentNavalHullEntry(normalized, normalized) !== null) return point.clone();
  let distance = Infinity;
  const nearest = new Vector3(), candidate = new Vector3(), scaled = new Triangle();
  for (const triangle of triangles) {
    scaled.a.copy(triangle.a).multiply(scale); scaled.b.copy(triangle.b).multiply(scale); scaled.c.copy(triangle.c).multiply(scale);
    scaled.closestPointToPoint(point, candidate);
    const squared = point.distanceToSquared(candidate);
    if (squared < distance) { distance = squared; nearest.copy(candidate); }
  }
  return nearest;
}

export function bombBlastDamage(directDamage: number, distance: number): number {
  if (!Number.isFinite(directDamage) || !Number.isFinite(distance) || directDamage <= 0 || distance < 0 || distance >= BOMB_BLAST.radius) return 0;
  return directDamage * BOMB_BLAST.maximumFraction * (1 - distance / BOMB_BLAST.radius);
}
