#!/usr/bin/env node
// Builds web/public/models/brain.glb from the Human Reference Atlas "Brain, Male" v1.3 GLB
// (3d-vh-m-allen-brain.glb, CC BY 4.0). See README.md in this folder for source, credit and facts.
//
//   node prepare-brain.mjs <input 3d-vh-m-allen-brain.glb> <output brain.glb> [options]
//   node prepare-brain.mjs --verify-only <brain.glb>
//
// Options (the defaults are the values used for the committed asset):
//   --voxel=0.4           voxel size in millimeters for the outer shell rebuild
//   --blur=1              passes of a 5 tap binomial blur on the signed distance field (0 = off)
//   --smooth=3            Taubin smoothing passes on the rebuilt shell (0 = off)
//   --target-tris=250000  triangle target for meshoptimizer simplify
//   --max-error=0.002     simplify error bound, relative to the mesh extent
//   --debug               print mesh quality stats between steps
//
// No network access; the input file is only read as data. Peak memory is about 2.5 GB.
//
// Pipeline:
//   1. Read all 283 meshes, bake node transforms, convert meters to millimeters.
//   2. Leave out the thin appendages (olfactory bulbs and tracts, optic tracts, optic chiasm).
//   3. Voxelize everything else and flood fill the outside. Only triangles that touch the outside are
//      used for the surface, so every deep structure (thalamus, basal ganglia, hippocampus,
//      ventricles, white matter, ...) disappears except the small patches where it is the true outer
//      surface (floor of the midline fissure, hypothalamus); without them the shell would have holes.
//   4. Rebuild that outer surface as ONE closed, manifold mesh (narrow band signed distance, light
//      blur, marching tetrahedra), so there are no seams or cracks between the 280 atlas parcels.
//   5. Taubin smoothing, proper rotation (anterior -Z, superior +Y, midline plane at X = 0),
//      meshoptimizer simplify, small topology cleanup, smooth normals, center the bounding box,
//      scale so the Z (anterior-posterior) extent is exactly 2.0.
//   6. Write one node / one mesh / one primitive / one material with POSITION (float32) and NORMAL,
//      EXT_meshopt_compression (normals octahedral 8 bit, which needs KHR_mesh_quantization).
//      No Draco. Load in three.js with GLTFLoader + MeshoptDecoder.

import { Document, NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { reorder } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const opt = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v === undefined ? true : v]; }));
const [inPath, outPath] = positional;
const VOXEL = Number(opt.voxel ?? 0.4);
const SMOOTH = Number(opt.smooth ?? 3);
const BLUR = Number(opt.blur ?? 1);
const TARGET_TRIS = Number(opt['target-tris'] ?? 250000);
const MAX_ERROR = Number(opt['max-error'] ?? 0.002);
const log = (...a) => console.log(...a);

await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready, MeshoptSimplifier.ready]);

if (opt['verify-only']) {
  if (!inPath && !outPath) throw new Error('usage: --verify-only <brain.glb>');
  await verify(outPath || inPath);
  process.exit(0);
}
if (!inPath || !outPath) {
  console.error('usage: node prepare-brain.mjs <input.glb> <output.glb> [--voxel=0.4] [--blur=1] [--smooth=3] [--target-tris=250000] [--max-error=0.002] [--debug]');
  process.exit(1);
}

// ---------------------------------------------------------------------------------------------
// 1. Read source, bake transforms, classify
// ---------------------------------------------------------------------------------------------
const APPENDAGES = /(^|_)(olfactory_bulb|olfactory_tract|optic_tract)_[LR]$|optic_chiasm/;
const src = await new NodeIO().read(inPath);
const meshNodes = src.getRoot().listNodes().filter((n) => n.getMesh());
log(`source: ${src.getRoot().listNodes().length} nodes, ${meshNodes.length} mesh nodes`);

function gather(nodes) {
  let nv = 0, nt = 0;
  for (const n of nodes) for (const p of n.getMesh().listPrimitives()) {
    if (p.getMode() !== 4) throw new Error(`non-triangle primitive in ${n.getName()}`);
    nv += p.getAttribute('POSITION').getCount();
    nt += (p.getIndices() ? p.getIndices().getCount() : p.getAttribute('POSITION').getCount()) / 3;
  }
  const pos = new Float64Array(nv * 3), idx = new Uint32Array(nt * 3);
  let vo = 0, to = 0;
  for (const n of nodes) {
    const m = n.getWorldMatrix();
    for (const p of n.getMesh().listPrimitives()) {
      const P = p.getAttribute('POSITION'), c = P.getCount(), e = [0, 0, 0];
      for (let i = 0; i < c; i++) {
        P.getElement(i, e);
        pos[(vo + i) * 3] = (m[0] * e[0] + m[4] * e[1] + m[8] * e[2] + m[12]) * 1000;
        pos[(vo + i) * 3 + 1] = (m[1] * e[0] + m[5] * e[1] + m[9] * e[2] + m[13]) * 1000;
        pos[(vo + i) * 3 + 2] = (m[2] * e[0] + m[6] * e[1] + m[10] * e[2] + m[14]) * 1000;
      }
      const I = p.getIndices() ? p.getIndices().getArray() : Uint32Array.from({ length: c }, (_, i) => i);
      for (let t = 0; t < I.length; t++) idx[to * 3 + t] = I[t] + vo;
      vo += c; to += I.length / 3;
    }
  }
  return { pos, idx };
}

