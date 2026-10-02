import {
  BufferGeometry,
  Material,
  Mesh,
  Object3D,
  StaticDrawUsage,
  type Group,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { AircraftDetail, AircraftVisual } from './aircraft';

interface Candidate {
  mesh: Mesh<BufferGeometry, Material>;
  parent: Object3D;
  bucket: string;
  signature: string;
}

interface Batch {
  geometry: BufferGeometry;
  sources: number[];
}

interface BatchPlan {
  signature: string;
  batches: Batch[];
}

/**
 * Renderer-only companion to one AircraftFactory. Call once on each fresh
 * factory clone, before adding team paint or other per-aircraft attachments.
 *
 * Cached geometries are immutable and shared by detail across mission resets.
 * The original factory still owns all source geometries, materials and textures.
 * Remove ALL optimized roots before disposing this cache, then dispose the
 * original factory. Never dispose batched geometry in a per-plane traversal.
 *
 * Only compatible opaque, ordinary leaf meshes under the same parent merge.
 * Keeping the parent preserves its transform, visibility and Group.renderOrder.
 * Animated subtrees, multi-material groups and unsupported geometry remain
 * unchanged. No vertices/triangles are simplified, welded or recomputed.
 */
export class AircraftBatchFactory {
  private readonly plans = new Map<AircraftDetail, BatchPlan>();
  private readonly optimized = new WeakSet<Group>();
  private disposed = false;

  optimize(visual: AircraftVisual, detail: AircraftDetail): AircraftVisual {
    if (this.disposed) throw new Error('AircraftBatchFactory has been disposed.');
    if (this.optimized.has(visual.root)) return visual;

    visual.root.updateWorldMatrix(true, true);
    const candidates = collectCandidates(visual);
    const signature = candidates.map(candidate => candidate.signature).join('\n');
    let plan = this.plans.get(detail);
    if (plan && plan.signature !== signature) {
      // This cache belongs to one immutable factory. A changed/different source
      // must stay intact rather than receiving stale geometry or growing caches.
      return visual;
    }
    if (!plan) {
      plan = compilePlan(candidates, signature);
      this.plans.set(detail, plan);
    }

    for (const batch of plan.batches) {
      const first = candidates[batch.sources[0]];
      const source = first.mesh;
      const merged = new Mesh(batch.geometry, source.material);
      merged.name = 'aircraft static batch';
      merged.castShadow = source.castShadow;
      merged.receiveShadow = source.receiveShadow;
      merged.frustumCulled = source.frustumCulled;
      merged.renderOrder = source.renderOrder;
      merged.layers.mask = source.layers.mask;
      for (const index of batch.sources) candidates[index].mesh.removeFromParent();
      first.parent.add(merged);
    }
    this.optimized.add(visual.root);
    return visual;
  }

  dispose(): void {
    if (this.disposed) return;
    for (const plan of this.plans.values()) {
      for (const batch of plan.batches) batch.geometry.dispose();
    }
    this.plans.clear();
    this.disposed = true;
  }
}

function collectCandidates(visual: AircraftVisual): Candidate[] {
  const animated = new Set<Object3D>([
    visual.propeller, ...visual.ailerons, visual.elevator,
  ]);
  const candidates: Candidate[] = [];
  function visit(object: Object3D, path: string): void {
    if (animated.has(object)) return;
    if (object.constructor === Mesh && isEligible(object as Mesh)) {
      const mesh = object as Mesh<BufferGeometry, Material>;
      const geometry = mesh.geometry;
      const attributes = Object.keys(geometry.attributes).sort().map(name => {
        const attribute = geometry.getAttribute(name);
        return [name, attribute.array.constructor.name, attribute.itemSize,
          attribute.normalized, 'gpuType' in attribute ? attribute.gpuType : 'interleaved'];
      });
      const state = [mesh.renderOrder, mesh.layers.mask, mesh.castShadow,
        mesh.receiveShadow, mesh.frustumCulled];
      const parentPath = path.slice(0, path.lastIndexOf('/'));
      const bucket = JSON.stringify([parentPath, mesh.material.uuid, state, attributes]);
      const versions = Object.keys(geometry.attributes).sort().map(name => {
        const attribute = geometry.getAttribute(name);
        return 'version' in attribute ? attribute.version : attribute.data.version;
      });
      candidates.push({
        mesh, parent: mesh.parent!, bucket,
        signature: JSON.stringify([path, bucket, geometry.uuid, versions,
          geometry.index?.version, mesh.matrix.elements]),
      });
    }
    object.children.forEach((child, index) => visit(child, `${path}/${index}`));
  }
  visual.root.children.forEach((child, index) => visit(child, `/${index}`));
  return candidates;
}

function isEligible(mesh: Mesh): boolean {
  const geometry = mesh.geometry;
  const material = mesh.material;
  if (mesh.children.length || !mesh.visible || Array.isArray(material) ||
      material.transparent || !material.depthWrite ||
      ('transmission' in material && Number(material.transmission) > 0) ||
      'isShaderMaterial' in material || 'isNodeMaterial' in material ||
      material.onBeforeCompile !== Material.prototype.onBeforeCompile ||
      material.onBeforeRender !== Material.prototype.onBeforeRender ||
      mesh.onBeforeRender !== Object3D.prototype.onBeforeRender ||
      mesh.onAfterRender !== Object3D.prototype.onAfterRender ||
      mesh.onBeforeShadow !== Object3D.prototype.onBeforeShadow ||
      mesh.onAfterShadow !== Object3D.prototype.onAfterShadow ||
      mesh.customDepthMaterial || mesh.customDistanceMaterial ||
      mesh.animations.length || mesh.morphTargetInfluences ||
      Object.keys(geometry.morphAttributes).length ||
      'isInstancedBufferGeometry' in geometry ||
      mesh.matrix.determinant() <= 0) return false;

  const position = geometry.getAttribute('position');
  const count = geometry.index?.count ?? position?.count ?? 0;
  // Partial draw ranges and reflected/singular transforms are left as authored.
  if (!position || position.itemSize !== 3 || !count || count % 3 !== 0 ||
      geometry.drawRange.start !== 0 || geometry.drawRange.count < count) return false;
  return Object.values(geometry.attributes).every(attribute =>
    !('isInstancedBufferAttribute' in attribute) &&
    !('isInstancedInterleavedBufferAttribute' in attribute) &&
    ('usage' in attribute ? attribute.usage : attribute.data.usage) === StaticDrawUsage &&
    attribute.count === position.count,
  );
}

function compilePlan(candidates: Candidate[], signature: string): BatchPlan {
  const buckets = new Map<string, number[]>();
  candidates.forEach((candidate, index) => {
    const indices = buckets.get(candidate.bucket) ?? [];
    indices.push(index);
    buckets.set(candidate.bucket, indices);
  });
  const batches: Batch[] = [];
  try {
    for (const sources of buckets.values()) {
      if (sources.length < 2) continue;
      const parts: BufferGeometry[] = [];
      try {
        for (const index of sources) {
          const source = candidates[index].mesh;
          const part = source.geometry.clone();
          parts.push(part);
          // A single material ignores geometry groups in Three's renderer.
          // Normalize indexed/non-indexed input without duplicating vertices.
          part.clearGroups();
          if (!part.index) {
            const count = part.getAttribute('position').count;
            part.setIndex(Array.from({ length: count }, (_, vertex) => vertex));
          }
          part.applyMatrix4(source.matrix);
        }
        const geometry = mergeGeometries(parts, false);
        if (!geometry) continue;
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        batches.push({ geometry, sources });
      } finally {
        for (const part of parts) part.dispose();
      }
    }
    return { signature, batches };
  } catch (error) {
    for (const batch of batches) batch.geometry.dispose();
    throw error;
  }
}
