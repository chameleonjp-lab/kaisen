import { Group, type InterleavedBufferAttribute, type Vector3 } from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { AIRCRAFT_BULLET_LIFETIME, MAX_BULLETS } from './mission';
import type { Bullet } from './types';

/** Faitofuraito PR13 aircraft display contract; no ballistic or naval change. */
export const AIR_TRACER_CORE_PX = 1.5;
export const AIR_TRACER_OUTLINE_PX = 2.5;
export const AIR_TRACER_TAIL_SECONDS = .045;

export class AircraftTracers {
  readonly root = new Group();
  readonly geometry = new LineSegmentsGeometry();
  readonly positions: Float32Array;
  readonly colors: Float32Array;
  readonly outlineMaterial = new LineMaterial({ color: 0x281b10, linewidth: AIR_TRACER_OUTLINE_PX,
    transparent: true, opacity: .65, depthTest: true, depthWrite: false, toneMapped: false, fog: false });
  readonly coreMaterial = new LineMaterial({ vertexColors: true, linewidth: AIR_TRACER_CORE_PX,
    transparent: true, opacity: 1, depthTest: true, depthWrite: false, toneMapped: false, fog: false });
  readonly outline: LineSegments2;
  readonly core: LineSegments2;
  private disposed = false;
  constructor(readonly capacity = MAX_BULLETS) {
    this.positions = new Float32Array(capacity * 6);
    this.colors = new Float32Array(capacity * 6);
    this.geometry.setPositions(this.positions).setColors(this.colors);
    this.geometry.instanceCount = 0;
    this.outline = new LineSegments2(this.geometry, this.outlineMaterial);
    this.core = new LineSegments2(this.geometry, this.coreMaterial);
    this.outline.frustumCulled = this.core.frustumCulled = false;
    this.outline.renderOrder = 1; this.core.renderOrder = 2;
    this.root.add(this.outline, this.core);
  }
  private dirty(count: number) {
    this.geometry.instanceCount = count;
    (this.geometry.attributes.instanceStart as InterleavedBufferAttribute).data.needsUpdate = true;
    (this.geometry.attributes.instanceColorStart as InterleavedBufferAttribute).data.needsUpdate = true;
  }
  update(bullets: readonly Bullet[]) {
    let count = 0;
    for (const b of bullets) {
      if (b.kind === 'aa' || b.life <= 0) continue;
      if (count >= this.capacity) break;
      const tail = Math.min(AIR_TRACER_TAIL_SECONDS, Math.max(0, AIRCRAFT_BULLET_LIFETIME - b.life));
      const offset = count++ * 6;
      this.positions.set([b.position.x-b.velocity.x*tail,b.position.y-b.velocity.y*tail,b.position.z-b.velocity.z*tail,
        b.position.x,b.position.y,b.position.z], offset);
      const c = b.team === 'friendly' ? [1,.7,.14] : [1,.24,.07];
      this.colors.set([...c,...c], offset);
    }
    this.dirty(count);
  }
  /** Draw both pooled materials once before a mission starts, behind the loading screen. */
  prime(position: Vector3) {
    this.positions.set([position.x-1,position.y,position.z,position.x+1,position.y,position.z]);
    this.colors.set([1,.7,.14,1,.7,.14]);
    this.dirty(1);
  }
  diagnostics() {
    return { segments: this.geometry.instanceCount, capacity: this.capacity, corePx: this.coreMaterial.linewidth,
      outlinePx: this.outlineMaterial.linewidth, tailSeconds: AIR_TRACER_TAIL_SECONDS,
      depthTest: this.coreMaterial.depthTest && this.outlineMaterial.depthTest,
      resolution: this.coreMaterial.resolution.toArray() };
  }
  dispose() {
    if(this.disposed)return;
    this.disposed=true; this.geometry.dispose(); this.coreMaterial.dispose(); this.outlineMaterial.dispose();
  }
}