const kept = meshNodes.filter((n) => !APPENDAGES.test(n.getName()));
const dropped = meshNodes.filter((n) => APPENDAGES.test(n.getName()));
log(`appendages dropped before the shell build: ${dropped.length} (${dropped.map((n) => n.getName()).join(', ')})`);

// Midline (mirror) plane from the _L/_R pairs: the halves are exact mirror copies, so the vector
// between the centroids of each pair is parallel to the plane normal.
const byName = new Map(meshNodes.map((n) => [n.getName(), n]));
const nrmAcc = [0, 0, 0];
let pairs = 0;
for (const [name, node] of byName) {
  if (!name.endsWith('_L')) continue;
  const other = byName.get(name.slice(0, -2) + '_R');
  if (!other) continue;
  const cL = centroid(gather([node]).pos), cR = centroid(gather([other]).pos);
  const w = node.getMesh().listPrimitives()[0].getAttribute('POSITION').getCount();
  for (let k = 0; k < 3; k++) nrmAcc[k] += w * (cR[k] - cL[k]);
  pairs++;
}
const mirrorN = normalize(nrmAcc); // points from the _L side to the _R side
log(`midline plane normal from ${pairs} _L/_R pairs (source frame, toward _R): ${mirrorN.map((v) => v.toFixed(4)).join(', ')}; tilt from source X axis ${deg(Math.acos(Math.abs(mirrorN[0]))).toFixed(2)} deg`);

// ---------------------------------------------------------------------------------------------
// 2-4. Outer shell
// ---------------------------------------------------------------------------------------------
const all = gather(kept);
log(`shell input: ${all.pos.length / 3} vertices, ${all.idx.length / 3} triangles`);
let shell = buildShell(all.pos, all.idx, VOXEL);
shell = keepLargeComponents(shell, 0.002);
if (opt.debug) meshStats('shell', shell.pos, shell.idx);
if (SMOOTH > 0) taubin(shell, SMOOTH, 0.5, -0.53);
if (opt.debug) meshStats('smoothed', shell.pos, shell.idx);

// ---------------------------------------------------------------------------------------------
// 5. Orientation: proper rotation (det +1). Rows: -n (so _R goes to -X), up, -anterior.
// Source frame: +Y superior, +Z anterior (measured, see README). Up is source +Y made orthogonal to n.
// ---------------------------------------------------------------------------------------------
const up = normalize(sub([0, 1, 0], scale(mirrorN, mirrorN[1])));
const ant = cross(mirrorN, up); // right handed (n, up, ant); ~ source +Z
const R = [scale(mirrorN, -1), up, scale(ant, -1)];
const det = R[0][0] * (R[1][1] * R[2][2] - R[1][2] * R[2][1]) - R[0][1] * (R[1][0] * R[2][2] - R[1][2] * R[2][0]) + R[0][2] * (R[1][0] * R[2][1] - R[1][1] * R[2][0]);
log(`rotation rows: ${R.map((r) => '[' + r.map((v) => v.toFixed(5)).join(', ') + ']').join(' ')}  det = ${det.toFixed(6)}`);
if (Math.abs(det - 1) > 1e-9) throw new Error('rotation is not proper');
const rp = shell.pos;
for (let i = 0; i < rp.length; i += 3) {
  const x = rp[i], y = rp[i + 1], z = rp[i + 2];
  rp[i] = R[0][0] * x + R[0][1] * y + R[0][2] * z;
  rp[i + 1] = R[1][0] * x + R[1][1] * y + R[1][2] * z;
  rp[i + 2] = R[2][0] * x + R[2][1] * y + R[2][2] * z;
}
// where do the _L parcels land? (centroid of all _L geometry through the same rotation)
const lC = centroid(gather(meshNodes.filter((n) => n.getName().endsWith('_L'))).pos);
log(`_L geometry centroid after rotation: X = ${(R[0][0] * lC[0] + R[0][1] * lC[1] + R[0][2] * lC[2]).toFixed(2)} mm (before centering)`);

// ---------------------------------------------------------------------------------------------
// Simplify
// ---------------------------------------------------------------------------------------------
const pos32 = Float32Array.from(shell.pos);
const [simpIdx, simpErr] = MeshoptSimplifier.simplify(shell.idx, pos32, 3, Math.min(TARGET_TRIS * 3, shell.idx.length), MAX_ERROR, []);
const errScale = MeshoptSimplifier.getScale(pos32, 3);
log(`simplify: ${shell.idx.length / 3} -> ${simpIdx.length / 3} triangles, error ${(simpErr * errScale).toFixed(4)} mm (relative ${simpErr.toFixed(5)})`);
if (opt.debug) meshStats('simplified', pos32, simpIdx);
// Edge collapses can squash a thin fold into two coincident, opposite facing sheets. Remove such
// pairs, then give any remaining pinched fan its own vertex so every vertex has one clean normal.
const cleaned = splitNonManifold({ pos: pos32, idx: removeOppositePairs(simpIdx) });
const [remap, uniq] = MeshoptSimplifier.compactMesh(cleaned.idx); // indices are rewritten in place
let fpos = new Float64Array(uniq * 3);
for (let i = 0; i < remap.length; i++) if (remap[i] !== 0xffffffff) for (let k = 0; k < 3; k++) fpos[remap[i] * 3 + k] = cleaned.pos[i * 3 + k];
const fidx = cleaned.idx;
if (opt.debug) meshStats('cleaned', fpos, fidx);

