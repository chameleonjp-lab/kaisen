import {
  BufferGeometry,
  CanvasTexture,
  CatmullRomCurve3,
  CircleGeometry,
  CylinderGeometry,
  DoubleSide,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Object3D,
  Shape,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector3,
  SRGBColorSpace,
  type Material,
  type Texture,
} from 'three';

export type AircraftDetail = 'hero' | 'enemy';

export interface AircraftVisual {
  root: Group;
  propeller: Group;
  ailerons: [Group, Group];
  elevator: Group;
}

type FoilSpec = {
  halfSpan: number;
  rootChord: number;
  tipChord: number;
  leadingRoot: number;
  leadingSweep: number;
  baseY: number;
  dihedral: number;
  thickness: number;
  camber: number;
  camberPosition: number;
  spanSegments: number;
  chordSegments: number;
  tipRoundPower: number;
};

type FoilPoint = { x: number; y: number; z: number; chord: number; leading: number };

const BODY_SECTIONS = [
  { z: -4.53, rx: 0.12, ry: 0.14, cy: 0 },
  { z: -4.34, rx: 0.48, ry: 0.49, cy: 0 },
  { z: -4.06, rx: 0.64, ry: 0.62, cy: 0 },
  { z: -3.70, rx: 0.65, ry: 0.61, cy: 0 },
  { z: -3.30, rx: 0.58, ry: 0.54, cy: 0 },
  { z: -2.70, rx: 0.50, ry: 0.47, cy: 0 },
  { z: -1.90, rx: 0.43, ry: 0.40, cy: 0 },
  { z: -0.90, rx: 0.36, ry: 0.35, cy: 0 },
  { z: 0.20, rx: 0.31, ry: 0.31, cy: 0 },
  { z: 1.40, rx: 0.25, ry: 0.26, cy: 0 },
  { z: 2.55, rx: 0.18, ry: 0.20, cy: 0 },
  { z: 3.55, rx: 0.11, ry: 0.14, cy: 0 },
  { z: 4.28, rx: 0.055, ry: 0.085, cy: 0 },
  { z: 4.53, rx: 0.016, ry: 0.032, cy: 0 },
];

