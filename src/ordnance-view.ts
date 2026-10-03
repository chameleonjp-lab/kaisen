import { BoxGeometry, BufferAttribute, BufferGeometry, CylinderGeometry, DynamicDrawUsage, Group, InstancedMesh, LineBasicMaterial, LineSegments, Matrix4, MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MAX_ORDNANCE } from './mission';
import { oceanHeight } from './ocean';
import type { OrdnanceRound } from './ordnance';

/** Two reusable projectile batches and one finite surface-wake line batch. */
export class OrdnanceView {
  readonly root = new Group();
  private material = new MeshStandardMaterial({ color: 0x667982, roughness: .52, metalness: .55 });
  private bodies: Record<'bomb' | 'torpedo', InstancedMesh>;
  private trailPositions = new Float32Array(MAX_ORDNANCE * 6);
  private trailGeometry = new BufferGeometry();
  private trailMaterial = new LineBasicMaterial({ color: 0xcce9de, transparent: true, opacity: .85 });
  private matrix = new Matrix4(); private rotation = new Quaternion(); private scale = new Vector3(1, 1, 1);
  private up = new Vector3(0, 1, 0);
  private disposed = false;

  constructor() {
    const shape = (length: number, radius: number) => {
      const pieces: BufferGeometry[] = [new CylinderGeometry(radius * .3, radius, length, 8)];
      for (const yaw of [0, Math.PI / 2]) {
        const fin = new BoxGeometry(radius * 4, length * .15, radius * .2);
        fin.translate(0, -length * .4, 0); fin.rotateY(yaw); pieces.push(fin);
      }
      const geometry = mergeGeometries(pieces, false)!; pieces.forEach(item => item.dispose()); return geometry;
    };
    this.bodies = { bomb: new InstancedMesh(shape(1.5, .2), this.material, MAX_ORDNANCE), torpedo: new InstancedMesh(shape(4.3, .22), this.material, MAX_ORDNANCE) };
    for (const [name, body] of Object.entries(this.bodies)) {
      body.name = `live-${name}`; body.count = 0; body.frustumCulled = false;
      body.instanceMatrix.setUsage(DynamicDrawUsage); this.root.add(body);
    }
    this.trailGeometry.setAttribute('position', new BufferAttribute(this.trailPositions, 3));
    const trails = new LineSegments(this.trailGeometry, this.trailMaterial); trails.frustumCulled = false;
    this.trailGeometry.setDrawRange(0, 0); this.root.add(trails);
  }

  update(rounds: readonly OrdnanceRound[], time: number): void {
    if (this.disposed) return;
    const counts = { bomb: 0, torpedo: 0 }; let trails = 0;
    for (const round of rounds.slice(0, MAX_ORDNANCE)) {
      if (round.life <= 0) continue;
      const direction = round.velocity.clone().normalize();
      if (direction.lengthSq() < .1) direction.set(0, -1, 0);
      this.rotation.setFromUnitVectors(this.up, direction);
      this.matrix.compose(round.position, this.rotation, this.scale);
      this.bodies[round.kind].setMatrixAt(counts[round.kind]++, this.matrix);
      if (round.phase === 'water') {
        const head = round.position.clone(), tail = head.clone().addScaledVector(direction, -Math.min(28, round.waterDistance));
        head.y = oceanHeight(head.x, head.z, time) + .10; tail.y = oceanHeight(tail.x, tail.z, time) + .10;
        this.trailPositions.set([...head.toArray(), ...tail.toArray()], trails++ * 6);
      }
    }
    for (const kind of ['bomb', 'torpedo'] as const) { this.bodies[kind].count = counts[kind]; this.bodies[kind].instanceMatrix.needsUpdate = true; }
    this.trailGeometry.setDrawRange(0, trails * 2); this.trailGeometry.attributes.position.needsUpdate = true;
  }

  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    for (const body of Object.values(this.bodies)) { body.dispose(); body.geometry.dispose(); }
    this.material.dispose(); this.trailGeometry.dispose(); this.trailMaterial.dispose(); this.root.clear();
  }
}