// ---------------------------------------------------------------------------------------------
// Placement: center bbox at origin, scale Z extent to exactly 2.0
// ---------------------------------------------------------------------------------------------
let bb = bbox(fpos);
const center = bb.min.map((v, k) => (v + bb.max[k]) / 2);
const s = 2 / (bb.max[2] - bb.min[2]);
log(`placement: AP length ${(bb.max[2] - bb.min[2]).toFixed(3)} mm, scale ${s.toExponential(6)} per mm`);
for (let i = 0; i < fpos.length; i += 3) for (let k = 0; k < 3; k++) fpos[i + k] = (fpos[i + k] - center[k]) * s;
// float32 rounding can leave the Z extent a hair off 2.0; snap the exact extreme vertices
bb = bbox(fpos);
for (let i = 2; i < fpos.length; i += 3) { if (fpos[i] === bb.min[2]) fpos[i] = -1; if (fpos[i] === bb.max[2]) fpos[i] = 1; }
const outPos = Float32Array.from(fpos);
const outNrm = vertexNormals(outPos, fidx);

// ---------------------------------------------------------------------------------------------
// 6. Write glTF
// ---------------------------------------------------------------------------------------------
const doc = new Document();
doc.getRoot().getAsset().generator = 'say-when tools/brain-asset/prepare-brain.mjs (glTF-Transform)';
doc.getRoot().getAsset().copyright = '3D Reference Organ for Brain, Male v1.3 by Kristen Browne and Heidi Schlehlein, Human Reference Atlas (HuBMAP), https://doi.org/10.48539/HBM929.XKCL.339, CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Modified: outer surface rebuilt, simplified, re-oriented and rescaled.';
const buffer = doc.createBuffer();
const material = doc.createMaterial('brain').setBaseColorFactor([0.86, 0.72, 0.68, 1]).setMetallicFactor(0).setRoughnessFactor(0.65);
const prim = doc.createPrimitive()
  .setAttribute('POSITION', doc.createAccessor('position').setType('VEC3').setArray(outPos).setBuffer(buffer))
  .setAttribute('NORMAL', doc.createAccessor('normal').setType('VEC3').setArray(outNrm).setBuffer(buffer))
  .setIndices(doc.createAccessor('indices').setType('SCALAR').setArray(fidx).setBuffer(buffer))
  .setMaterial(material);
const mesh = doc.createMesh('Brain').addPrimitive(prim);
const node = doc.createNode('Brain').setMesh(mesh);
doc.createScene('Scene').addChild(node);
doc.getRoot().setDefaultScene(doc.getRoot().listScenes()[0]);
await doc.transform(reorder({ encoder: MeshoptEncoder, target: 'size' }));
doc.createExtension(KHRMeshQuantization).setRequired(true);
doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
const io = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization]).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
await io.write(outPath, doc);
log(`wrote ${outPath}`);
await verify(outPath);

// =============================================================================================
// helpers
// =============================================================================================
async function verify(path) {
  const { statSync } = await import('node:fs');
  const io2 = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization]).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const d = await io2.read(path);
  const root = d.getRoot();
  const prims = root.listMeshes().flatMap((m) => m.listPrimitives());
  const p = prims[0];
  const P = p.getAttribute('POSITION'), N = p.getAttribute('NORMAL');
  const e = [0, 0, 0], min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.getCount(); i++) { P.getElement(i, e); for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], e[k]); max[k] = Math.max(max[k], e[k]); } }
  log('--- verify', path);
  log(`file size ${statSync(path).size} bytes; extensionsUsed ${root.listExtensionsUsed().map((x) => x.extensionName).join(', ')}`);
  log(`nodes ${root.listNodes().length}, meshes ${root.listMeshes().length}, primitives ${prims.length}, materials ${root.listMaterials().length}`);
  log(`attributes ${p.listSemantics().join(', ')}; POSITION ${P.getComponentType() === 5126 ? 'float32' : P.getComponentType()}; NORMAL componentType ${N.getComponentType()} normalized ${N.getNormalized()}`);
  log(`vertices ${P.getCount()}, triangles ${p.getIndices().getCount() / 3}`);
  log(`bbox min ${min.map((v) => v.toFixed(6)).join(', ')}  max ${max.map((v) => v.toFixed(6)).join(', ')}`);
  log(`extent ${max.map((v, k) => (v - min[k]).toFixed(6)).join(', ')}; center ${max.map((v, k) => ((v + min[k]) / 2).toFixed(6)).join(', ')}`);
  for (const n of root.listNodes()) { const t = n.getTranslation(), r = n.getRotation(), sc = n.getScale(); log(`node ${n.getName()} T ${t} R ${r} S ${sc}`); }
}