function seeded(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function makePaintTexture(kind: 'wing' | 'fuselage', seed: number): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is required to generate aircraft paint.');

  const rand = seeded(seed);
  const base = ctx.createLinearGradient(0, 0, 0, canvas.height);
  base.addColorStop(0, '#747a69');
  base.addColorStop(0.38, '#7d826f');
  base.addColorStop(0.72, '#707665');
  base.addColorStop(1, '#646c5d');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Fine, restrained pigment and service wear. The deterministic seed keeps the
  // texture independent from the simulation's random-number stream.
  for (let i = 0; i < 17000; i++) {
    const x = rand() * canvas.width;
    const y = rand() * canvas.height;
    const r = 0.3 + rand() * (kind === 'wing' ? 1.15 : 0.85);
    const shade = rand() > 0.5 ? '255,255,235' : '22,28,22';
    ctx.fillStyle = 'rgba(' + shade + ',' + (0.018 + rand() * 0.04) + ')';
    ctx.beginPath();
    ctx.ellipse(x, y, r * (1 + rand() * 2.5), r, rand() * 0.35, 0, Math.PI * 2);
    ctx.fill();
  }

  if (kind === 'wing') {
    // Spanwise panel breaks and rows of fine rivets, mapped to the airfoil UVs.
    for (let i = 1; i < 12; i++) {
      const x = i * canvas.width / 12 + (rand() - 0.5) * 4;
      ctx.strokeStyle = 'rgba(32,38,31,0.16)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x, 3);
      ctx.lineTo(x + (rand() - 0.5) * 8, canvas.height - 4);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(217,218,193,0.11)';
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(x + 2, 3);
      ctx.lineTo(x + 2, canvas.height - 4);
      ctx.stroke();
    }
    for (let row = 1; row < 8; row++) {
      const y = row * canvas.height / 8;
      ctx.fillStyle = 'rgba(35,40,32,0.34)';
      for (let x = 12; x < canvas.width - 12; x += 15) {
        ctx.beginPath();
        ctx.arc(x + (row % 2) * 7, y + (rand() - 0.5) * 1.5, 1.05, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // A few soft, irregular paint rubs at the leading edge.
    for (let i = 0; i < 28; i++) {
      const x = rand() * canvas.width;
      const y = rand() * 38;
      ctx.fillStyle = 'rgba(194,190,161,' + (0.035 + rand() * 0.055) + ')';
      ctx.beginPath();
      ctx.ellipse(x, y, 5 + rand() * 19, 1 + rand() * 2, (rand() - 0.5) * 0.25, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    // Fuselage stations and long access-panel seams.
    for (let i = 1; i < 14; i++) {
      const x = i * canvas.width / 14;
      ctx.strokeStyle = 'rgba(31,37,30,0.17)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + (rand() - 0.5) * 5, canvas.height);
      ctx.stroke();
    }
    for (let row = 1; row < 5; row++) {
      const y = row * canvas.height / 5;
      ctx.strokeStyle = 'rgba(31,37,30,0.11)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y + (rand() - 0.5) * 5);
      ctx.stroke();
      ctx.fillStyle = 'rgba(34,39,31,0.32)';
      for (let x = 18; x < canvas.width; x += 17) {
        ctx.beginPath();
        ctx.arc(x, y + 4, 0.9, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    for (let i = 0; i < 40; i++) {
      const x = rand() * canvas.width;
      const y = rand() * canvas.height;
      ctx.strokeStyle = 'rgba(214,207,177,' + (0.08 + rand() * 0.1) + ')';
      ctx.lineWidth = 0.8 + rand() * 1.2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 2 + rand() * 10, y + (rand() - 0.5) * 2);
      ctx.stroke();
    }
  }

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function wingPoint(spec: FoilSpec, signedSpan: number, chordT: number): FoilPoint {
  const u = Math.min(1, Math.abs(signedSpan) / spec.halfSpan);
  const baseChord = spec.rootChord + (spec.tipChord - spec.rootChord) * u;
  const round = Math.sqrt(Math.max(0, 1 - Math.pow(u, spec.tipRoundPower)));
  const chord = baseChord * round;
  const leading = spec.leadingRoot + spec.leadingSweep * u + 0.22 * u * u;
  const thickness = 5 * spec.thickness * chord * (
    0.2969 * Math.sqrt(Math.max(chordT, 0.00001)) -
    0.1260 * chordT -
    0.3516 * chordT * chordT +
    0.2843 * chordT * chordT * chordT -
    0.1015 * chordT * chordT * chordT * chordT
  );
  const m = spec.camber;
  const p = spec.camberPosition;
  const camber = chordT < p
    ? m / (p * p) * (2 * p * chordT - chordT * chordT)
    : m / ((1 - p) * (1 - p)) * ((1 - 2 * p) + 2 * p * chordT - chordT * chordT);
  return {
    x: signedSpan,
    y: spec.baseY + Math.abs(signedSpan) * spec.dihedral + camber * chord + thickness,
    z: leading + chordT * chord,
    chord,
    leading,
  };
}

function wingLowerPoint(spec: FoilSpec, signedSpan: number, chordT: number): FoilPoint {
  const upper = wingPoint(spec, signedSpan, chordT);
  const u = Math.min(1, Math.abs(signedSpan) / spec.halfSpan);
  const round = Math.sqrt(Math.max(0, 1 - Math.pow(u, spec.tipRoundPower)));
  const chord = (spec.rootChord + (spec.tipChord - spec.rootChord) * u) * round;
  const thickness = 5 * spec.thickness * chord * (
    0.2969 * Math.sqrt(Math.max(chordT, 0.00001)) -
    0.1260 * chordT -
    0.3516 * chordT * chordT +
    0.2843 * chordT * chordT * chordT -
    0.1015 * chordT * chordT * chordT * chordT
  );
  const m = spec.camber;
  const p = spec.camberPosition;
  const camber = chordT < p
    ? m / (p * p) * (2 * p * chordT - chordT * chordT)
    : m / ((1 - p) * (1 - p)) * ((1 - 2 * p) + 2 * p * chordT - chordT * chordT);
  return { ...upper, y: spec.baseY + Math.abs(signedSpan) * spec.dihedral + camber * chord - thickness };
}

function buildWingGeometry(spec: FoilSpec): BufferGeometry {
  const spanCount = spec.spanSegments;
  const chordCount = spec.chordSegments;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const row = spanCount + 1;
  const col = chordCount + 1;
  const surfaceSize = row * col;

  for (let surface = 0; surface < 2; surface++) {
    const start = positions.length / 3;
    for (let i = 0; i <= spanCount; i++) {
      const span = -spec.halfSpan + 2 * spec.halfSpan * i / spanCount;
      for (let j = 0; j <= chordCount; j++) {
        const p = j / chordCount;
        const point = surface === 0 ? wingPoint(spec, span, p) : wingLowerPoint(spec, span, p);
        positions.push(point.x, point.y, point.z);
        uvs.push((span + spec.halfSpan) / (2 * spec.halfSpan), p);
      }
    }
    for (let i = 0; i < spanCount; i++) {
      for (let j = 0; j < chordCount; j++) {
        const a = start + i * col + j;
        const b = a + 1;
        const c = a + col;
        const d = c + 1;
        if (surface === 0) indices.push(a, b, c, b, d, c);
        else indices.push(a, c, b, b, c, d);
      }
    }
  }

  // Close the exposed leading and trailing edges with slim strips.
  for (const p of [0, 1]) {
    const edgeStart = positions.length / 3;
    for (let i = 0; i <= spanCount; i++) {
      const span = -spec.halfSpan + 2 * spec.halfSpan * i / spanCount;
      const top = wingPoint(spec, span, p);
      const bottom = wingLowerPoint(spec, span, p);
      positions.push(top.x, top.y, top.z, bottom.x, bottom.y, bottom.z);
      uvs.push((span + spec.halfSpan) / (2 * spec.halfSpan), p, (span + spec.halfSpan) / (2 * spec.halfSpan), p);
    }
    for (let i = 0; i < spanCount; i++) {
      const a = edgeStart + i * 2;
      const b = a + 2;
      indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function buildBodyGeometry(sections: typeof BODY_SECTIONS, radialSegments: number): BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    for (let j = 0; j <= radialSegments; j++) {
      const theta = 2 * Math.PI * j / radialSegments;
      const c = Math.cos(theta);
      const s = Math.sin(theta);
      positions.push(section.rx * c, section.cy + section.ry * s, section.z);
      uvs.push(i / (sections.length - 1), j / radialSegments);
    }
  }
  const row = radialSegments + 1;
  for (let i = 0; i < sections.length - 1; i++) {
    for (let j = 0; j < radialSegments; j++) {
      const a = i * row + j;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function buildCowlGeometry(radialSegments: number): BufferGeometry {
  const sections = [
    { z: -4.42, r: 0.54 },
    { z: -4.34, r: 0.61 },
    { z: -4.13, r: 0.64 },
    { z: -3.88, r: 0.63 },
    { z: -3.57, r: 0.59 },
    { z: -3.28, r: 0.54 },
  ];
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    for (let j = 0; j <= radialSegments; j++) {
      const theta = 2 * Math.PI * j / radialSegments;
      positions.push(section.r * Math.cos(theta), section.r * Math.sin(theta), section.z);
      uvs.push(i / (sections.length - 1), j / radialSegments);
    }
  }
  const row = radialSegments + 1;
  for (let i = 0; i < sections.length - 1; i++) {
    for (let j = 0; j < radialSegments; j++) {
      const a = i * row + j;
      indices.push(a, a + 1, a + row, a + 1, a + row + 1, a + row);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function buildFinGeometry(lowDetail: boolean): BufferGeometry {
  const heightCount = lowDetail ? 16 : 28;
  const chordCount = lowDetail ? 16 : 28;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const perSide = (heightCount + 1) * (chordCount + 1);
  for (let side = 0; side < 2; side++) {
    const start = positions.length / 3;
    for (let i = 0; i <= heightCount; i++) {
      const v = i / heightCount;
      const baseChord = 1.52 - 0.67 * v;
      const chord = baseChord * Math.sqrt(Math.max(0, 1 - Math.pow(v, 8)));
      const leading = 3.18 + 0.34 * v;
      for (let j = 0; j <= chordCount; j++) {
        const p = j / chordCount;
        const thick = 5 * 0.105 * chord * (0.2969 * Math.sqrt(Math.max(p, 0.00001)) - 0.126 * p - 0.3516 * p * p + 0.2843 * p * p * p - 0.1015 * p * p * p * p);
        const x = side === 0 ? thick : -thick;
        positions.push(x, 0.08 + 1.82 * v, leading + p * chord);
        uvs.push(p, v);
      }
    }
    for (let i = 0; i < heightCount; i++) {
      for (let j = 0; j < chordCount; j++) {
        const a = start + i * (chordCount + 1) + j;
        const b = a + 1;
        const c = a + chordCount + 1;
        const d = c + 1;
        if (side === 0) indices.push(a, c, b, b, c, d);
        else indices.push(a, b, c, b, d, c);
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function buildControlGeometry(spec: FoilSpec, spanMin: number, spanMax: number, chordStart: number, hingeX: number, hingeY: number, hingeZ: number, segments: number): BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const spanCount = segments;
  const chordCount = 8;
  const grid = (spanCount + 1) * (chordCount + 1);
  for (let surface = 0; surface < 2; surface++) {
    const start = positions.length / 3;
    for (let i = 0; i <= spanCount; i++) {
      const span = spanMin + (spanMax - spanMin) * i / spanCount;
      for (let j = 0; j <= chordCount; j++) {
        const p = chordStart + (1 - chordStart) * j / chordCount;
        const upper = wingPoint(spec, span, p);
        const lower = wingLowerPoint(spec, span, p);
        const point = surface === 0 ? upper : lower;
        const y = point.y + (surface === 0 ? 0.012 : -0.006) - hingeY;
        positions.push(point.x - hingeX, y, point.z - hingeZ);
        uvs.push((span - spanMin) / (spanMax - spanMin), (p - chordStart) / (1 - chordStart));
      }
    }
    for (let i = 0; i < spanCount; i++) {
      for (let j = 0; j < chordCount; j++) {
        const a = start + i * (chordCount + 1) + j;
        const b = a + 1;
        const c = a + chordCount + 1;
        const d = c + 1;
        if (surface === 0) indices.push(a, b, c, b, d, c);
        else indices.push(a, c, b, b, c, d);
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function buildPropBladeGeometry(): BufferGeometry {
  const shape = new Shape();
  shape.moveTo(-0.10, 0.20);
  shape.bezierCurveTo(-0.22, 0.43, -0.23, 0.78, -0.16, 1.06);
  shape.bezierCurveTo(-0.12, 1.25, -0.03, 1.40, 0.08, 1.43);
  shape.bezierCurveTo(0.15, 1.33, 0.12, 1.12, 0.12, 0.95);
  shape.bezierCurveTo(0.11, 0.66, 0.17, 0.39, 0.11, 0.22);
  shape.closePath();
  const geometry = new ExtrudeGeometry(shape, { depth: 0.035, bevelEnabled: true, bevelSegments: 2, steps: 1, bevelSize: 0.012, bevelThickness: 0.012, curveSegments: 8 });
  geometry.translate(0, 0, -0.0175);
  geometry.computeVertexNormals();
  return geometry;
}

function canopyPoint(t: number, across: number): Vector3 {
  const z = -2.72 + 2.86 * t;
  const halfWidth = 0.38 * (0.88 + 0.12 * Math.sin(Math.PI * t));
  const longitudinal = Math.pow(Math.max(0, Math.sin(Math.PI * t)), 0.46);
  const crossArch = Math.pow(Math.max(0, Math.cos(Math.PI * 0.5 * across)), 0.72);
  const h = 0.60 * longitudinal * crossArch;
  return new Vector3(halfWidth * across, 0.43 + h, z);
}

function buildCanopyGeometry(lowDetail: boolean): BufferGeometry {
  const along = lowDetail ? 20 : 34;
  const across = lowDetail ? 12 : 20;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= along; i++) {
    const t = i / along;
    for (let j = 0; j <= across; j++) {
      const s = -1 + 2 * j / across;
      const point = canopyPoint(t, s);
      positions.push(point.x, point.y, point.z);
      uvs.push(t, (s + 1) * 0.5);
    }
  }
  for (let i = 0; i < along; i++) {
    for (let j = 0; j < across; j++) {
      const a = i * (across + 1) + j;
      const b = a + 1;
      const c = a + across + 1;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function makePropBlurTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is required to generate the propeller blur.');
  const glow = ctx.createRadialGradient(64, 64, 16, 64, 64, 63);
  glow.addColorStop(0, 'rgba(224,229,219,0)');
  glow.addColorStop(0.30, 'rgba(204,212,205,0.16)');
  glow.addColorStop(0.74, 'rgba(189,201,198,0.25)');
  glow.addColorStop(1, 'rgba(181,196,198,0.01)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 128, 128);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

function addMesh(parent: Object3D, geometry: BufferGeometry, material: Material, castShadow = false): Mesh {
  const mesh = new Mesh(geometry, material);
  mesh.castShadow = castShadow;
  mesh.receiveShadow = false;
  parent.add(mesh);
  return mesh;
}

function setDiscOrientation(mesh: Mesh, normal: 'up' | 'down' | 'left' | 'right'): void {
  if (normal === 'up') mesh.rotation.x = -Math.PI / 2;
  else if (normal === 'down') mesh.rotation.x = Math.PI / 2;
  else if (normal === 'right') mesh.rotation.y = Math.PI / 2;
  else mesh.rotation.y = -Math.PI / 2;
}

export class AircraftFactory {
  private readonly geometries = new Map<string, BufferGeometry>();
  private readonly materials: Material[] = [];
  private readonly textures: Texture[] = [];
  private readonly prototypes = new Map<AircraftDetail, AircraftVisual>();
  private readonly bodyTexture = makePaintTexture('fuselage', 0x614a91);
  private readonly wingTexture = makePaintTexture('wing', 0x6a2dd3);
  private readonly bodyMaterial = this.keepMaterial(new MeshStandardMaterial({
    map: this.bodyTexture, color: 0xe3e1d4, roughness: 0.70, metalness: 0.055,
  }));
  private readonly wingMaterial = this.keepMaterial(new MeshStandardMaterial({
    map: this.wingTexture, color: 0xe4e2d5, roughness: 0.72, metalness: 0.05,
  }));
  private readonly cowlMaterial = this.keepMaterial(new MeshStandardMaterial({ color: 0x292d2b, roughness: 0.48, metalness: 0.12 }));
  private readonly darkMetal = this.keepMaterial(new MeshStandardMaterial({ color: 0x303631, roughness: 0.5, metalness: 0.42 }));
  private readonly steelMaterial = this.keepMaterial(new MeshStandardMaterial({ color: 0x777d77, roughness: 0.39, metalness: 0.65 }));
  private readonly redMaterial = this.keepMaterial(new MeshStandardMaterial({ color: 0x9e2d26, roughness: 0.77, metalness: 0.025, side: DoubleSide }));
  private readonly gunMaterial = this.keepMaterial(new MeshStandardMaterial({ color: 0x272b29, roughness: 0.42, metalness: 0.52 }));
  private readonly frameMaterial = this.keepMaterial(new MeshStandardMaterial({ color: 0x4d584a, roughness: 0.62, metalness: 0.14 }));
  private readonly hingeMaterial = this.keepMaterial(new MeshStandardMaterial({ color: 0x353d33, roughness: 0.83, metalness: 0.02 }));
  private readonly interiorMaterial = this.keepMaterial(new MeshStandardMaterial({ color: 0x252d2d, roughness: 0.88, metalness: 0.02 }));
  private readonly glassMaterial = this.keepMaterial(new MeshPhysicalMaterial({
    color: 0xb4d0d1, roughness: 0.16, metalness: 0, transparent: true,
    opacity: 0.46, side: DoubleSide, depthWrite: false, envMapIntensity: 0.85,
  }));
  private readonly propBlurTexture = this.keepTexture(makePropBlurTexture());
  private readonly propBlurMaterial = this.keepMaterial(new MeshBasicMaterial({
    map: this.propBlurTexture, color: 0xd8ded5, transparent: true, opacity: 0.52,
    depthWrite: false, side: DoubleSide,
  }));
  private readonly propBladeMaterial = this.keepMaterial(new MeshStandardMaterial({ color: 0x303532, roughness: 0.5, metalness: 0.38, side: DoubleSide }));
  private readonly tailSpec: FoilSpec = {
    halfSpan: 2.18, rootChord: 1.24, tipChord: 0.66, leadingRoot: 3.29,
    leadingSweep: 0.19, baseY: 0.21, dihedral: 0.025, thickness: 0.105,
    camber: 0.018, camberPosition: 0.4, spanSegments: 30, chordSegments: 22, tipRoundPower: 10,
  };
  private readonly wingSpec: FoilSpec = {
    halfSpan: 6, rootChord: 3.42, tipChord: 1.52, leadingRoot: -2.60,
    leadingSweep: 0.46, baseY: -0.12, dihedral: 0.052, thickness: 0.12,
    camber: 0.022, camberPosition: 0.4, spanSegments: 76, chordSegments: 32, tipRoundPower: 10,
  };

  constructor() {
    this.textures.push(this.bodyTexture, this.wingTexture);
  }

  private keepMaterial<T extends Material>(material: T): T {
    this.materials.push(material);
    return material;
  }

  private keepTexture<T extends Texture>(texture: T): T {
    this.textures.push(texture);
    return texture;
  }

  private geometry(key: string, make: () => BufferGeometry): BufferGeometry {
    let geometry = this.geometries.get(key);
    if (!geometry) {
      geometry = make();
      this.geometries.set(key, geometry);
    }
    return geometry;
  }

  create(detail: AircraftDetail = 'hero'): AircraftVisual {
    let prototype = this.prototypes.get(detail);
    if (!prototype) {
      prototype = this.build(detail);
      this.prototypes.set(detail, prototype);
    }
    const root = prototype.root.clone(true);
    return {
      root,
      propeller: root.getObjectByName('three-blade propeller') as Group,
      ailerons: [
        root.getObjectByName('port aileron') as Group,
        root.getObjectByName('starboard aileron') as Group,
      ],
      elevator: root.getObjectByName('elevator') as Group,
    };
  }

  private addTube(parent: Object3D, key: string, points: Vector3[], radius: number, material: Material, radialSegments = 5): Mesh {
    const geometry = this.geometry('tube-' + key, () => new TubeGeometry(
      new CatmullRomCurve3(points),
      Math.max(8, points.length * 8),
      radius,
      radialSegments,
      false,
    ));
    return addMesh(parent, geometry, material);
  }

  private build(detail: AircraftDetail): AircraftVisual {
    const low = detail === 'enemy';
    const group = new Group();
    group.name = low ? 'A6M2 enemy visual' : 'A6M2 player visual';

    const body = this.geometry('fuselage-' + detail, () => buildBodyGeometry(BODY_SECTIONS, low ? 24 : 40));
    addMesh(group, body, this.bodyMaterial);

    const wing = this.geometry('wing-' + detail, () => buildWingGeometry({
      ...this.wingSpec,
      spanSegments: low ? 44 : 76,
      chordSegments: low ? 20 : 32,
    }));
    addMesh(group, wing, this.wingMaterial);

    const tail = this.geometry('tailplane-' + detail, () => buildWingGeometry({
      ...this.tailSpec,
      spanSegments: low ? 18 : 30,
      chordSegments: low ? 14 : 22,
    }));
    addMesh(group, tail, this.bodyMaterial);

    const fin = this.geometry('vertical-fin-' + detail, () => buildFinGeometry(low));
    addMesh(group, fin, this.bodyMaterial);

    const cowl = this.geometry('cowl-' + detail, () => buildCowlGeometry(low ? 24 : 40));
    addMesh(group, cowl, this.cowlMaterial);

    // Open radial-engine face, deep dark backing, and a simple ring of cylinder
    // heads visible around the spinner when the aircraft banks or turns.
    const engineFace = this.geometry('engine-face', () => new CircleGeometry(0.475, 40));
    const face = addMesh(group, engineFace, this.darkMetal);
    face.position.set(0, 0, -4.405);
    const faceRing = this.geometry('engine-ring', () => new TorusGeometry(0.49, 0.047, 8, 44));
    const ring = addMesh(group, faceRing, this.steelMaterial);
    ring.position.set(0, 0, -4.435);
    const cylinder = this.geometry('engine-cylinder', () => new CylinderGeometry(0.092, 0.108, 0.34, low ? 6 : 8, 1));
    const cylCap = this.geometry('engine-cap', () => new CylinderGeometry(0.062, 0.073, 0.09, low ? 6 : 8, 1));
    for (let i = 0; i < (low ? 7 : 9); i++) {
      const angle = 2 * Math.PI * i / (low ? 7 : 9);
      const x = 0.286 * Math.cos(angle);
      const y = 0.286 * Math.sin(angle);
      const c = addMesh(group, cylinder, this.darkMetal);
      c.rotation.x = Math.PI / 2;
      c.position.set(x, y, -4.505);
      const cap = addMesh(group, cylCap, this.steelMaterial);
      cap.rotation.x = Math.PI / 2;
      cap.position.set(x, y, -4.70);
    }

    const spinner = this.geometry('spinner', () => new SphereGeometry(0.265, low ? 14 : 22, low ? 10 : 16));
    const spinnerMesh = addMesh(group, spinner, this.steelMaterial);
    spinnerMesh.scale.set(1, 1, 0.80);
    spinnerMesh.position.set(0, 0, -4.67);

    const prop = new Group();
    prop.name = 'three-blade propeller';
    prop.position.z = -4.72;
    const blur = this.geometry('prop-blur', () => new CircleGeometry(1.34, 56));
    const blurMesh = addMesh(prop, blur, this.propBlurMaterial);
    blurMesh.position.z = -0.015;
    const bladeGeometry = this.geometry('prop-blade', buildPropBladeGeometry);
    for (let i = 0; i < 3; i++) {
      const blade = addMesh(prop, bladeGeometry, this.propBladeMaterial);
      blade.rotation.z = i * 2 * Math.PI / 3;
      blade.position.z = 0.035;
    }
    const hub = addMesh(prop, this.geometry('prop-hub', () => new SphereGeometry(0.14, 16, 10)), this.darkMetal);
    hub.position.z = 0.09;
    group.add(prop);

    // Red recognition roundels on upper and lower wing surfaces.
    const roundel = this.geometry('roundel-wing', () => new CircleGeometry(0.455, low ? 28 : 44));
    for (const side of [-1, 1]) {
      const span = side * 3.72;
      const center = wingPoint(this.wingSpec, span, 0.47);
      const topDisc = addMesh(group, roundel, this.redMaterial);
      setDiscOrientation(topDisc, 'up');
      topDisc.position.set(span, center.y + 0.011, center.z);
      const bottomDisc = addMesh(group, roundel, this.redMaterial);
      setDiscOrientation(bottomDisc, 'down');
      bottomDisc.position.set(span, wingLowerPoint(this.wingSpec, span, 0.47).y - 0.011, center.z);
    }
    const sideRoundel = this.geometry('roundel-fuselage', () => new CircleGeometry(0.325, low ? 28 : 40));
    for (const side of [-1, 1]) {
      const disc = addMesh(group, sideRoundel, this.redMaterial);
      setDiscOrientation(disc, side > 0 ? 'right' : 'left');
      disc.position.set(side * 0.337, 0.015, 0.14);
    }

    // Elevators and ailerons are independently hinged visual surfaces. They
    // share the main paint and remain purely cosmetic.
    const ailerons: [Group, Group] = [new Group(), new Group()];
    for (let index = 0; index < 2; index++) {
      const side = index === 0 ? -1 : 1;
      const spanMin = 3.78;
      const spanMax = 5.72;
      const spanCenter = side * (spanMin + spanMax) * 0.5;
      const hingePoint = wingPoint(this.wingSpec, spanCenter, 0.76);
      const aileron = ailerons[index];
      aileron.name = side < 0 ? 'port aileron' : 'starboard aileron';
      aileron.position.set(spanCenter, hingePoint.y, hingePoint.z);
      const aileronGeo = this.geometry('aileron-' + side + '-' + detail, () => buildControlGeometry(
        this.wingSpec, side * spanMin, side * spanMax, 0.76, spanCenter, hingePoint.y, hingePoint.z, low ? 10 : 18,
      ));
      addMesh(aileron, aileronGeo, this.wingMaterial);
      group.add(aileron);
    }
    const elevator = new Group();
    elevator.name = 'elevator';
    const elevatorHinge = wingPoint(this.tailSpec, 0, 0.76);
    elevator.position.set(0, elevatorHinge.y, elevatorHinge.z);
    const elevatorGeo = this.geometry('elevator-' + detail, () => buildControlGeometry(
      this.tailSpec, -1.60, 1.60, 0.76, 0, elevatorHinge.y, elevatorHinge.z, low ? 10 : 18,
    ));
    addMesh(elevator, elevatorGeo, this.bodyMaterial);
    group.add(elevator);

    // The A6M2 carries its paired synchronized machine guns in the cowling
    // and one cannon in each wing. Local coordinates match scene/simulation
    // muzzle positions: nose is -Z, wings are at x=+/-2.5 m.
    const machineGunGeometry = this.geometry('cowling-mg-barrel-' + detail, () => new CylinderGeometry(0.019, 0.027, 0.34, low ? 6 : 8, 1));
    for (const side of [-1, 1]) {
      const barrel = addMesh(group, machineGunGeometry, this.gunMaterial);
      barrel.rotation.x = -Math.PI / 2;
      barrel.position.set(side * 0.30, 0.52, -4.08);
    }
    const cannonGeometry = this.geometry('wing-cannon-barrel-' + detail, () => new CylinderGeometry(0.031, 0.041, 0.36, low ? 6 : 8, 1));
    for (const side of [-1, 1]) {
      const span = side * 2.5;
      const barrel = addMesh(group, cannonGeometry, this.gunMaterial);
      barrel.rotation.x = -Math.PI / 2;
      barrel.position.set(span, 0, -2.22);
    }

    // Subtle fold seams show the A6M2's folding outer wing panels in their
    // normal flight position without adding separate moving geometry.
    for (const side of [-1, 1]) {
      const span = side * 5.42;
      const foldLine: Vector3[] = [];
      for (let i = 0; i <= 12; i++) {
        const point = wingPoint(this.wingSpec, span, 0.025 + 0.95 * i / 12);
        foldLine.push(new Vector3(point.x, point.y + 0.008, point.z));
      }
      const seam = this.addTube(group, 'wingtip-fold-' + detail + '-' + side, foldLine, 0.008, this.hingeMaterial, 4);
      seam.renderOrder = 1;
    }

    // Flush wing-root blisters and service panels.
    const blisters = this.geometry('gun-blister-' + detail, () => new SphereGeometry(0.115, low ? 8 : 12, low ? 5 : 8));
    for (const side of [-1, 1]) {
      const blister = addMesh(group, blisters, this.bodyMaterial);
      blister.scale.set(1.05, 0.34, 1.8);
      blister.position.set(side * 2.3, 0.19, -2.08);
    }

    // Dark cockpit well and seat under a curved translucent canopy.
    const cockpitWell = addMesh(group, this.geometry('cockpit-well', () => new SphereGeometry(0.32, 18, 10)), this.interiorMaterial);
    cockpitWell.scale.set(1.0, 0.38, 3.1);
    cockpitWell.position.set(0, 0.44, -1.28);
    const seat = addMesh(group, this.geometry('pilot-seat', () => new SphereGeometry(0.15, low ? 8 : 12, low ? 6 : 8)), this.darkMetal);
    seat.scale.set(1.0, 1.4, 0.55);
    seat.position.set(0, 0.57, -0.95);
    const canopy = addMesh(group, this.geometry('canopy-' + detail, () => buildCanopyGeometry(low)), this.glassMaterial);
    canopy.renderOrder = 2;

    const frameSegments = low ? 5 : 7;
    for (let i = 0; i < frameSegments; i++) {
      const t = 0.04 + 0.92 * i / (frameSegments - 1);
      const points: Vector3[] = [];
      for (let j = 0; j <= 8; j++) points.push(canopyPoint(t, -1 + 2 * j / 8));
      this.addTube(group, 'canopy-arch-' + detail + '-' + i, points, i === 0 || i === frameSegments - 1 ? 0.027 : 0.020, this.frameMaterial, 5);
    }
    for (const across of [-0.88, 0, 0.88]) {
      const points: Vector3[] = [];
      for (let i = 0; i <= 16; i++) points.push(canopyPoint(i / 16, across));
      this.addTube(group, 'canopy-rail-' + detail + '-' + across, points, across === 0 ? 0.014 : 0.018, this.frameMaterial, 5);
    }
    const coaming = addMesh(group, this.geometry('cockpit-coaming', () => new TorusGeometry(0.315, 0.025, 6, 28)), this.interiorMaterial);
    coaming.rotation.x = Math.PI / 2;
    coaming.position.set(0, 0.485, -2.22);

    // Antenna mast and taut aerial wire.
    if (!low) {
      const mast = addMesh(group, this.geometry('antenna-mast', () => new CylinderGeometry(0.012, 0.026, 0.58, 7, 1)), this.frameMaterial);
      mast.position.set(0, 1.06, 1.12);
      const wireGeometry = this.geometry('antenna-wire', () => new TubeGeometry(
        new CatmullRomCurve3([new Vector3(0, 1.34, 1.12), new Vector3(0, 1.09, 2.20), new Vector3(0, 0.80, 3.92)]),
        28, 0.005, 4, false,
      ));
      addMesh(group, wireGeometry, this.darkMetal);
    }

    // Smooth belly radiator and modest retractable-wheel fairings.
    const radiator = addMesh(group, this.geometry('radiator', () => new SphereGeometry(0.22, low ? 10 : 16, low ? 7 : 10)), this.cowlMaterial);
    radiator.scale.set(0.83, 0.40, 1.55);
    radiator.position.set(0, -0.39, 0.90);
    const fairing = this.geometry('wheel-fairing', () => new SphereGeometry(0.34, low ? 10 : 16, low ? 7 : 10));
    for (const side of [-1, 1]) {
      const wheel = addMesh(group, fairing, this.bodyMaterial);
      wheel.scale.set(0.58, 0.35, 1.45);
      wheel.position.set(side * 1.24, -0.30, -0.48);
    }

    // Dark panel seams at the aileron/elevator hinges, visible at game scale.
    for (const side of [-1, 1]) {
      const points: Vector3[] = [];
      for (let i = 0; i <= 8; i++) {
        const span = side * (3.78 + (5.72 - 3.78) * i / 8);
        const p = wingPoint(this.wingSpec, span, 0.76);
        points.push(new Vector3(p.x, p.y + 0.013, p.z));
      }
      const hinge = this.addTube(group, 'aileron-hinge-' + side, points, 0.007, this.hingeMaterial, 4);
      hinge.renderOrder = 1;
    }

    return { root: group, propeller: prop, ailerons, elevator };
  }

  dispose(): void {
    for (const geometry of this.geometries.values()) geometry.dispose();
    for (const material of this.materials) material.dispose();
    for (const texture of this.textures) texture.dispose();
    this.geometries.clear();
    this.prototypes.clear();
    this.materials.length = 0;
    this.textures.length = 0;
  }
}

