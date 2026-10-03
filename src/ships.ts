import {
  BoxGeometry, BufferGeometry, Color, CylinderGeometry, DynamicDrawUsage, Float32BufferAttribute, IcosahedronGeometry,
  Group, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, Quaternion,
  ShaderMaterial, Vector3, type Material,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CAPITAL_SHIP, NAVAL_HULL_BOTTOM, NAVAL_HULL_BOTTOM_INSET, NAVAL_HULL_SECTIONS, NAVAL_MOUNTS, NAVAL_PLATFORM_PARTS, NAVAL_WEAPONS, navalBarrelOffset } from './naval';
import type { Ship } from './types';
import { FIXED_DT } from './mission';
import { OCEAN_GLSL } from './ocean';

/** Hard bounds are per ship, independent of hit count and rendering cadence. */
export const NAVAL_PRESENTATION_CAPACITY = Object.freeze({ damageSites: 8, smokePerSite: 4, firePerSite: 2 });
export type NavalImpactKind = 'metal' | 'explosive' | 'mount';
interface DamageSite { position: Vector3; born: number; kind: NavalImpactKind; active: boolean; }
interface NavalVisual {
  bodies: InstancedMesh; barrels: InstancedMesh; damage: InstancedMesh;
  wake: Mesh<BufferGeometry, ShaderMaterial>; sites: DamageSite[]; time: number;
}
const DAMAGE_LIFE = { metal: 2.2, mount: 16, explosive: 24 } as const;
const DAMAGE_PRIORITY = { metal: 0, mount: 1, explosive: 2 } as const;
const EFFECTS_PER_SITE = NAVAL_PRESENTATION_CAPACITY.smokePerSite + NAVAL_PRESENTATION_CAPACITY.firePerSite;