function buildShell(pos, idx, h) {
  const T = idx.length / 3;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { if (pos[i + k] < min[k]) min[k] = pos[i + k]; if (pos[i + k] > max[k]) max[k] = pos[i + k]; }
  const PAD = 4;
  const o = min.map((v) => v - PAD * h);
  const nx = Math.ceil((max[0] - min[0]) / h) + 2 * PAD, ny = Math.ceil((max[1] - min[1]) / h) + 2 * PAD, nz = Math.ceil((max[2] - min[2]) / h) + 2 * PAD;
  const NXY = nx * ny, NV = NXY * nz;
  log(`voxel grid ${nx} x ${ny} x ${nz} at ${h} mm (${(NV / 1e6).toFixed(1)} M voxels)`);
  // cls: 0 = enclosed, 1 = touched by a triangle, 2 = outside (flood fill)
  const cls = new Uint8Array(NV);
  const step = h * 0.3;
  for (let t = 0; t < T; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const L = Math.max(dist3(pos, a, b), dist3(pos, a, c), dist3(pos, b, c));
    const m = Math.max(1, Math.ceil(L / step));
    for (let i = 0; i <= m; i++) for (let j = 0; j <= m - i; j++) {
      const u = i / m, v = j / m, w = 1 - u - v;
      const x = Math.floor((w * pos[a] + u * pos[b] + v * pos[c] - o[0]) / h);
      const y = Math.floor((w * pos[a + 1] + u * pos[b + 1] + v * pos[c + 1] - o[1]) / h);
      const z = Math.floor((w * pos[a + 2] + u * pos[b + 2] + v * pos[c + 2] - o[2]) / h);
      cls[x + nx * (y + ny * z)] = 1;
    }
  }
  // flood fill the outside (6-connected) with a ring buffer queue
  const QN = 1 << 25, QM = QN - 1, q = new Int32Array(QN);
  let qh = 0, qt = 0, outside = 0;
  const push = (v) => { cls[v] = 2; q[qt & QM] = v; qt++; outside++; if (qt - qh > QN) throw new Error('flood queue overflow'); };
  push(0);
  while (qh < qt) {
    const v = q[qh & QM]; qh++;
    const x = v % nx, y = Math.floor(v / nx) % ny, z = Math.floor(v / NXY);
    if (x > 0 && cls[v - 1] === 0) push(v - 1);
    if (x < nx - 1 && cls[v + 1] === 0) push(v + 1);
    if (y > 0 && cls[v - nx] === 0) push(v - nx);
    if (y < ny - 1 && cls[v + nx] === 0) push(v + nx);
    if (z > 0 && cls[v - NXY] === 0) push(v - NXY);
    if (z < nz - 1 && cls[v + NXY] === 0) push(v + NXY);
  }
  const isOut = (x, y, z) => {
    const i = Math.floor((x - o[0]) / h), j = Math.floor((y - o[1]) / h), k = Math.floor((z - o[2]) / h);
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return true;
    return cls[i + nx * (j + ny * k)] === 2;
  };
  // triangles that touch the outside
  const exposed = [];
  const samples = [[1 / 3, 1 / 3, 1 / 3], [2 / 3, 1 / 6, 1 / 6], [1 / 6, 2 / 3, 1 / 6], [1 / 6, 1 / 6, 2 / 3]];
  for (let t = 0; t < T; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const n = faceNormal(pos, a, b, c);
    if (!n) continue;
    let hit = false;
    for (const [w, u, v] of samples) {
      const px = w * pos[a] + u * pos[b] + v * pos[c], py = w * pos[a + 1] + u * pos[b + 1] + v * pos[c + 1], pz = w * pos[a + 2] + u * pos[b + 2] + v * pos[c + 2];
      for (const d of [h, 1.5 * h, -h, -1.5 * h]) if (isOut(px + n[0] * d, py + n[1] * d, pz + n[2] * d)) { hit = true; break; }
      if (hit) break;
    }
    if (hit) exposed.push(t);
  }
  log(`outside voxels ${outside}; triangles touching the outside ${exposed.length} of ${T}`);

  // narrow band unsigned distance to the exposed triangles + sign hint from the closest face
  const BAND = 3 * h;
  const dist = new Float32Array(NV).fill(BAND);
  const hint = new Int8Array(NV); // signed alignment of (p - closest) with the face normal, 0 = none
  const cp = [0, 0, 0];
  for (const t of exposed) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const n = faceNormal(pos, a, b, c);
    const lo = [0, 1, 2].map((k) => Math.max(0, Math.floor((Math.min(pos[a + k], pos[b + k], pos[c + k]) - BAND - o[k]) / h - 0.5)));
    const hi = [0, 1, 2].map((k) => Math.min([nx, ny, nz][k] - 1, Math.ceil((Math.max(pos[a + k], pos[b + k], pos[c + k]) + BAND - o[k]) / h - 0.5)));
    for (let k = lo[2]; k <= hi[2]; k++) {
      const pz = o[2] + (k + 0.5) * h;
      for (let j = lo[1]; j <= hi[1]; j++) {
        const py = o[1] + (j + 0.5) * h;
        for (let i = lo[0]; i <= hi[0]; i++) {
          const px = o[0] + (i + 0.5) * h;
          closestOnTri(px, py, pz, pos, a, b, c, cp);
          const dx = px - cp[0], dy = py - cp[1], dz = pz - cp[2];
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          const v = i + nx * (j + ny * k);
          if (d > dist[v] + 1e-6) continue;
          const al = d > 1e-9 ? (dx * n[0] + dy * n[1] + dz * n[2]) / d : 1;
          const ah = Math.max(-127, Math.min(127, Math.round(al * 127))) || (al >= 0 ? 1 : -1);
          if (d < dist[v] - 1e-6 || Math.abs(ah) > Math.abs(hint[v])) { dist[v] = Math.min(d, dist[v]); hint[v] = ah; }
        }
      }
    }
  }
  // signed field: outside +, enclosed -, touched voxels take the sign of their closest outer face
  const f = dist; // reuse memory
  for (let v = 0; v < NV; v++) {
    const c = cls[v];
    if (c === 2) continue;
    if (c === 1 && hint[v] > 0) continue;
    f[v] = -f[v];
  }

  // optional separable binomial blur [1 4 6 4 1] / 16 of the signed field (sigma about one voxel),
  // which removes voxel scale saw teeth along sulcal lips and softens the slice terracing of the atlas
  for (let pass = 0; pass < BLUR; pass++) blurField(f, nx, ny, nz);
  if (BLUR) log(`field blur: ${BLUR} pass(es) of a 5 tap binomial kernel per axis`);

  // marching tetrahedra on the Kuhn split of each voxel cube (6 tets sharing the main diagonal).
  // No ambiguous cases, so the result is a closed 2-manifold.
  const TETS = [[0, 1, 3, 7], [0, 3, 2, 7], [0, 2, 6, 7], [0, 6, 4, 7], [0, 4, 5, 7], [0, 5, 1, 7]];
  const LAYER = nx * ny * 7;
  let L0 = new Int32Array(LAYER).fill(-1), L1 = new Int32Array(LAYER).fill(-1);
  let vpos = new Float64Array(1 << 22), nvert = 0;
  let tris = new Uint32Array(1 << 23), ntri = 0;
  const val = new Float64Array(8);
  let ci = 0, cj = 0, ck = 0;
  const edgeVert = (u, w) => {
    let a = u, b = w;
    if ((u & w) !== u) { a = w; b = u; }
    const ax = ci + (a & 1), ay = cj + ((a >> 1) & 1);
    const layer = a & 4 ? L1 : L0;
    const key = (ax + nx * ay) * 7 + ((a ^ b) - 1);
    let id = layer[key];
    if (id >= 0) return id;
    const fa = val[a], fb = val[b], t = fa / (fa - fb);
    if (nvert * 3 + 3 > vpos.length) { const g = new Float64Array(vpos.length * 2); g.set(vpos); vpos = g; }
    vpos[nvert * 3] = o[0] + (ci + (a & 1) + t * ((b & 1) - (a & 1)) + 0.5) * h;
    vpos[nvert * 3 + 1] = o[1] + (cj + ((a >> 1) & 1) + t * (((b >> 1) & 1) - ((a >> 1) & 1)) + 0.5) * h;
    vpos[nvert * 3 + 2] = o[2] + (ck + ((a >> 2) & 1) + t * (((b >> 2) & 1) - ((a >> 2) & 1)) + 0.5) * h;
    id = nvert++;
    layer[key] = id;
    return id;
  };
  const emit = (p, q, r, inC, outC) => {
    // orient so the normal points from the inside corners toward the outside corners
    const P = vpos;
    const nn = cross([P[q * 3] - P[p * 3], P[q * 3 + 1] - P[p * 3 + 1], P[q * 3 + 2] - P[p * 3 + 2]], [P[r * 3] - P[p * 3], P[r * 3 + 1] - P[p * 3 + 1], P[r * 3 + 2] - P[p * 3 + 2]]);
    let dx = 0, dy = 0, dz = 0;
    for (const c of outC) { dx += (c & 1) / outC.length; dy += ((c >> 1) & 1) / outC.length; dz += ((c >> 2) & 1) / outC.length; }
    for (const c of inC) { dx -= (c & 1) / inC.length; dy -= ((c >> 1) & 1) / inC.length; dz -= ((c >> 2) & 1) / inC.length; }
    if (ntri * 3 + 3 > tris.length) { const g = new Uint32Array(tris.length * 2); g.set(tris); tris = g; }
    if (nn[0] * dx + nn[1] * dy + nn[2] * dz >= 0) { tris[ntri * 3] = p; tris[ntri * 3 + 1] = q; tris[ntri * 3 + 2] = r; }
    else { tris[ntri * 3] = p; tris[ntri * 3 + 1] = r; tris[ntri * 3 + 2] = q; }
    ntri++;
  };
  for (ck = 0; ck < nz - 1; ck++) {
    for (cj = 0; cj < ny - 1; cj++) for (ci = 0; ci < nx - 1; ci++) {
      let neg = 0;
      for (let c = 0; c < 8; c++) { const x = val[c] = f[(ci + (c & 1)) + nx * ((cj + ((c >> 1) & 1)) + ny * (ck + ((c >> 2) & 1)))]; if (x < 0) neg++; }
      if (neg === 0 || neg === 8) continue;
      for (const tet of TETS) {
        const inC = [], outC = [];
        for (const c of tet) (val[c] < 0 ? inC : outC).push(c);
        if (inC.length === 0 || outC.length === 0) continue;
        if (inC.length === 1 || outC.length === 1) {
          const lone = inC.length === 1 ? inC[0] : outC[0];
          const rest = inC.length === 1 ? outC : inC;
          emit(edgeVert(lone, rest[0]), edgeVert(lone, rest[1]), edgeVert(lone, rest[2]), inC, outC);
        } else {
          const [p, q] = inC, [r, s] = outC;
          const pr = edgeVert(p, r), ps = edgeVert(p, s), qs = edgeVert(q, s), qr = edgeVert(q, r);
          emit(pr, ps, qs, inC, outC);
          emit(pr, qs, qr, inC, outC);
        }
      }
    }
    const tmp = L0; L0 = L1; L1 = tmp; L1.fill(-1);
  }
  log(`marching tetrahedra: ${nvert} vertices, ${ntri} triangles`);
  return { pos: vpos.slice(0, nvert * 3), idx: tris.slice(0, ntri * 3) };
}

