import {
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  Fog,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Points,
  Quaternion,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
  SRGBColorSpace,
  ACESFilmicToneMapping,
  type Group,
} from "three";
import { AircraftFactory, type AircraftVisual } from "./aircraft";
import { targetAimPoint } from "./flight-assist";
import { projectGunSight } from "./gun-sight";
import { AIM_COLORS, aimIndicator, aimRadius } from "./aim-indicator";
import { AircraftBatchFactory } from "./aircraft-batch";
import { AircraftTracers } from "./aircraft-tracers";
import { ShipFactory } from "./ships";
import { MAX_NAVAL_SHOTS_PER_STEP } from "./naval";
import { OrdnanceView } from "./ordnance-view";
import { shipWreckPose, isShipObstacle } from "./ship-wreck";
import { currentBombGuide } from "./bomb-guide";
import { BOMB_BLAST } from "./bomb-blast";
import { seaVertex, seaFragment, skyVertex, skyFragment } from "./atmosphere";
import { RenderQueue } from "./render-queue";
import { FIXED_DT, MAX_BULLETS, PLAYER_RELOAD_TICKS } from "./mission";
import { createOceanGeometry, oceanAnchor, OCEAN_GLSL } from "./ocean";
import {
  FLIGHT_FOV,
  FLIGHT_FAR,
  getFlightCameraPose,
  projectFlightTarget,
} from "./flight-view";
import { Scene } from "three";
import type { Aircraft, GameEvent, GameState } from "./types";

const EFFECT_CAPACITY = 240;
const NAVAL_FLASH_CAPACITY = MAX_NAVAL_SHOTS_PER_STEP * 7;
const POINT_CAPACITY = EFFECT_CAPACITY + NAVAL_FLASH_CAPACITY + MAX_BULLETS;
const TRACER_CAPACITY = MAX_BULLETS;

