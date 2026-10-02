import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  ShaderMaterial,
  type Material,
} from "three";
import type { Ship } from "./types";

/** Original, generic ship silhouettes. Not models of a particular historical vessel. */
export class ShipFactory {
  private geometry: BufferGeometry[] = [];
  private materials: Material[] = [];
  private hull = this.material(0x344951, 0.73, 0.18);
  private deck = this.material(0x877b61, 0.94, 0.01);
  private structure = this.material(0x697c7d, 0.66, 0.15);
  private gun = this.material(0x263b42, 0.48, 0.42);
  private dark = this.material(0x142a31, 0.7, 0.08);
  private stripe = this.material(0xb9b5a1, 0.74, 0.02);
  private wakeMaterial = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    vertexShader:
      "varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}",
    fragmentShader:
      "varying vec2 vUv;void main(){float t=vUv.y;float edge=abs(vUv.x-.5)*2.;float line=exp(-pow((edge-(1.-t)*.8-.08)*16.,2.));float center=exp(-edge*10.);gl_FragColor=vec4(.70,.87,.87,(line*.28+center*.12)*sin(t*3.14159));}",
  });
  private box = this.keep(new BoxGeometry(1, 1, 1));
  private cylinder = this.keep(new CylinderGeometry(1, 1, 1, 8));

  private material(color: number, roughness: number, metalness: number) {
    const value = new MeshStandardMaterial({ color, roughness, metalness });
    this.materials.push(value);
    return value;
  }
  private keep<T extends BufferGeometry>(value: T): T {
    this.geometry.push(value);
    return value;
  }
  private part(
    group: Group,
    geometry: BufferGeometry,
    material: Material,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
  ) {
    const mesh = new Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.scale.set(sx, sy, sz);
    group.add(mesh);
    return mesh;
  }
  create(ship: Ship): Group {
    const root = new Group();
    root.name = `generic-${ship.variant}-${ship.id}`;
    const L = ship.length,
      W = ship.width,
      H = ship.height,
      deckHeight = H * 0.28;
    const wake = new Mesh(
      this.keep(new PlaneGeometry(W * 3.2, L * 1.05)),
      this.wakeMaterial,
    );
    wake.rotation.x = -Math.PI / 2;
    wake.position.set(0, 0.18, L * 0.93);
    root.add(wake);
    const sections = [
      [-0.5, 0.035],
      [-0.4, 0.35],
      [-0.22, 0.5],
      [0.29, 0.5],
      [0.45, 0.3],
      [0.5, 0.16],
    ];
    const points: number[] = [],
      indices: number[] = [];
    for (const [z, width] of sections) {
      points.push(
        -W * width,
        deckHeight,
        L * z,
        W * width,
        deckHeight,
        L * z,
        -W * width * 0.7,
        -2.2,
        L * z,
        W * width * 0.7,
        -2.2,
        L * z,
      );
    }
    for (let i = 0; i < sections.length - 1; i++) {
      const a = i * 4,
        b = a + 4;
      indices.push(
        a,
        b,
        a + 1,
        a + 1,
        b,
        b + 1,
        a,
        a + 2,
        b,
        b,
        a + 2,
        b + 2,
        a + 1,
        b + 1,
        a + 3,
        a + 3,
        b + 1,
        b + 3,
        a + 2,
        a + 3,
        b + 2,
        b + 2,
        a + 3,
        b + 3,
      );
    }
    indices.push(0, 1, 2, 2, 1, 3, 20, 22, 21, 21, 22, 23);
    const hull = new BufferGeometry();
    hull.setAttribute("position", new Float32BufferAttribute(points, 3));
    hull.setIndex(indices);
    hull.computeVertexNormals();
    root.add(new Mesh(this.keep(hull), this.hull));
    this.part(
      root,
      this.box,
      this.deck,
      0,
      deckHeight + 0.08,
      0,
      W * 0.78,
      0.16,
      L * 0.68,
    );
    this.part(
      root,
      this.box,
      this.structure,
      0,
      deckHeight + H * 0.1,
      -L * 0.015,
      W * 0.46,
      H * 0.2,
      L * 0.3,
    );
    this.part(
      root,
      this.box,
      this.structure,
      0,
      H * 0.58,
      -L * 0.11,
      W * 0.38,
      H * 0.26,
      L * 0.1,
    );
    this.part(
      root,
      this.box,
      this.dark,
      0,
      H * 0.67,
      -L * 0.132,
      W * 0.39,
      H * 0.043,
      L * 0.065,
    );
    this.part(
      root,
      this.box,
      this.structure,
      0,
      H * 0.74,
      -L * 0.11,
      W * 0.23,
      H * 0.09,
      L * 0.06,
    );
    for (const z of [L * 0.055, L * 0.14]) {
      this.part(
        root,
        this.cylinder,
        this.structure,
        0,
        H * 0.51,
        z,
        W * 0.13,
        H * 0.34,
        W * 0.15,
      );
      this.part(
        root,
        this.cylinder,
        this.dark,
        0,
        H * 0.685,
        z,
        W * 0.14,
        H * 0.045,
        W * 0.16,
      );
    }
    this.part(
      root,
      this.cylinder,
      this.gun,
      0,
      H * 0.79,
      -L * 0.06,
      0.42,
      H * 0.43,
      0.42,
    );
    this.part(
      root,
      this.box,
      this.gun,
      0,
      H * 0.94,
      -L * 0.06,
      W * 0.58,
      0.4,
      0.4,
    );
    this.part(
      root,
      this.box,
      this.stripe,
      0,
      H * 0.99,
      -L * 0.06,
      W * 0.15,
      0.6,
      1.0,
    );
    for (const [index, z] of [-0.31, -0.2, 0.3].entries()) {
      const turret = new Group();
      turret.position.set(0, deckHeight + 1.1, L * z);
      root.add(turret);
      this.part(
        turret,
        this.cylinder,
        this.gun,
        0,
        0.25,
        0,
        W * 0.155,
        0.65,
        W * 0.155,
      );
      this.part(
        turret,
        this.box,
        this.structure,
        0,
        1.9,
        0,
        W * 0.34,
        3.5,
        L * 0.07,
      );
      for (const x of [-0.07, 0.07]) {
        const barrel = this.part(
          turret,
          this.cylinder,
          this.gun,
          W * x,
          2.7,
          index < 2 ? -L * 0.07 : L * 0.07,
          0.32,
          L * 0.095,
          0.32,
        );
        barrel.rotation.x = Math.PI / 2;
      }
    }
    for (const side of [-1, 1])
      for (const z of [-0.14, 0.16]) {
        const aa = new Group();
        aa.position.set(W * 0.36 * side, deckHeight + 1, L * z);
        root.add(aa);
        this.part(aa, this.cylinder, this.gun, 0, 0.5, 0, 1.2, 1, 1.2);
        const barrel = this.part(
          aa,
          this.cylinder,
          this.dark,
          0,
          2,
          -0.9,
          0.15,
          4,
          0.15,
        );
        barrel.rotation.x = -0.7;
        this.part(
          root,
          this.box,
          this.stripe,
          W * 0.42 * side,
          deckHeight + 0.8,
          L * z,
          0.2,
          1.1,
          L * 0.07,
        );
      }
    return root;
  }
  dispose() {
    for (const x of this.geometry) x.dispose();
    for (const x of this.materials) x.dispose();
    this.wakeMaterial.dispose();
    this.geometry = [];
    this.materials = [];
  }
}