function meshStats(label, pos, idx) {
  const n = pos.length / 3;
  const em = new Map();
  for (let t = 0; t < idx.length; t += 3) for (let k = 0; k < 3; k++) { const a = idx[t + k], b = idx[t + (k + 1) % 3]; const key = a < b ? a * n + b : b * n + a; em.set(key, (em.get(key) || 0) + 1); }
  let bnd = 0, nm = 0; for (const c of em.values()) { if (c === 1) bnd++; else if (c > 2) nm++; }
  const acc = new Float64Array(n * 3), cnt = new Uint32Array(n);
  let degen = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const f = faceNormal(pos, idx[t] * 3, idx[t + 1] * 3, idx[t + 2] * 3);
    if (!f) { degen++; continue; }
    for (let k = 0; k < 3; k++) { const v = idx[t + k]; acc[v * 3] += f[0]; acc[v * 3 + 1] += f[1]; acc[v * 3 + 2] += f[2]; cnt[v]++; }
  }
  let low = 0; for (let i = 0; i < n; i++) if (Math.hypot(acc[i * 3], acc[i * 3 + 1], acc[i * 3 + 2]) / cnt[i] < 0.3) low++;
  // duplicate triangles (same vertex set)
  const ts = new Map(); let dup = 0;
  for (let t = 0; t < idx.length; t += 3) { const k = [idx[t], idx[t + 1], idx[t + 2]].sort((a, b) => a - b).join(','); if (ts.has(k)) dup++; else ts.set(k, 1); }
  log(`[${label}] verts ${n}, tris ${idx.length / 3}, boundary edges ${bnd}, non-manifold edges ${nm}, degenerate tris ${degen}, duplicate tris ${dup}, low-coherence verts ${low}`);
}

