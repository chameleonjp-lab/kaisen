import {
  BoxGeometry, BufferGeometry, CylinderGeometry, DynamicDrawUsage, Float32BufferAttribute,
  Group, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, PlaneGeometry, Quaternion,
  ShaderMaterial, Vector3, type Material,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CAPITAL_SHIP, NAVAL_HULL_BOTTOM, NAVAL_HULL_BOTTOM_INSET, NAVAL_HULL_SECTIONS, NAVAL_MOUNTS, NAVAL_PLATFORM_PARTS, NAVAL_WEAPONS, navalDirection, navalMuzzleLocal } from './naval';
import type { Ship } from './types';

interface NavalVisual { bodies: InstancedMesh; barrels: InstancedMesh; }
/** Shared static geometry + two instance batches per ship; every visible barrel is real. */
export class ShipFactory {
  private geometries: BufferGeometry[] = [];
  private materials: Material[] = [];
  private instanceMeshes: InstancedMesh[] = [];
  private visuals = new WeakMap<Group, NavalVisual>();
  private template: Group | null = null;
  private disposed = false;
  private hull = this.material(0x34464f, .72, .18);
  private deck = this.material(0x9b8762, .90, .02);
  private structure = this.material(0x7a8889, .68, .16);
  private gun = this.material(0x2f4147, .47, .42);
  private dark = this.material(0x172b34, .72, .05);
  private stripe = this.material(0xc2bfab, .74, .02);
  private box = this.keep(new BoxGeometry(1, 1, 1));
  private cylinder = this.keep(new CylinderGeometry(1, 1, 1, 10));
  private turret = this.keep(new CylinderGeometry(.91, 1, 1, 8));
  private barrel = this.keep(new CylinderGeometry(1, 1, 1, 6));
  private wakeGeometry = this.keep(new PlaneGeometry(CAPITAL_SHIP.width * 3.2, CAPITAL_SHIP.length * 1.05));
  private wakeMaterial = new ShaderMaterial({ transparent: true, depthWrite: false,
    vertexShader: 'varying vec2 vUv;void main(){vUv=uv;vec4 world=modelMatrix*vec4(position,1.);world.y=1.6;gl_Position=projectionMatrix*viewMatrix*world;}',
    fragmentShader: 'varying vec2 vUv;void main(){float t=vUv.y;float edge=abs(vUv.x-.5)*2.;float line=exp(-pow((edge-(1.-t)*.8-.08)*16.,2.));float center=exp(-edge*10.);gl_FragColor=vec4(.70,.87,.87,(line*.28+center*.12)*sin(t*3.14159));}',
  });
  private matrix = new Matrix4();
  private orientation = new Quaternion();
  private position = new Vector3();
  private scale = new Vector3();
  private up = new Vector3(0, 1, 0);
  private material(color: number, roughness: number, metalness: number): MeshStandardMaterial {
    const value = new MeshStandardMaterial({ color, roughness, metalness }); this.materials.push(value); return value;
  }
  private keep<T extends BufferGeometry>(value: T): T { this.geometries.push(value); return value; }
  private part(group: Group, geometry: BufferGeometry, material: Material, position: readonly number[], scale: readonly number[]): Mesh {
    const mesh = new Mesh(geometry, material); mesh.position.fromArray(position); mesh.scale.fromArray(scale); group.add(mesh); return mesh;
  }
  private buildStatic(): Group {
    const root = new Group(), L = CAPITAL_SHIP.length, W = CAPITAL_SHIP.width, deckY = CAPITAL_SHIP.deckHeight;
    // Tapered bow, flared shoulders, broad stern; meters, with no aircraft/camera scaling.
    const sections = NAVAL_HULL_SECTIONS;
    const points: number[] = [], hullIndices: number[] = [], deckIndices: number[] = [];
    for (const [z, halfWidth] of sections) points.push(-W * halfWidth, deckY, L * z, W * halfWidth, deckY, L * z,
      -W * halfWidth + NAVAL_HULL_BOTTOM_INSET, NAVAL_HULL_BOTTOM, L * z, W * halfWidth - NAVAL_HULL_BOTTOM_INSET, NAVAL_HULL_BOTTOM, L * z);
    for (let i = 0; i < sections.length - 1; i++) {
      const a = i * 4, b = a + 4;
      deckIndices.push(a, b, a + 1, a + 1, b, b + 1);
      hullIndices.push(a, a + 2, b, b, a + 2, b + 2, a + 1, b + 1, a + 3, a + 3, b + 1, b + 3,
        a + 2, a + 3, b + 2, b + 2, a + 3, b + 3);
    }
    const last = (sections.length - 1) * 4;
    hullIndices.push(0, 1, 2, 2, 1, 3, last, last + 2, last + 1, last + 1, last + 2, last + 3);
    for (const [indices, material] of [[hullIndices, this.hull], [deckIndices, this.deck]] as const) {
      const geometry = new BufferGeometry(); geometry.setAttribute('position', new Float32BufferAttribute(points, 3));
      geometry.setIndex(indices); geometry.computeVertexNormals(); root.add(new Mesh(this.keep(geometry), material));
    }
    // The solid envelopes are shared with naval.ts. Insets and layered platforms refine the silhouette.
    this.part(root, this.box, this.structure, [0, 13.5, 8.5], [18, 9, 67]);
    this.part(root, this.box, this.structure, [0, 26, -16], [14, 16, 16]);
    this.part(root, this.box, this.structure, [0, 35, -16], [10, 4, 12]);
    this.part(root, this.box, this.structure, [0, 31, -16], [21, 4, 10]);
    for (const y of [21, 25, 29, 33]) {
      this.part(root, this.box, this.structure, [0, y, -16], [16.2, .5, 17]);
      this.part(root, this.box, this.dark, [0, y - 1, -24.06], [12.6, .62, .16]);
    }
    // One large exhaust trunk, one aft director, a compact tripod mast and cross tree.
    this.part(root, this.cylinder, this.structure, [0, 24, 8], [5, 12, 8]);
    this.part(root, this.cylinder, this.dark, [0, 29.7, 8], [5.02, .6, 8.02]);
    this.part(root, this.box, this.structure, [0, 23, 32.5], [8, 10, 7]);
    this.part(root, this.cylinder, this.gun, [0, 34, 23], [.34, 16, .34]);
    this.part(root, this.box, this.gun, [0, 39, 23], [17, .35, .45]);
    this.part(root, this.box, this.stripe, [0, 41.5, 23], [2.4, .8, .6]);
    for (const side of [-1, 1]) {
      const leg = this.part(root, this.cylinder, this.gun, [side * 2.2, 29, 23], [.22, 14, .22]); leg.rotation.z = side * .25;
      // Rails, anchor gear, aft handling rails. Pure geometry, no textures/network/assets.
      for (const z of [-96, -42, 63, 98]) {
        const railWidth = Math.abs(z) > 85 ? 11.5 : 17.9;
        this.part(root, this.box, this.stripe, [side * railWidth, 10.1, z], [.16, .16, 14]);
        for (const dz of [-6.5, 0, 6.5]) this.part(root, this.box, this.structure, [side * railWidth, 9.6, z + dz], [.13, 1.2, .13]);
      }
      this.part(root, this.cylinder, this.dark, [side * 5, 9.5, -105], [1.1, .9, 1.1]);
      this.part(root, this.box, this.dark, [side * 5, 9.15, -115], [.55, .18, 20]);
      const handling = this.part(root, this.box, this.structure, [side * 9, 10.1, 106], [1.3, 1.0, 21]); handling.rotation.y = side * .55;
      this.part(root, this.box, this.dark, [side * 6.5, 9.12, 106], [.25, .15, 28]);
    }
    // The exact same platform/support definitions feed ship damage and gun self-occlusion.
    for (const part of NAVAL_PLATFORM_PARTS) {
      this.part(root, part.shape === 'cylinder' ? this.cylinder : this.box, this.structure, part.position, part.size);
    }
    // Main/secondary barbette circles remain stationary under their rotating turret armor.
    NAVAL_MOUNTS.forEach(definition => {
      if (definition.weapon.endsWith('aa')) return;
      const w = NAVAL_WEAPONS[definition.weapon], [x, y, z] = definition.pivot;
      this.part(root, this.cylinder, this.structure, [x, (9 + y - 1.5) / 2, z], [w.bodySize[0] * .42, Math.max(1, y - 10.5), w.bodySize[0] * .42]);
    });
    // Merge static parts by material once, retaining all topology. Two custom hull/deck meshes lack UVs.
    const buckets = new Map<Material, Mesh[]>();
    root.children.forEach(object => {
      const mesh = object as Mesh<BufferGeometry, Material>;
      if (!mesh.geometry.getAttribute('uv')) return;
      const bucket = buckets.get(mesh.material) ?? []; bucket.push(mesh); buckets.set(mesh.material, bucket);
    });
    for (const [material, meshes] of buckets) {
      const parts = meshes.map(mesh => { mesh.updateMatrix(); const part = mesh.geometry.clone().applyMatrix4(mesh.matrix); part.clearGroups(); return part; });
      const geometry = mergeGeometries(parts, false);
      parts.forEach(part => part.dispose());
      if (geometry) { meshes.forEach(mesh => root.remove(mesh)); root.add(new Mesh(this.keep(geometry), material)); }
    }
    return root;
  }
  create(ship: Ship): Group {
    if (this.disposed) throw new Error('ShipFactory has been disposed');
    this.template ??= this.buildStatic();
    const root = this.template.clone(); root.name = `capitalship-${ship.id}`;
    const wake = new Mesh(this.wakeGeometry, this.wakeMaterial); wake.name = 'wake'; wake.rotation.x = -Math.PI / 2;
    wake.position.set(0, .18, CAPITAL_SHIP.length * .93); root.add(wake);
    const bodies = new InstancedMesh(this.turret, this.structure, NAVAL_MOUNTS.length); bodies.name = 'naval-mounts';
    const count = NAVAL_MOUNTS.reduce((total, definition) => total + NAVAL_WEAPONS[definition.weapon].barrels, 0);
    const barrels = new InstancedMesh(this.barrel, this.gun, count); barrels.name = 'naval-barrels';
    for (const mesh of [bodies, barrels]) {
      mesh.instanceMatrix.setUsage(DynamicDrawUsage); mesh.frustumCulled = false; root.add(mesh); this.instanceMeshes.push(mesh);
    }
    this.visuals.set(root, { bodies, barrels }); this.update(ship, root); return root;
  }
  update(ship: Ship, root: Group): void {
    const visual = this.visuals.get(root); if (!visual || this.disposed) return;
    let barrelIndex = 0;
    NAVAL_MOUNTS.forEach((definition, index) => {
      const gun = ship.guns[index], weapon = NAVAL_WEAPONS[definition.weapon]; if (!gun) return;
      this.position.set(...definition.pivot); this.position.y -= 1;
      this.orientation.setFromAxisAngle(this.up, gun.yaw + Math.PI / 8);
      this.scale.set(weapon.bodySize[0] / 2, weapon.bodySize[1], weapon.bodySize[2] / 2);
      this.matrix.compose(this.position, this.orientation, this.scale); visual.bodies.setMatrixAt(index, this.matrix);
      const direction = navalDirection(gun.yaw, gun.elevation);
      this.orientation.setFromUnitVectors(this.up, direction);
      for (let barrel = 0; barrel < weapon.barrels; barrel++) {
        // Cylinder endpoint equals the exact simulation muzzle, including yaw/elevation and barrel separation.
        this.position.copy(navalMuzzleLocal(definition, gun, barrel)).addScaledVector(direction, -weapon.barrelLength / 2);
        this.scale.set(weapon.barrelRadius, weapon.barrelLength, weapon.barrelRadius);
        this.matrix.compose(this.position, this.orientation, this.scale); visual.barrels.setMatrixAt(barrelIndex++, this.matrix);
      }
    });
    visual.bodies.instanceMatrix.needsUpdate = true; visual.barrels.instanceMatrix.needsUpdate = true;
  }
  dispose(): void {
    if (this.disposed) return;
    this.instanceMeshes.forEach(mesh => mesh.dispose()); this.geometries.forEach(geometry => geometry.dispose());
    this.materials.forEach(material => material.dispose()); this.wakeMaterial.dispose();
    this.instanceMeshes = []; this.geometries = []; this.materials = []; this.template = null; this.disposed = true;
  }
}