/** Hull-edge ribbons plus a narrow V and aerated propeller trail: one water draw per ship. */
function createFoamGeometry(): BufferGeometry {
  const vertices: number[] = [], uv: number[] = [], kinds: number[] = [], indices: number[] = [];
  const strip = (points: readonly (readonly [number, number, number, number])[], kind: number) => {
    const base = vertices.length / 3;
    points.forEach(([x1, x2, z, t]) => {
      vertices.push(x1, 0, z, x2, 0, z); uv.push(0, t, 1, t); kinds.push(kind, kind);
    });
    for (let i = 0; i < points.length - 1; i++) {
      const a = base + i * 2; indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  };
  for (const side of [-1, 1]) {
    strip(NAVAL_HULL_SECTIONS.map(([z, width]) => {
      // The hull tapers 0.24 m inwards at the waterline; start just inside for no dry gap.
      const edge = CAPITAL_SHIP.width * width - .25;
      const widthFoam = z < -.31 ? 4.7 : 2.7;
      const a = side * (edge - .35), b = side * (edge + widthFoam);
      return [Math.min(a, b), Math.max(a, b), z * CAPITAL_SHIP.length, z + .5] as const;
    }), 0);
    strip(Array.from({length: 17}, (_, i) => {
      const t = i / 16, centre = side * (6 + t * 46), halfWidth = 1.4 + t * 3.4;
      return [centre - halfWidth, centre + halfWidth, CAPITAL_SHIP.length / 2 + t * 235, t] as const;
    }), 1);
  }
  strip(Array.from({length: 17}, (_, i) => {
    const t = i / 16, halfWidth = 6 + t * 9;
    return [-halfWidth, halfWidth, CAPITAL_SHIP.length / 2 + t * 210, t] as const;
  }), 2);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  geometry.setAttribute('foamKind', new Float32BufferAttribute(kinds, 1));
  geometry.setIndex(indices); geometry.computeBoundingSphere(); return geometry;
}
const foamVertex = `
uniform float uTime;
attribute float foamKind;
varying vec2 vUv;
varying float vKind;
varying vec3 vWorld;
${OCEAN_GLSL}
void main(){
 vUv=uv;vKind=foamKind;vWorld=(modelMatrix*vec4(position,1.)).xyz;
 vWorld.y=oceanHeight(vWorld.xz,uTime)+.10;
 gl_Position=projectionMatrix*viewMatrix*vec4(vWorld,1.);
}`;
const foamFragment = `
uniform float uTime;
uniform float uIntensity;
varying vec2 vUv;
varying float vKind;
varying vec3 vWorld;
void main(){
 float across=sin(vUv.x*3.14159265);
 float churn=.76+.24*sin(vUv.y*98.-uTime*3.4)*sin(vUv.x*15.+vUv.y*57.+uTime*1.7);
 float fade=vKind<.5 ? .52+.48*(1.-smoothstep(.03,.38,vUv.y)) : pow(1.-vUv.y,1.35);
 float bow=vKind<.5 ? 1.-smoothstep(.02,.24,vUv.y) : 0.;
 float alpha=pow(max(0.,across),.7)*churn*fade*uIntensity*(vKind>1.5 ? .26 : .56+bow*.14);
 alpha*=1.-smoothstep(2500.,7500.,length(cameraPosition-vWorld));
 if(alpha<.008)discard;
 gl_FragColor=vec4(.70,.85,.84,alpha);
 #include <tonemapping_fragment>
 #include <colorspace_fragment>
}`;
const damageVertex = `
varying vec3 vData;
varying vec3 vLocal;
varying vec3 vWorld;
void main(){
 vData=instanceColor;vLocal=position;
 vWorld=(modelMatrix*instanceMatrix*vec4(position,1.)).xyz;
 gl_Position=projectionMatrix*viewMatrix*vec4(vWorld,1.);
}`;
const damageFragment = `
uniform float uTime;
varying vec3 vData;
varying vec3 vLocal;
varying vec3 vWorld;
${OCEAN_GLSL}
void main(){
 if(vData.y<.008 || vWorld.y<oceanHeight(vWorld.xz,uTime))discard;
 float light=.70+.30*clamp(vLocal.y*.5+.5,0.,1.);
 vec3 smoke=vec3(.18,.175,.16)*light+vec3(vData.x*.11);
 vec3 flame=mix(vec3(1.,.16,.018),vec3(1.,.68,.09),clamp(.5-vLocal.y*.5,0.,1.));
 gl_FragColor=vec4(mix(smoke,flame,vData.z),vData.y);
 #include <tonemapping_fragment>
 #include <colorspace_fragment>
}`;

/** Shared static geometry, gun batches and one fixed damage batch; every barrel is real. */
export class ShipFactory {
  private geometries: BufferGeometry[] = [];
  private materials: Material[] = [];
  private instanceMeshes: InstancedMesh[] = [];
  private visuals = new WeakMap<Group, NavalVisual>();
  private byId = new Map<number, { root: Group; visual: NavalVisual }>();
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
  private wakeGeometry = this.keep(createFoamGeometry());
  private damageGeometry = this.keep(new IcosahedronGeometry(1, 1));
  private damageMaterial = new ShaderMaterial({ uniforms: { uTime: { value: 0 } },
    vertexShader: damageVertex, fragmentShader: damageFragment, transparent: true, depthWrite: false });
  private matrix = new Matrix4();
  private orientation = new Quaternion();
  private position = new Vector3();
  private scale = new Vector3();
  private up = new Vector3(0, 1, 0);
  private direction = new Vector3();
  private color = new Color();
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
    // Human-scale guardrails follow the actual tapered deck, making a near pass legible.
    for (const side of [-1, 1]) {
      for (let i = 0; i < sections.length - 1; i++) {
        const [az, aw] = sections[i], [bz, bw] = sections[i + 1];
        const ax = side * Math.max(.1, W * aw - .7), bx = side * Math.max(.1, W * bw - .7);
        const dz = (bz - az) * L, dx = bx - ax, length = Math.hypot(dx, dz);
        const rail = this.part(root, this.box, this.stripe, [(ax + bx) / 2, deckY + 1.05, (az + bz) * L / 2], [.11, .11, length]);
        rail.rotation.y = Math.atan2(dx, dz);
        for (let n = 0; n < Math.ceil(length / 8); n++) {
          const t = n / Math.ceil(length / 8);
          this.part(root, this.box, this.structure, [ax + dx * t, deckY + .5, az * L + dz * t], [.12, 1.0, .12]);
        }
      }
      for (const z of [-12, 4, 22]) {
        // Eight-metre boats and their cradles provide scale beside the large deckhouse.
        this.part(root, this.cylinder, this.stripe, [side * 10.7, 11.3, z], [1.15, 1.2, 4]);
        this.part(root, this.cylinder, this.dark, [side * 10.7, 11.94, z], [.75, .08, 3.2]);
        for (const dz of [-2.3, 2.3]) this.part(root, this.box, this.structure, [side * 10.7, 10.1, z + dz], [2.8, 1.0, .5]);
      }
      for (const z of [-91, -39, 60, 94]) {
        this.part(root, this.box, this.dark, [side * 5, deckY + .16, z], [2.2, .32, 3.1]);
        this.part(root, this.box, this.structure, [side * 5, deckY + .4, z], [1.85, .20, 2.75]);
      }
      // Four 1.7-metre bridge levels, with ladder rungs visible only on a close pass.
      for (let y = 19; y < 34; y += .55) this.part(root, this.box, this.stripe, [side * 7.10, y, -14], [.12, .07, .8]);
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
    const existing = this.byId.get(ship.id); if (existing) return existing.root;
    this.template ??= this.buildStatic();
    const root = this.template.clone(); root.name = `capitalship-${ship.id}`;
    const wakeMaterial = new ShaderMaterial({ uniforms: { uTime: { value: 0 }, uIntensity: { value: 0 } },
      vertexShader: foamVertex, fragmentShader: foamFragment, transparent: true, depthWrite: false });
    this.materials.push(wakeMaterial);
    const wake = new Mesh(this.wakeGeometry, wakeMaterial); wake.name = 'wake'; wake.frustumCulled = false;
    // Its vertices are displaced to the ocean in the shader; it is not a collision surface.
    wake.raycast = () => {}; root.add(wake);
    const bodies = new InstancedMesh(this.turret, this.structure, NAVAL_MOUNTS.length); bodies.name = 'naval-mounts';
    const count = NAVAL_MOUNTS.reduce((total, definition) => total + NAVAL_WEAPONS[definition.weapon].barrels, 0);
    const barrels = new InstancedMesh(this.barrel, this.gun, count); barrels.name = 'naval-barrels';
    const damage = new InstancedMesh(this.damageGeometry, this.damageMaterial, NAVAL_PRESENTATION_CAPACITY.damageSites * EFFECTS_PER_SITE);
    damage.name = 'naval-damage'; damage.raycast = () => {};
    for (const mesh of [bodies, barrels, damage]) {
      mesh.instanceMatrix.setUsage(DynamicDrawUsage); mesh.frustumCulled = false; root.add(mesh); this.instanceMeshes.push(mesh);
      // Allocate instance colours before shader warm-up, including an initially quiet ship.
      for (let i = 0; i < mesh.count; i++) mesh.setColorAt(i, this.color.setRGB(1, 1, 1));
      mesh.instanceColor!.setUsage(DynamicDrawUsage);
    }
    const visual: NavalVisual = { bodies, barrels, damage, wake, time: ship.age,
      sites: Array.from({length: NAVAL_PRESENTATION_CAPACITY.damageSites}, () => ({ position: new Vector3(), born: 0, kind: 'metal', active: false })) };
    this.visuals.set(root, visual); this.byId.set(ship.id, { root, visual }); this.update(ship, root); return root;
  }

  /** Caller deduplicates authoritative events and supplies ship-local coordinates at the hit. */
  impact(shipId: number, localPosition: Vector3, timeSeconds: number, kind: NavalImpactKind): void {
    const visual = this.byId.get(shipId)?.visual;
    if (!visual || this.disposed || !Number.isFinite(timeSeconds) ||
      !Number.isFinite(localPosition.x + localPosition.y + localPosition.z) || timeSeconds + DAMAGE_LIFE[kind] < visual.time) return;
    let chosen: DamageSite | undefined;
    for (const site of visual.sites) {
      if (!site.active || timeSeconds - site.born >= DAMAGE_LIFE[site.kind]) { chosen ??= site; continue; }
      if (site.position.distanceToSquared(localPosition) < 25) {
        // A metal strike cannot replace or indefinitely prolong an existing fire.
        if (DAMAGE_PRIORITY[kind] < DAMAGE_PRIORITY[site.kind] || timeSeconds < site.born) return;
        chosen = site; break;
      }
    }
    if (!chosen) for (const site of visual.sites) {
      if (DAMAGE_PRIORITY[site.kind] > DAMAGE_PRIORITY[kind] || site.born > timeSeconds) continue;
      if (!chosen || DAMAGE_PRIORITY[site.kind] < DAMAGE_PRIORITY[chosen.kind] ||
        (site.kind === chosen.kind && site.born < chosen.born)) chosen = site;
    }
    if (!chosen) return;
    chosen.position.copy(localPosition); chosen.born = timeSeconds; chosen.kind = kind; chosen.active = true;
  }

  /** Time is supplied by the scene: fixed while paused; presentation time may advance wrecks. */
  update(ship: Ship, root: Group, timeSeconds = ship.age): void {
    const visual = this.visuals.get(root); if (!visual || this.disposed) return;
    visual.time = timeSeconds;
    visual.wake.material.uniforms.uTime.value = timeSeconds;
    // A stationary hull cannot produce a powered wake. Motion/turn/rock remain simulation-owned.
    visual.wake.material.uniforms.uIntensity.value = ship.health > 0 ? Math.min(1, Math.hypot(ship.velocity.x, ship.velocity.z) / 6) : 0;
    visual.wake.visible = visual.wake.material.uniforms.uIntensity.value > .015;
    this.damageMaterial.uniforms.uTime.value = timeSeconds;
    let barrelIndex = 0;
    NAVAL_MOUNTS.forEach((definition, index) => {
      const gun = ship.guns[index], weapon = NAVAL_WEAPONS[definition.weapon]; if (!gun) return;
      const disabled = gun.health <= 0;
      const elevation = disabled ? -.18 : gun.elevation;
      const age = timeSeconds - gun.lastShotTick * FIXED_DT;
      const kick = age >= 0 && age < .36 && !disabled ? Math.min(1, age / .04) * Math.pow(1 - age / .36, 2) : 0;
      const recoil = kick * (definition.weapon === 'heavy-aa' ? .42 : definition.weapon === 'light-aa' ? .11 : 1.1);
      this.position.set(...definition.pivot); this.position.y -= 1;
      this.orientation.setFromAxisAngle(this.up, gun.yaw + Math.PI / 8);
      this.scale.set(weapon.bodySize[0] / 2, weapon.bodySize[1], weapon.bodySize[2] / 2);
      this.matrix.compose(this.position, this.orientation, this.scale); visual.bodies.setMatrixAt(index, this.matrix);
      const shade = disabled ? .26 : .60 + .40 * Math.max(0, Math.min(1, gun.health / gun.maxHealth));
      visual.bodies.setColorAt(index, this.color.setRGB(shade, shade, shade));
      const horizontal = Math.cos(elevation), sy = Math.sin(gun.yaw), cy = Math.cos(gun.yaw);
      this.direction.set(-sy * horizontal, Math.sin(elevation), -cy * horizontal);
      this.orientation.setFromUnitVectors(this.up, this.direction);
      for (let barrel = 0; barrel < weapon.barrels; barrel++) {
        const offset = navalBarrelOffset(definition, barrel);
        // At rest and at the shot tick, the cylinder endpoint equals the simulation muzzle.
        // The brief slide backwards after firing is visual recoil, never a new firing origin.
        this.position.set(...definition.pivot); this.position.x += cy * offset; this.position.z -= sy * offset;
        this.position.addScaledVector(this.direction, weapon.barrelLength / 2 - recoil);
        this.scale.set(weapon.barrelRadius, weapon.barrelLength, weapon.barrelRadius);
        this.matrix.compose(this.position, this.orientation, this.scale); visual.barrels.setMatrixAt(barrelIndex, this.matrix);
        visual.barrels.setColorAt(barrelIndex++, this.color.setRGB(shade, shade, shade));
      }
    });
    for (const mesh of [visual.bodies, visual.barrels]) {
      mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor!.needsUpdate = true;
    }
    this.updateDamage(visual, timeSeconds);
  }

  private updateDamage(visual: NavalVisual, time: number): void {
    this.orientation.identity();
    for (let index = 0; index < visual.sites.length; index++) {
      const site = visual.sites[index], age = time - site.born, life = DAMAGE_LIFE[site.kind];
      const alive = site.active && age >= 0 && age < life;
      const metal = site.kind === 'metal', fade = alive ? Math.min(1, (life - age) / (metal ? .65 : 4)) : 0;
      for (let i = 0; i < EFFECTS_PER_SITE; i++) {
        const flame = i >= NAVAL_PRESENTATION_CAPACITY.smokePerSite;
        this.position.copy(site.position); let opacity = 0;
        if (alive && (!flame || !metal)) {
          const phase = i * .713 + index * 1.71;
          if (flame) {
            const flicker = .88 + .12 * Math.sin(time * 11.3 + phase);
            const radius = (site.kind === 'explosive' ? 2.3 : 1.25) * flicker;
            this.position.x += Math.sin(phase) * radius * .4;
            this.position.y += radius * .8;
            this.position.z += Math.cos(phase) * radius * .4;
            this.scale.set(radius * .55, radius * 1.7, radius * .55).multiplyScalar(Math.sqrt(fade));
            opacity = .70 * fade;
          } else {
            const cycle = metal ? 2.2 : 5.5;
            const puffAge = (age + i * cycle / 4) % cycle;
            // Start from the hit and let successive puffs grow into a low, local plume.
            const growth = Math.min(age * 1.8, puffAge);
            const radius = (metal ? .48 + growth * .6 : 1.05 + growth * .85) * Math.sqrt(fade);
            this.position.x += Math.sin(phase + puffAge * .4) * growth * .38;
            this.position.z += growth * .46 + Math.cos(phase) * .4;
            this.position.y += growth * (metal ? 1.1 : 2.0) + radius * .35;
            this.scale.set(radius, radius * .88, radius);
            opacity = (metal ? .26 : .37) * fade * Math.min(1, (cycle - puffAge) / 1.2);
          }
        } else this.scale.set(0, 0, 0);
        this.matrix.compose(this.position, this.orientation, this.scale);
        const instance = index * EFFECTS_PER_SITE + i;
        visual.damage.setMatrixAt(instance, this.matrix);
        visual.damage.setColorAt(instance, this.color.setRGB(metal ? .8 : .15 + i * .035, opacity, flame ? 1 : 0));
      }
    }
    visual.damage.instanceMatrix.needsUpdate = true; visual.damage.instanceColor!.needsUpdate = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.instanceMeshes.forEach(mesh => mesh.dispose()); this.geometries.forEach(geometry => geometry.dispose());
    this.materials.forEach(material => material.dispose()); this.damageMaterial.dispose();
    this.instanceMeshes = []; this.geometries = []; this.materials = []; this.byId.clear();
    this.visuals = new WeakMap(); this.template = null; this.disposed = true;
  }
}