function removeOppositePairs(idx) {
  const groups = new Map();
  for (let t = 0; t < idx.length; t += 3) {
    const k = [idx[t], idx[t + 1], idx[t + 2]].sort((a, b) => a - b).join(',');
    const g = groups.get(k);
    if (g) g.push(t); else groups.set(k, [t]);
  }
  const orient = (t) => { const a = idx[t], b = idx[t + 1], c = idx[t + 2], m = Math.min(a, b, c); return (a === m ? b < c : b === m ? c < a : a < b) ? 1 : -1; };
  const drop = new Set();
  let pairs = 0, same = 0;
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const p = list.filter((t) => orient(t) > 0), n = list.filter((t) => orient(t) < 0);
    const np = Math.min(p.length, n.length);
    pairs += np;
    for (let i = 0; i < np; i++) { drop.add(p[i]); drop.add(n[i]); }
    for (const rest of [p.slice(np), n.slice(np)]) for (let i = 1; i < rest.length; i++) { drop.add(rest[i]); same++; }
  }
  const out = new Uint32Array(idx.length - drop.size * 3);
  let o = 0;
  for (let t = 0; t < idx.length; t += 3) if (!drop.has(t)) { out[o++] = idx[t]; out[o++] = idx[t + 1]; out[o++] = idx[t + 2]; }
  log(`removed ${pairs} pairs of coincident opposite triangles and ${same} exact duplicates`);
  return out;
}