interface Particle {
  p: Vector3;
  v: Vector3;
  born: number;
  life: number;
  color: Color;
  size: number;
  gravity?: number;
}
export class KaisenScene {
  readonly renderer: WebGLRenderer;
  private renderQueue: RenderQueue;
  private prepared = false;
  readonly camera = new PerspectiveCamera(FLIGHT_FOV, 1, 0.5, 22000);
  private scene = new Scene();
  private aircraft = new AircraftFactory();
  private aircraftBatches = new AircraftBatchFactory();
  private aircraftTracers = new AircraftTracers();
  private teamBandGeometry = new CylinderGeometry(0.34, 0.39, 0.6, 14, 1, true);
  private teamMaterials = {
    friendly: new MeshBasicMaterial({ color: 0x27aaa4 }),
    enemy: new MeshBasicMaterial({ color: 0xe29b55 }),
  };
  private ships = new ShipFactory();
  private ordnanceView = new OrdnanceView();
  private planes = new Map<number, AircraftVisual>();
  private fleet = new Map<number, Group>();
  private seaMaterial = new ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: seaVertex,
    fragmentShader: seaFragment,
  });
  private sea = new Mesh(
    createOceanGeometry(),
    this.seaMaterial,
  );
  private sky = new Mesh(
    new SphereGeometry(21000, 32, 20),
    new ShaderMaterial({
      vertexShader: skyVertex,
      fragmentShader: skyFragment,
      side: BackSide,
      depthWrite: false,
    }),
  );
  private tracersGeometry = new BufferGeometry();
  private tracerPositions = new Float32Array(TRACER_CAPACITY * 6);
  private tracerColors = new Float32Array(TRACER_CAPACITY * 6);
  private tracers: LineSegments;
  private particleGeometry = new BufferGeometry();
  private particlePositions = new Float32Array(POINT_CAPACITY * 3);
  private particleColors = new Float32Array(POINT_CAPACITY * 3);
  private particleSizes = new Float32Array(POINT_CAPACITY);
  private particleOpacity = new Float32Array(POINT_CAPACITY);
  private particles: Particle[] = [];
  private navalFlashes: Particle[] = [];
  private points: Points;
  private lastEvent = 0;
  private lastTime = 0;
  private visualTime = 0;
  private wrecks = new Map<
    number,
    { time: number; position: Vector3; rotation: Quaternion; velocity: Vector3 }
  >();
  private current: GameState | null = null;
  private disposed = false;
  private ctx: CanvasRenderingContext2D;
  private width = 1;
  private height = 1;

  constructor(
    private canvas: HTMLCanvasElement,
    private overlay: HTMLCanvasElement,
  ) {
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
    });
    const gl = this.renderer.getContext();
    if (!("fenceSync" in gl)) throw new Error("WebGL2 is required");
    this.renderQueue = new RenderQueue(gl);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.ctx = overlay.getContext("2d")!;
    this.scene.background = new Color(0xaecbd0);
    this.scene.fog = new Fog(0xaecbd0, 1400, 6000);
    this.scene.add(new HemisphereLight(0xc6e5ec, 0x23424e, 2.3));
    const sun = new DirectionalLight(0xffe9b5, 3.1);
    sun.position.set(-600, 700, -350);
    this.scene.add(sun);
    this.scene.add(this.sea, this.sky, this.ordnanceView.root, this.aircraftTracers.root);
    this.tracersGeometry.setAttribute(
      "position",
      new BufferAttribute(this.tracerPositions, 3),
    );
    this.tracersGeometry.setAttribute(
      "color",
      new BufferAttribute(this.tracerColors, 3),
    );
    this.tracers = new LineSegments(
      this.tracersGeometry,
      new LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.9,
      }),
    );
    this.tracers.frustumCulled = false;
    this.scene.add(this.tracers);
    this.particleGeometry.setAttribute(
      "position",
      new BufferAttribute(this.particlePositions, 3),
    );
    this.particleGeometry.setAttribute(
      "color",
      new BufferAttribute(this.particleColors, 3),
    );
    this.particleGeometry.setAttribute(
      "size",
      new BufferAttribute(this.particleSizes, 1),
    );
    this.particleGeometry.setAttribute(
      "opacity",
      new BufferAttribute(this.particleOpacity, 1),
    );
    this.points = new Points(
      this.particleGeometry,
      new ShaderMaterial({
        transparent: true,
        depthWrite: false,
        vertexColors: true,
        vertexShader:
          "attribute float size;attribute float opacity;varying vec3 vColor;varying float vAlpha;void main(){vColor=color;vAlpha=opacity;vec4 p=modelViewMatrix*vec4(position,1.);gl_PointSize=size<0.?-size:clamp(size*450./max(1.,-p.z),1.,80.);gl_Position=projectionMatrix*p;}",
        fragmentShader:
          "varying vec3 vColor;varying float vAlpha;void main(){float d=length(gl_PointCoord-.5)*2.;if(d>1.)discard;gl_FragColor=vec4(vColor,pow(1.-d,1.7)*.8*vAlpha);}",
      }),
    );
    this.points.frustumCulled = false;
    this.scene.add(this.points);
    this.resize();
  }
  resize() {
    const r = this.canvas.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    this.width = r.width;
    this.height = r.height;
    this.renderer.setSize(r.width, r.height, false);
    this.camera.aspect = r.width / r.height;
    this.camera.updateProjectionMatrix();
    this.overlay.width = Math.round(r.width);
    this.overlay.height = Math.round(r.height);
  }
  async prepare(): Promise<void> {
    if (this.disposed) return;
    // Include initially empty projectile/effect materials before mission time
    // starts, so their first real use is not a shader-compilation checkpoint.
    await this.renderer.compileAsync(this.scene, this.camera);
    if (this.disposed) return;
    // Linked programs alone do not initialize every backend draw pipeline.
    // Exercise the pooled line/point materials once, behind the loading screen,
    // before an authoritative mission exists. No simulation entity is created.
    const sample = new Vector3(0, 0, -80)
      .applyQuaternion(this.camera.quaternion).add(this.camera.position);
    this.tracerPositions.set([sample.x - 1, sample.y, sample.z, sample.x + 1, sample.y, sample.z]);
    this.tracerColors.set([1, .8, .4, 1, .8, .4]);
    this.particlePositions.set([sample.x, sample.y, sample.z]);
    this.particleColors.set([1, .6, .2]);
    this.particleSizes[0] = 8;
    this.particleOpacity[0] = 1;
    for (const geometry of [this.tracersGeometry, this.particleGeometry])
      for (const attribute of Object.values(geometry.attributes)) attribute.needsUpdate = true;
    this.tracersGeometry.setDrawRange(0, 2);
    this.particleGeometry.setDrawRange(0, 1);
    this.aircraftTracers.prime(sample);
    this.renderer.render(this.scene, this.camera);
    this.tracersGeometry.setDrawRange(0, 0);
    this.particleGeometry.setDrawRange(0, 0);
    this.aircraftTracers.update([]);
    this.renderer.render(this.scene, this.camera);
    this.renderQueue.submit(performance.now());
    // A linked program or a returned draw call is not a visible-frame barrier.
    // Keep Start disabled until the first real frame completes on the GPU.
    while (!this.disposed) {
      const status = this.renderQueue.poll(performance.now());
      if (status === "ready") break;
      if (status === "failed") throw new Error("Initial GPU frame failed");
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    if (!this.disposed) this.prepared = true;
  }
  pollRender(now = performance.now()) {
    return this.prepared ? this.renderQueue.poll(now) : "ready";
  }
  resetRenderQueue() {
    this.renderQueue.reset();
  }
  private addPlane(p: Aircraft, player: boolean) {
      const detail = player ? "hero" : "enemy";
      const visual = this.aircraftBatches.optimize(
        this.aircraft.create(detail),
        detail,
      );
      if (!player) {
        const band = new Mesh(
          this.teamBandGeometry,
          this.teamMaterials[p.team],
        );
        band.rotation.x = Math.PI / 2;
        band.position.set(0, 0.04, 2.45);
        band.scale.z = 1.12;
        visual.root.add(band);
      }
      this.planes.set(p.id, visual);
      this.scene.add(visual.root);
    return visual;
  }
  private reset(state: GameState) {
    for (const p of this.planes.values()) this.scene.remove(p.root);
    this.planes.clear();
    for (const s of this.fleet.values()) this.scene.remove(s);
    this.fleet.clear();
    this.ships.dispose();
    this.ships = new ShipFactory();
    for (const p of [state.player, ...state.allies, ...state.enemies]) this.addPlane(p, p === state.player);
    for (const s of state.ships) {
      const visual = this.ships.create(s);
      this.fleet.set(s.id, visual);
      this.scene.add(visual);
    }
    this.particles = [];
    this.navalFlashes = [];
    this.wrecks.clear();
    this.lastEvent = 0;
    this.lastTime = state.elapsed;
    this.visualTime = state.elapsed;
    this.current = state;
  }
  events(events: readonly GameEvent[], time: number) {
    const smokeSalvos = new Set<string>();
    for (const e of events) {
      if (e.id <= this.lastEvent) continue;
      this.lastEvent = e.id;
      if (e.type === "shot") {
        const ship = this.current?.ships.find((s) => s.id === e.owner);
        const born = (e.tick ?? Math.round(time / FIXED_DT)) * FIXED_DT;
        // One flash per emitted barrel. No idle turret flashes or old shots replayed
        // after a slow render frame; this never generates projectiles or damage.
        if (ship && time - born < .16) {
          this.navalFlashes.push({ p: e.position.clone(), v: ship.velocity.clone(), born, life: .16,
            color: new Color(0xffedb0), size: 5, gravity: 0 });
          const salvo = `${e.owner}:${e.mountId}:${e.tick}`;
          if (!smokeSalvos.has(salvo)) {
            smokeSalvos.add(salvo);
            this.particles.push({ p: e.position.clone(), v: ship.velocity.clone().add(new Vector3(0, 3, 0)), born, life: .8,
              color: new Color(0x9ca6a7), size: e.detail === 'heavy-aa' ? 7 : 3.5, gravity: -.2 });
          }
        }
        continue;
      }
      const hitShip = this.current?.ships.find(ship => ship.id === e.target);
      if (hitShip && (e.type === "hit" || e.type === "ordnance-impact" || e.type === "mount-destroyed")) {
        const local = e.localPosition ?? e.position.clone().sub(hitShip.position).applyQuaternion(hitShip.quaternion.clone().invert());
        this.ships.impact(hitShip.id, local, (e.tick ?? Math.round(time / FIXED_DT)) * FIXED_DT, e.type === "ordnance-impact" ? "explosive" : e.type === "mount-destroyed" ? "mount" : "metal");
      }
      if (e.type !== "hit" && e.type !== "kill" && e.type !== "splash" && e.type !== "ordnance-impact" && e.type !== "mount-destroyed")
        continue;
      if (
        e.type === "kill" &&
        e.target !== undefined &&
        !this.wrecks.has(e.target) &&
        this.current
      ) {
        const target = [
          this.current.player,
          ...this.current.allies,
          ...this.current.enemies,
          ...this.current.ships,
        ].find((t) => t.id === e.target);
        if (target && target.kind !== "ship")
          this.wrecks.set(target.id, {
            time,
            position: target.position.clone(),
            rotation: target.quaternion.clone(),
            velocity: new Vector3(0, 0, -1).applyQuaternion(target.quaternion).multiplyScalar(target.speed * 0.5),
          });
      }
      const heavy = e.type === "ordnance-impact" || (e.type === "kill" && e.targetKind === "ship");
      const count = heavy ? 24 : e.type === "kill" ? 18 : e.type === "splash" ? (e.weapon ? 12 : 4) : 3;
      for (let j = 0; j < count; j++) {
        const seed = e.id * 31 + j * 17,
          a = seed * 2.399963,
          radius = heavy ? 32 : e.type === "kill" ? 18 : e.type === "splash" ? 3 : 5;
        this.particles.push({
          p: e.position.clone(),
          v: new Vector3(
            Math.cos(a) * radius,
            e.type === "splash" ? 18 + (seed % 17) : 6 + (seed % 13),
            Math.sin(a) * radius,
          ),
          born: time,
          life: heavy ? 3.2 : e.type === "kill" ? 2.4 : e.type === "splash" ? 1.1 : 0.7,
          color: new Color(
            e.type === "splash"
              ? 0xbbf4f5
              : e.type === "kill" && j % 2 === 0
                ? 0x354047
                : j % 3 === 0
                  ? 0xffd993
                  : e.targetKind === "ship" && e.type === "hit" ? 0xdad3b0 : 0xed641d,
          ),
          size: heavy ? 42 : e.type === "kill" ? 28 : e.type === "splash" ? 13 : 8,
        });
      }
    }
    if (this.particles.length > EFFECT_CAPACITY)
      this.particles.splice(0, this.particles.length - EFFECT_CAPACITY);
    this.navalFlashes = this.navalFlashes.filter(p => time - p.born < p.life);
    if (this.navalFlashes.length > NAVAL_FLASH_CAPACITY)
      this.navalFlashes.splice(0, this.navalFlashes.length - NAVAL_FLASH_CAPACITY);
  }
  render(state: GameState, showHUD: boolean, presentationDt = 0) {
    if (this.disposed) return false;
    // Event IDs and wreck ownership follow the new mission immediately, even
    // when the previous view still has one GPU frame in flight.
    if (this.current !== state) this.reset(state);
    if (this.pollRender() !== "ready") return false;
    const dt = Math.max(0, Math.min(0.1, state.elapsed - this.lastTime));
    this.lastTime = state.elapsed;
    if (state.phase === "ended")
      this.visualTime += Math.max(0, Math.min(0.1, presentationDt));
    else this.visualTime = state.elapsed;
    const liveRoster = new Set([state.player, ...state.allies, ...state.enemies].map(p => p.id));
    for (const [id, visual] of this.planes) if (!liveRoster.has(id)) {
      this.scene.remove(visual.root); this.planes.delete(id); this.wrecks.delete(id);
    }
    for (const p of [state.player, ...state.allies, ...state.enemies]) {
      const v = this.planes.get(p.id) ?? this.addPlane(p, p === state.player);
      v.root.visible = p.health > 0;
      v.root.position.copy(p.position);
      v.root.quaternion.copy(p.quaternion);
      const wreck = this.wrecks.get(p.id);
      if (p.health <= 0 && wreck) {
        const age = this.visualTime - wreck.time;
        v.root.visible = age < 5;
        v.root.position
          .copy(wreck.position)
          .addScaledVector(wreck.velocity, age);
        v.root.position.y -= age * age * 4.9;
        v.root.quaternion.copy(wreck.rotation);
        v.root.rotateZ(age * 0.65);
        v.root.rotateX(age * 0.16);
        if (v.root.position.y < 0) v.root.visible = false;
      }
      v.propeller.rotation.z =
        (v.propeller.rotation.z + dt * (34 + Math.min(8, p.speed * 0.035))) %
        (Math.PI * 2);
      const d = Math.max(-0.3, Math.min(0.3, p.bank * 0.34));
      v.ailerons[0].rotation.x = d;
      v.ailerons[1].rotation.x = -d;
      v.elevator.rotation.x = Math.max(-0.26, Math.min(0.26, -p.pitch * 0.32));
    }
    for (const s of state.ships) {
      const v = this.fleet.get(s.id)!;
      v.visible = s.health > 0;
      const wake = v.getObjectByName("wake");
      if (wake) wake.visible = s.health > 0;
      v.position.copy(s.position);
      v.quaternion.copy(s.quaternion);
      this.ships.update(s, v, this.visualTime);
      if (s.health <= 0 && s.wreck) {
        v.visible = isShipObstacle(s, this.visualTime);
        shipWreckPose(s.wreck, this.visualTime, v.position, v.quaternion);
      }
    }
    getFlightCameraPose(
      state.player,
      state.mode,
      this.camera.position,
      this.camera.quaternion,
    );
    this.camera.updateMatrixWorld();
    this.sky.position.copy(this.camera.position);
    this.sea.position.x = oceanAnchor(state.player.position.x);
    this.sea.position.z = oceanAnchor(state.player.position.z);
    this.seaMaterial.uniforms.uTime.value = state.elapsed;
    this.ordnanceView.update(state.ordnance, state.elapsed);
    this.aircraftTracers.update(state.bullets);
    let n = 0;
    for (const b of state.bullets) {
      if (b.kind !== 'aa') continue;
      if (n >= TRACER_CAPACITY) break;
      const tail = b.position.clone().addScaledVector(b.velocity, -0.025);
      this.tracerPositions.set(
        [tail.x, tail.y, tail.z, b.position.x, b.position.y, b.position.z],
        n * 6,
      );
      const c = b.team === "friendly" ? [1, 0.83, 0.42] : [1, 0.32, 0.11];
      this.tracerColors.set([...c, ...c], n++ * 6);
    }
    this.tracersGeometry.setDrawRange(0, n * 2);
    this.tracersGeometry.attributes.position.needsUpdate = true;
    this.tracersGeometry.attributes.color.needsUpdate = true;
    this.particles = this.particles.filter(
      (p) => this.visualTime - p.born < p.life,
    );
    this.navalFlashes = this.navalFlashes.filter(p => this.visualTime - p.born < p.life);
    const effects = [...this.particles, ...this.navalFlashes];
    for (let i = 0; i < effects.length; i++) {
      const p = effects[i],
        a = this.visualTime - p.born,
        pos = p.p.clone().addScaledVector(p.v, a);
      pos.y -= a * a * (p.gravity ?? 4);
      const fade = 1 - a / p.life;
      this.particlePositions.set([pos.x, pos.y, pos.z], i * 3);
      this.particleColors.set([p.color.r, p.color.g, p.color.b], i * 3);
      this.particleOpacity[i] = fade;
      this.particleSizes[i] = p.size * (1 + a * 0.4);
    }
    let pointCount = effects.length;
    // Small screen-size light cores make the existing AA trajectories legible.
    // Every point is a real live AA round and remains depth-tested by the scene.
    for (const bullet of state.bullets) {
      if (bullet.kind !== "aa") continue;
      this.particlePositions.set(bullet.position.toArray(), pointCount * 3);
      this.particleColors.set([1, .64, .22], pointCount * 3);
      this.particleOpacity[pointCount] = .9;
      this.particleSizes[pointCount] = -2.4;
      pointCount++;
    }
    this.particleGeometry.setDrawRange(0, pointCount);
    for (const a of Object.values(this.particleGeometry.attributes))
      a.needsUpdate = true;
    this.renderer.render(this.scene, this.camera);
    this.drawOverlay(state, showHUD);
    if (this.prepared) this.renderQueue.submit(performance.now());
    return true;
  }
  private drawOverlay(state: GameState, show: boolean) {
    const c = this.ctx,
      w = this.width,
      h = this.height;
    c.shadowBlur = 0;
    c.clearRect(0, 0, w, h);
    if (!show) return;
    const sight = state.mode === "normal" ? this.gunSight(state) : { x: w / 2, y: h / 2 };
    const radius = aimRadius(state.mode, w, h);
    const indicator = aimIndicator(state, [...state.allies, ...state.enemies, ...state.ships], sight, w, h);
    const aimColor = AIM_COLORS[indicator];
    c.strokeStyle = aimColor;
    c.lineWidth = 1;
    c.beginPath();
    c.arc(sight.x, sight.y, radius, 0, Math.PI * 2);
    if (state.mode === "normal") {
      c.moveTo(sight.x - radius - 6, sight.y); c.lineTo(sight.x - radius + 5, sight.y);
      c.moveTo(sight.x + radius - 5, sight.y); c.lineTo(sight.x + radius + 6, sight.y);
      c.moveTo(sight.x, sight.y - radius - 6); c.lineTo(sight.x, sight.y - radius + 5);
      c.moveTo(sight.x, sight.y + radius - 5); c.lineTo(sight.x, sight.y + radius + 6);
      // A dark outline keeps the manual bore sight readable over bright sky/sea.
      c.strokeStyle = "rgba(3,25,39,.65)";
      c.lineWidth = 2;
      c.stroke();
      c.strokeStyle = aimColor;
      c.lineWidth = 1;
    }
    c.stroke();
    if (state.player.reloadTicksRemaining > 0) {
      const progress = 1 - state.player.reloadTicksRemaining / PLAYER_RELOAD_TICKS;
      c.strokeStyle = "rgba(7,30,43,.8)";
      c.lineWidth = 5;
      c.beginPath(); c.arc(sight.x, sight.y, radius + 7, 0, Math.PI * 2); c.stroke();
      c.strokeStyle = "#ffd27a";
      c.lineWidth = 3;
      c.beginPath(); c.arc(sight.x, sight.y, radius + 7, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2); c.stroke();
      c.lineWidth = 1;
    }
    c.fillStyle = aimColor;
    c.fillRect(sight.x - 1, sight.y - 1, 2, 2);
    const bombGuide = currentBombGuide(state);
    if (bombGuide && state.player.bombs > 0) {
      const p = bombGuide.position.clone().project(this.camera);
      if (p.z > -1 && p.z < 1 && Math.abs(p.x) < .94 && Math.abs(p.y) < .82) {
        const x = (p.x * .5 + .5) * w, y = (-p.y * .5 + .5) * h;
        const effective = bombGuide.affected.length > 0;
        c.strokeStyle = effective ? "#88ffad" : "#eef5ee"; c.fillStyle = c.strokeStyle; c.lineWidth = 1.5;
        c.beginPath(); c.moveTo(x - 8, y); c.lineTo(x + 8, y); c.moveTo(x, y - 8); c.lineTo(x, y + 8); c.stroke();
        if (bombGuide.kind === "water" || bombGuide.kind === "blast") {
          c.save(); c.globalAlpha = .65; c.setLineDash([3, 3]); c.lineWidth = 1;
          c.beginPath();
          for (let i = 0; i <= 24; i++) {
            const angle = i / 24 * Math.PI * 2;
            const edge = bombGuide.position.clone().add(new Vector3(Math.cos(angle) * BOMB_BLAST.radius, 0, Math.sin(angle) * BOMB_BLAST.radius)).project(this.camera);
            const ex = (edge.x * .5 + .5) * w, ey = (-edge.y * .5 + .5) * h;
            if (i === 0) c.moveTo(ex, ey); else c.lineTo(ex, ey);
          }
          c.stroke(); c.restore();
        }
        // Keep the physical impact cross fixed, offset only its explanation
        // away from the central propeller, with a small contrast backplate.
        c.save(); c.font = "600 10px system-ui"; c.textAlign = "left";
        const label = `${bombGuide.kind === "direct" ? "命中見込み" : bombGuide.kind === "blast" ? "至近弾圏内" : bombGuide.kind === "dud" ? "不発見込み" : bombGuide.kind === "wreck" ? "残骸に接触" : "爆弾の落下目安"} · ${bombGuide.time.toFixed(1)}秒`, labelWidth = Math.ceil(c.measureText(label).width) + 12;
        const labelX = x + 32 + labelWidth < w - 12 ? x + 32 : x - 32 - labelWidth;
        const labelY = Math.max(76, Math.min(h - 60, y - 36));
        c.strokeStyle = "rgba(183,239,206,.55)"; c.lineWidth = .75;
        c.beginPath(); c.moveTo(x + (labelX > x ? 9 : -9), y);
        c.lineTo(labelX > x ? labelX : labelX + labelWidth, labelY + 19); c.stroke();
        c.fillStyle = "rgba(4,24,34,.78)"; c.fillRect(labelX, labelY, labelWidth, 20);
        c.fillStyle = "#d1ffe3"; c.fillText(label, labelX + 6, labelY + 14); c.restore();
      }
    }
    const targets = [...state.allies, ...state.enemies, ...state.ships];
    c.shadowColor = "rgba(0,20,30,.9)";
    c.shadowBlur = 3;
    c.font = "600 11px system-ui";
    c.textAlign = "center";
    for (const t of targets) {
      if (t.health <= 0) continue;
      const world = targetAimPoint(t);
      const p = world.clone().project(this.camera),
        distance = world.distanceTo(state.player.position),
        limit = t.kind === "ship" ? 6000 : 1500;
      if (distance > limit) continue;
      const behind =
        world
          .clone()
          .sub(this.camera.position)
          .dot(new Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion)) <
        0;
      if (behind || Math.abs(p.x) > 0.94 || Math.abs(p.y) > 0.82) continue;
      const x = (p.x * 0.5 + 0.5) * w,
        y = (-p.y * 0.5 + 0.5) * h,
        friendly = t.team === "friendly";
      c.strokeStyle = friendly ? "#77dacb" : "#ffb28b";
      c.fillStyle = c.strokeStyle;
      c.lineWidth = 1.25;
      c.beginPath();
      if (friendly) c.arc(x, y, 4, 0, Math.PI * 2);
      else if (t.kind === "ship") c.rect(x - 8, y - 4, 16, 8);
      else {
        c.moveTo(x, y - 6);
        c.lineTo(x + 5, y);
        c.lineTo(x, y + 6);
        c.lineTo(x - 5, y);
        c.closePath();
      }
      c.stroke();
      if (!friendly) {
        c.fillStyle = "rgba(7,24,32,.8)";
        c.fillRect(x - 19, y + 12, 38, 3);
        c.fillStyle = "#ffc69b";
        c.fillRect(x - 19, y + 12, (38 * t.health) / t.maxHealth, 3);
        c.fillStyle = "#f4e3c8";
        c.fillText(
          `${t.kind === "ship" ? "艦 " : ""}${Math.round(distance)}m`,
          x,
          y + 28,
        );
      }
    }
    c.shadowBlur = 0;
    this.radar(state, c, w, h);
  }
  private radar(
    state: GameState,
    c: CanvasRenderingContext2D,
    w: number,
    h: number,
  ) {
    const r = w < 360 ? 42 : 49,
      x = w - r - 18,
      y = Math.min(h * 0.33, 180);
    c.save();
    c.translate(x, y);
    c.fillStyle = "rgba(4,24,34,.66)";
    c.strokeStyle = "rgba(150,212,211,.36)";
    c.lineWidth = 1;
    c.beginPath();
    c.arc(0, 0, r, 0, Math.PI * 2);
    c.fill();
    c.stroke();
    c.beginPath();
    c.arc(0, 0, r / 2, 0, Math.PI * 2);
    c.moveTo(-r, 0);
    c.lineTo(r, 0);
    c.moveTo(0, -r);
    c.lineTo(0, r);
    c.stroke();
    const cy = Math.cos(state.player.yaw),
      sy = Math.sin(state.player.yaw),
      range = 2400;
    for (const t of [...state.allies, ...state.enemies, ...state.ships]) {
      if (t.health <= 0) continue;
      const dx = t.position.x - state.player.position.x,
        dz = t.position.z - state.player.position.z;
      let px = ((dx * cy - dz * sy) / range) * r,
        py = ((dx * sy + dz * cy) / range) * r;
      const d = Math.hypot(px, py);
      if (d > r - 4) {
        px *= (r - 4) / d;
        py *= (r - 4) / d;
      }
      c.fillStyle = t.team === "friendly" ? "#70d8c7" : "#ffb78c";
      c.strokeStyle = c.fillStyle;
      c.beginPath();
      if (t.kind === "ship") c.rect(px - 3, py - 1.5, 6, 3);
      else if (t.team === "friendly") c.arc(px, py, 2.2, 0, 7);
      else {
        c.moveTo(px, py - 3);
        c.lineTo(px + 3, py);
        c.lineTo(px, py + 3);
        c.lineTo(px - 3, py);
        c.closePath();
      }
      if (d > r - 4) c.stroke();
      else c.fill();
    }
    c.fillStyle = "#fff4ce";
    c.beginPath();
    c.moveTo(0, -5);
    c.lineTo(3, 4);
    c.lineTo(0, 2);
    c.lineTo(-3, 4);
    c.closePath();
    c.fill();
    c.fillStyle = "#b8cfce";
    c.font = "9px system-ui";
    c.textAlign = "center";
    c.fillText("2.4km", 0, r + 13);
    c.restore();
  }
  gunSight(state: GameState) {
    return projectGunSight(state.player, [...state.enemies, ...state.ships], this.width, this.height);
  }
  diagnostics() {
    return {
      queue: this.renderQueue.diagnostics(performance.now()),
      calls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      geometries: this.renderer.info.memory.geometries,
      textures: this.renderer.info.memory.textures,
      particles: this.particles.length,
      navalFlashes: this.navalFlashes.length,
      planes: this.planes.size,
      ships: this.fleet.size,
      width: this.width,
      height: this.height,
      pixelRatio: this.renderer.getPixelRatio(),
      aircraftTracers: this.aircraftTracers.diagnostics(),
    };
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.renderQueue.dispose();
    for (const plane of this.planes.values()) this.scene.remove(plane.root);
    this.planes.clear();
    this.aircraftBatches.dispose();
    this.aircraftTracers.dispose();
    this.aircraft.dispose();
    this.teamBandGeometry.dispose();
    this.teamMaterials.friendly.dispose();
    this.teamMaterials.enemy.dispose();
    this.ships.dispose();
    this.ordnanceView.dispose();
    this.sea.geometry.dispose();
    this.seaMaterial.dispose();
    this.sky.geometry.dispose();
    (this.sky.material as ShaderMaterial).dispose();
    this.tracersGeometry.dispose();
    (this.tracers.material as LineBasicMaterial).dispose();
    this.particleGeometry.dispose();
    (this.points.material as ShaderMaterial).dispose();
    this.renderer.dispose();
  }
}