// If two sheets still touch at a single vertex after simplification, give every edge-connected fan of
// triangles around that vertex its own copy of the vertex, so each sheet gets its own clean normal.
function splitNonManifold(m) {
  const nv = m.pos.length / 3, nt = m.idx.length / 3;
  const start = new Int32Array(nv + 1);
  for (let i = 0; i < m.idx.length; i++) start[m.idx[i] + 1]++;
  for (let i = 0; i < nv; i++) start[i + 1] += start[i];
  const fill = start.slice(0, nv), inc = new Int32Array(m.idx.length);
  for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) inc[fill[m.idx[t * 3 + k]]++] = t;
  const extra = [];
  const idx = Uint32Array.from(m.idx);
  let splitVerts = 0;
  for (let v = 0; v < nv; v++) {
    const ts = inc.subarray(start[v], start[v + 1]);
    const k = ts.length;
    if (k < 2) continue;
    const parent = Array.from({ length: k }, (_, i) => i);
    const find = (x) => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
    const byOther = new Map();
    for (let a = 0; a < k; a++) for (let c = 0; c < 3; c++) { const w = m.idx[ts[a] * 3 + c]; if (w === v) continue; (byOther.get(w) || byOther.set(w, []).get(w)).push(a); }
    for (const list of byOther.values()) if (list.length === 2) parent[find(list[0])] = find(list[1]);
    const roots = new Map();
    for (let a = 0; a < k; a++) { const r = find(a); if (!roots.has(r)) roots.set(r, roots.size); }
    if (roots.size < 2) continue;
    splitVerts++;
    for (let a = 0; a < k; a++) {
      const g = roots.get(find(a));
      if (g === 0) continue;
      const id = nv + extra.length / 3 + (g - 1);
      for (let c = 0; c < 3; c++) if (m.idx[ts[a] * 3 + c] === v) idx[ts[a] * 3 + c] = id;
    }
    for (let g = 1; g < roots.size; g++) extra.push(m.pos[v * 3], m.pos[v * 3 + 1], m.pos[v * 3 + 2]);
  }
  const pos = new Float64Array(m.pos.length + extra.length);
  pos.set(m.pos); pos.set(extra, m.pos.length);
  log(`non-manifold vertices split: ${splitVerts} (added ${extra.length / 3} vertex copies)`);
  return { pos, idx };
}

function blurField(f, nx, ny, nz) {
  const line = new Float32Array(Math.max(nx, ny, nz));
  const run = (count, stride, base) => {
    for (let i = 0; i < count; i++) line[i] = f[base + i * stride];
    for (let i = 0; i < count; i++) {
      const a = line[Math.max(0, i - 2)], b = line[Math.max(0, i - 1)], c = line[i], d = line[Math.min(count - 1, i + 1)], e = line[Math.min(count - 1, i + 2)];
      f[base + i * stride] = (a + 4 * b + 6 * c + 4 * d + e) / 16;
    }
  };
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) run(nx, 1, nx * (j + ny * k));
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) run(ny, nx, i + nx * ny * k);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) run(nz, nx * ny, i + nx * j);
}

function keepLargeComponents(m, minFrac) {
  const nv = m.pos.length / 3, parent = new Int32Array(nv).map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let t = 0; t < m.idx.length; t += 3) { const a = find(m.idx[t]), b = find(m.idx[t + 1]), c = find(m.idx[t + 2]); parent[b] = a; parent[find(c)] = a; }
  const count = new Map();
  for (let t = 0; t < m.idx.length; t += 3) { const r = find(m.idx[t]); count.set(r, (count.get(r) || 0) + 1); }
  const total = m.idx.length / 3;
  const sizes = [...count.values()].sort((a, b) => b - a);
  const keep = new Set([...count].filter(([, c]) => c >= minFrac * total).map(([r]) => r));
  let nt = 0;
  for (let t = 0; t < m.idx.length; t += 3) if (keep.has(find(m.idx[t]))) nt++;
  // signed volume per component: negative = closed void inside the solid, positive = separate piece
  const vol = new Map();
  for (let t = 0; t < m.idx.length; t += 3) {
    const r = find(m.idx[t]); if (keep.has(r)) continue;
    const a = m.idx[t] * 3, b = m.idx[t + 1] * 3, c = m.idx[t + 2] * 3, P = m.pos;
    const v = (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6;
    vol.set(r, (vol.get(r) || 0) + v);
  }
  const voids = [...vol.values()].filter((v) => v < 0);
  const pieces = [...vol.values()].filter((v) => v >= 0);
  log(`components: ${sizes.length} (largest ${sizes.slice(0, 4).join(', ')}), kept ${keep.size}, removed ${sizes.length - keep.size} with ${total - nt} triangles: ${voids.length} enclosed voids (total ${(-voids.reduce((a, b) => a + b, 0)).toFixed(1)} mm3), ${pieces.length} separate pieces (total ${pieces.reduce((a, b) => a + b, 0).toFixed(1)} mm3, largest ${Math.max(0, ...pieces).toFixed(1)} mm3)`);
  const map = new Int32Array(nv).fill(-1);
  const out = new Uint32Array(nt * 3);
  const pos = new Float64Array(m.pos.length);
  let n = 0, o = 0;
  for (let t = 0; t < m.idx.length; t += 3) {
    if (!keep.has(find(m.idx[t]))) continue;
    for (let k = 0; k < 3; k++) {
      const v = m.idx[t + k];
      if (map[v] < 0) { map[v] = n; pos[n * 3] = m.pos[v * 3]; pos[n * 3 + 1] = m.pos[v * 3 + 1]; pos[n * 3 + 2] = m.pos[v * 3 + 2]; n++; }
      out[o++] = map[v];
    }
  }
  return { pos: pos.slice(0, n * 3), idx: out };
}

function taubin(m, iterations, lambda, mu) {
  // uniform Laplacian. On a closed manifold every neighbor appears twice in the per-triangle edge
  // list, so no de-duplication is needed for an unweighted average.
  const nv = m.pos.length / 3;
  const start = new Int32Array(nv + 1);
  for (let i = 0; i < m.idx.length; i++) start[m.idx[i] + 1] += 2;
  for (let i = 0; i < nv; i++) start[i + 1] += start[i];
  const fill = start.slice(0, nv), adj = new Int32Array(start[nv]);
  for (let t = 0; t < m.idx.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = m.idx[t + e], b = m.idx[t + (e + 1) % 3];
    adj[fill[a]++] = b; adj[fill[b]++] = a;
  }
  const tmp = new Float64Array(m.pos.length);
  const pass = (k) => {
    const p = m.pos;
    for (let i = 0; i < nv; i++) {
      let sx = 0, sy = 0, sz = 0; const n = start[i + 1] - start[i];
      for (let j = start[i]; j < start[i + 1]; j++) { const a = adj[j] * 3; sx += p[a]; sy += p[a + 1]; sz += p[a + 2]; }
      tmp[i * 3] = p[i * 3] + k * (sx / n - p[i * 3]); tmp[i * 3 + 1] = p[i * 3 + 1] + k * (sy / n - p[i * 3 + 1]); tmp[i * 3 + 2] = p[i * 3 + 2] + k * (sz / n - p[i * 3 + 2]);
    }
    p.set(tmp);
  };
  for (let it = 0; it < iterations; it++) { pass(lambda); pass(mu); }
  log(`taubin smoothing: ${iterations} passes (lambda ${lambda}, mu ${mu})`);
}

function vertexNormals(pos, idx) {
  // area weighted face normals accumulated at shared vertices (mesh is welded, so no seams)
  const n = new Float64Array(pos.length);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const e1 = [pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]];
    const e2 = [pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]];
    const fn = cross(e1, e2);
    for (const v of [a, b, c]) { n[v] += fn[0]; n[v + 1] += fn[1]; n[v + 2] += fn[2]; }
  }
  const out = new Float32Array(pos.length);
  for (let i = 0; i < n.length; i += 3) { const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1; out[i] = n[i] / l; out[i + 1] = n[i + 1] / l; out[i + 2] = n[i + 2] / l; }
  return out;
}

function closestOnTri(px, py, pz, P, a, b, c, out) {
  // Ericson, Real-Time Collision Detection, 5.1.5
  const ax = P[a], ay = P[a + 1], az = P[a + 2];
  const abx = P[b] - ax, aby = P[b + 1] - ay, abz = P[b + 2] - az;
  const acx = P[c] - ax, acy = P[c + 1] - ay, acz = P[c + 2] - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) { out[0] = ax; out[1] = ay; out[2] = az; return; }
  const bpx = px - P[b], bpy = py - P[b + 1], bpz = pz - P[b + 2];
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) { out[0] = P[b]; out[1] = P[b + 1]; out[2] = P[b + 2]; return; }
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); out[0] = ax + v * abx; out[1] = ay + v * aby; out[2] = az + v * abz; return; }
  const cpx = px - P[c], cpy = py - P[c + 1], cpz = pz - P[c + 2];
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) { out[0] = P[c]; out[1] = P[c + 1]; out[2] = P[c + 2]; return; }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); out[0] = ax + w * acx; out[1] = ay + w * acy; out[2] = az + w * acz; return; }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    out[0] = P[b] + w * (P[c] - P[b]); out[1] = P[b + 1] + w * (P[c + 1] - P[b + 1]); out[2] = P[b + 2] + w * (P[c + 2] - P[b + 2]); return;
  }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  out[0] = ax + abx * v + acx * w; out[1] = ay + aby * v + acy * w; out[2] = az + abz * v + acz * w;
}

function faceNormal(P, a, b, c) {
  const n = cross([P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]]);
  const l = Math.hypot(n[0], n[1], n[2]);
  return l > 0 ? [n[0] / l, n[1] / l, n[2] / l] : null;
}
function dist3(P, a, b) { return Math.hypot(P[a] - P[b], P[a + 1] - P[b + 1], P[a + 2] - P[b + 2]); }
function centroid(P) { const c = [0, 0, 0]; for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) c[k] += P[i + k]; return c.map((v) => v / (P.length / 3)); }
function bbox(P) { const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]; for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { if (P[i + k] < min[k]) min[k] = P[i + k]; if (P[i + k] > max[k]) max[k] = P[i + k]; } return { min, max }; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function scale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
function normalize(a) { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; }
function deg(r) { return (r * 180) / Math.PI; }
