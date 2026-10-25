'use client';

/**
 * Screen 1's 3D view: the template brain, the electrodes the headset has, a thin leader line from C3 and C4 down to
 * their patches, each patch's label riding its electrode ("C3" over its number, so turning the brain can never swap
 * the sides), and the decoder's ring pulse. Every frame it reads the stream's latest numbers (not React state) and
 * eases the two patch values toward patchTargets with a 125 ms time constant.
 *
 * The camera starts in the standard EEG top view (nose up, C3 left, C4 right). Drag turns the brain; it never moves
 * by itself, so nothing moves during trials unless someone drags it. No zoom and no pan, as on /replies. The model
 * is baked so the subject's left is -X, up is +Y and anterior is -Z (tools/brain-asset), matching toScene in
 * lib/brain/model.ts, which test/brain-hemisphere.test.ts checks.
 */
import { Html, Line, OrbitControls, useGLTF } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Bloom, EffectComposer } from '@react-three/postprocessing';
import { Component, Suspense, useEffect, useMemo, useRef, type MutableRefObject, type ReactNode } from 'react';
import { Box3, BufferGeometry, DoubleSide, Mesh, Raycaster, Vector3, type Group, type MeshBasicMaterial, type Object3D } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { AMBER, CAMERA_POSITION, CYAN, ELECTRODES, PULSE_MS, electrodeDirection, patchTargets, pulseSide, type Vec3 } from '@/lib/brain/model';
import { brainInputOf, type VizStream } from '@/lib/brain/stream';
import { makeBrainMaterial } from './brainShader';
import styles from './BrainScene.module.css';

export const MODEL_URL = '/models/brain.glb';
/** Patch easing time constant, seconds. */
const EASE_S = 0.125;
/** Electrodes sit this far outside the brain's bounding ellipsoid, where a cap would hold them. */
const SENSOR_SCALE = 1.14;

interface Prepared {
  geometry: BufferGeometry;
  half: Vec3;
  mesh: Mesh;
}

/** Bake every mesh into one geometry (positions and normals only) centered on the origin. */
function prepare(root: Object3D): Prepared {
  root.updateMatrixWorld(true);
  const parts: BufferGeometry[] = [];
  root.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const g = mesh.geometry.clone();
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    g.applyMatrix4(mesh.matrixWorld);
    parts.push(g);
  });
  const allIndexed = parts.every((g) => g.index !== null);
  const merged = parts.length === 1 ? parts[0] : mergeGeometries(allIndexed ? parts : parts.map((g) => (g.index ? g.toNonIndexed() : g)), false);
  if (!merged) throw new Error('brain model has no mergeable meshes');
  if (!merged.getAttribute('normal')) merged.computeVertexNormals();
  merged.computeBoundingBox();
  const box = merged.boundingBox as Box3;
  const center = box.getCenter(new Vector3());
  merged.translate(-center.x, -center.y, -center.z);
  const size = box.getSize(new Vector3());
  merged.computeBoundingSphere();
  return { geometry: merged, half: [size.x / 2, size.y / 2, size.z / 2], mesh: new Mesh(merged) };
}

function toVector(v: Vec3): Vector3 {
  return new Vector3(v[0], v[1], v[2]);
}

/** Where a unit direction from the center meets an ellipsoid with these semi-axes. */
function onEllipsoid(dir: Vector3, semi: Vec3): Vector3 {
  const t = 1 / Math.sqrt((dir.x / semi[0]) ** 2 + (dir.y / semi[1]) ** 2 + (dir.z / semi[2]) ** 2);
  return dir.clone().multiplyScalar(t);
}

interface Site {
  name: string;
  dir: Vector3;
  /** Where the electrode sits, just off the head. */
  sensor: Vector3;
  /** On the brain surface, found once by a raycast from outside toward the center. */
  surface: Vector3;
}

function sites(prepared: Prepared, names: string[]): Site[] {
  const raycaster = new Raycaster();
  const semi: Vec3 = [prepared.half[0] * SENSOR_SCALE, prepared.half[1] * SENSOR_SCALE, prepared.half[2] * SENSOR_SCALE];
  const out: Site[] = [];
  for (const name of names) {
    const d = electrodeDirection(name, prepared.half);
    if (!d) continue;
    const dir = toVector(d);
    raycaster.set(dir.clone().multiplyScalar(10), dir.clone().negate());
    const hit = raycaster.intersectObject(prepared.mesh, false)[0];
    out.push({ name, dir, sensor: onEllipsoid(dir, semi), surface: hit ? hit.point.clone() : onEllipsoid(dir, prepared.half) });
  }
  return out;
}

export interface BrainSceneProps {
  stream: VizStream;
  /** Electrodes the headset has (viz.meta.channels); C3 and C4 always get their patches. */
  channels: string[];
  c3Text: string;
  c4Text: string;
  reducedMotion: boolean;
  bloom: boolean;
  /** Called once the person turns the brain, so the page can offer "Reset view". */
  onTurned: () => void;
  /** Filled with a function that puts the camera back. */
  resetRef: MutableRefObject<(() => void) | null>;
  /** What to say if the 3D view cannot load: where the readings below come from (sceneFailedText). */
  failedText: string;
}

function BrainModel({ stream, channels, c3Text, c4Text, reducedMotion }: Pick<BrainSceneProps, 'stream' | 'channels' | 'c3Text' | 'c4Text' | 'reducedMotion'>) {
  const gltf = useGLTF(MODEL_URL, false, true);
  const prepared = useMemo(() => prepare(gltf.scene), [gltf.scene]);
  const named = useMemo(() => Array.from(new Set(['C3', 'C4', ...channels.filter((c) => c in ELECTRODES)])), [channels]);
  const placed = useMemo(() => sites(prepared, named), [prepared, named]);
  const c3 = placed.find((s) => s.name === 'C3')!;
  const c4 = placed.find((s) => s.name === 'C4')!;
  const material = useMemo(() => makeBrainMaterial(c3.dir, c4.dir), [c3.dir, c4.dir]);
  const current = useRef({ c3: 0, c4: 0 });

  useFrame((_, dt) => {
    const target = patchTargets(brainInputOf(stream.state, performance.now()));
    const k = reducedMotion ? 1 : 1 - Math.exp(-Math.min(dt, 0.25) / EASE_S);
    current.current.c3 += (target.c3 - current.current.c3) * k;
    current.current.c4 += (target.c4 - current.current.c4) * k;
    material.uniforms.uC3.value = current.current.c3;
    material.uniforms.uC4.value = current.current.c4;
  });

  return (
    <group>
      <mesh geometry={prepared.geometry} material={material} />
      {placed.map((site) => {
        const hue = site.name === 'C3' ? CYAN : site.name === 'C4' ? AMBER : null;
        return (
          <group key={site.name}>
            <mesh position={site.sensor} renderOrder={2}>
              <sphereGeometry args={[hue ? 0.03 : 0.018, 16, 12]} />
              <meshBasicMaterial color={hue ?? '#9aa1ad'} toneMapped={false} />
            </mesh>
            {hue ? <Line points={[site.sensor, site.surface]} color={hue} lineWidth={1.5} transparent opacity={0.6} /> : null}
          </group>
        );
      })}
      <FrontMarker prepared={prepared} />
      <PatchLabel site={c3} side="c3" text={c3Text} />
      <PatchLabel site={c4} side="c4" text={c4Text} />
      {reducedMotion ? null : <DecoderPulse stream={stream} c3={c3} c4={c4} />}
    </group>
  );
}

/**
 * Small "Front", "L" and "R" marks around the head, so the top view reads like a 10-20 diagram (nose up, the
 * subject's left on the left) and a turned view still says which side is which.
 */
function FrontMarker({ prepared }: { prepared: Prepared }) {
  const { front, left, right } = useMemo(() => {
    const [hx, , hz] = prepared.half;
    return {
      front: new Vector3(0, 0.1, -hz - 0.16),
      left: new Vector3(-hx - 0.14, -0.1, 0.45),
      right: new Vector3(hx + 0.14, -0.1, 0.45),
    };
  }, [prepared]);
  return (
    <>
      <Html position={front} center zIndexRange={[5, 0]} className={styles.labelWrap}>
        <span className={styles.front}>Front</span>
      </Html>
      <Html position={left} center zIndexRange={[5, 0]} className={styles.labelWrap}>
        <span className={styles.front} title="The subject's left">L</span>
      </Html>
      <Html position={right} center zIndexRange={[5, 0]} className={styles.labelWrap}>
        <span className={styles.front} title="The subject's right">R</span>
      </Html>
    </>
  );
}

/**
 * "C3 · 2" (the right fist, option 2) over its number, pinned out to the side of its electrode by a thin callout line, so it never sits over the
 * brain or runs off the top of the stage, and turning the brain carries it along.
 */
function PatchLabel({ site, side, text }: { site: Site; side: 'c3' | 'c4'; text: string }) {
  const { lineEnd, at } = useMemo(() => {
    const out = new Vector3(Math.sign(site.dir.x) || 1, -0.12, 0).normalize();
    return { lineEnd: site.sensor.clone().add(out.clone().multiplyScalar(0.42)), at: site.sensor.clone().add(out.clone().multiplyScalar(0.72)) };
  }, [site]);
  return (
    <>
      <Line points={[site.sensor, lineEnd]} color={side === 'c3' ? CYAN : AMBER} lineWidth={1} transparent opacity={0.5} />
      <Html position={at} center zIndexRange={[5, 0]} className={styles.labelWrap}>
        <div className={styles.label}>
          {/* Direct select (D18): the right fist (C3) is option 2, the left fist (C4) is option 1. */}
          <span className={side === 'c3' ? styles.nameC3 : styles.nameC4} title={side === 'c3' ? 'Right-fist imagery: option 2' : 'Left-fist imagery: option 1'}>
            {side === 'c3' ? 'C3 · 2' : 'C4 · 1'}
          </span>
          <span className={text === 'no reading' ? styles.valueMuted : styles.value}>{text}</span>
        </div>
      </Html>
    </>
  );
}

/**
 * The decoder's guess as a short ring on its side: an expanding, fading ring at the electrode's patch. It plays only
 * for an imagined fist, 1 or 2 (pulseSide), never for the jaw, a key or a switch, and it never changes the glow.
 */
function DecoderPulse({ stream, c3, c4 }: { stream: VizStream; c3: Site; c4: Site }) {
  const ref = useRef<Group>(null);
  const ring = useRef<Mesh>(null);
  useFrame(() => {
    const group = ref.current;
    const mesh = ring.current;
    if (!group || !mesh) return;
    const { markers, markerAt } = stream.state;
    const i = markers.length - 1;
    const side = i >= 0 ? pulseSide(markers[i]) : null;
    const age = i >= 0 ? performance.now() - markerAt[i] : Infinity;
    if (!side || age > PULSE_MS) {
      group.visible = false;
      return;
    }
    const site = side === 'c3' ? c3 : c4;
    const p = age / PULSE_MS;
    group.visible = true;
    group.position.copy(site.surface).add(site.dir.clone().multiplyScalar(0.02));
    group.lookAt(site.surface.clone().add(site.dir));
    const s = 0.08 + p * 0.22;
    mesh.scale.set(s, s, s);
    const mat = mesh.material as MeshBasicMaterial;
    mat.color.set(side === 'c3' ? CYAN : AMBER).multiplyScalar(2.2);
    mat.opacity = 1 - p;
  });
  return (
    <group ref={ref} visible={false}>
      <mesh ref={ring} renderOrder={3}>
        <ringGeometry args={[0.82, 1, 48]} />
        <meshBasicMaterial transparent depthWrite={false} side={DoubleSide} toneMapped={false} />
      </mesh>
    </group>
  );
}

type ControlsLike = {
  reset?: () => void;
  update?: () => void;
  saveState?: () => void;
  target?: Vector3;
  addEventListener?: (type: string, fn: () => void) => void;
  removeEventListener?: (type: string, fn: () => void) => void;
} | null;

/** The home view's distance: the whole brain, "Front" and the two side labels fit at this stage size. */
function homeDistance(fovDeg: number, width: number, height: number): number {
  const fovV = (fovDeg * Math.PI) / 180;
  const fovH = 2 * Math.atan(Math.tan(fovV / 2) * (width / Math.max(1, height)));
  // About 1.2 units up and down from the center in the top view (the brain's length plus "Front"), and 1.75
  // sideways with the labels.
  return Math.max(1.2 / Math.tan(fovV / 2), 1.75 / Math.tan(fovH / 2));
}

/**
 * Keeps the whole brain and its labels in view at any stage size. The home pose is always the standard top view along
 * CAMERA_POSITION at the fitted distance; that is what the controls save, so "Reset view" and a double-click always
 * come back to it, never to a turned view. A turn the person made is kept across a resize, only its distance changes.
 */
function FitCamera({ turnedRef }: { turnedRef: MutableRefObject<boolean> }) {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const controls = useThree((s) => s.controls) as unknown as ControlsLike;
  useEffect(() => {
    if (!('fov' in camera)) return;
    const distance = homeDistance((camera as { fov: number }).fov, size.width, size.height);
    const turnedTo = camera.position.clone();
    camera.position.copy(toVector(CAMERA_POSITION).normalize().multiplyScalar(distance));
    controls?.target?.set(0, 0, 0);
    camera.lookAt(0, 0, 0);
    controls?.update?.();
    controls?.saveState?.();
    if (turnedRef.current) {
      camera.position.copy(turnedTo.setLength(distance));
      controls?.update?.();
    }
    camera.updateProjectionMatrix();
  }, [camera, size.width, size.height, controls, turnedRef]);
  return null;
}

/** Wires "Reset view" and the double-click to the saved home view, and tells the page once the brain was turned. */
function ViewReset({ onTurned, resetRef, turnedRef }: Pick<BrainSceneProps, 'onTurned' | 'resetRef'> & { turnedRef: MutableRefObject<boolean> }) {
  const controls = useThree((s) => s.controls) as unknown as ControlsLike;
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    const reset = () => {
      turnedRef.current = false;
      controls?.reset?.();
    };
    const turned = () => {
      turnedRef.current = true;
      onTurned();
    };
    resetRef.current = reset;
    const el = gl.domElement;
    el.addEventListener('dblclick', reset);
    controls?.addEventListener?.('start', turned);
    return () => {
      el.removeEventListener('dblclick', reset);
      controls?.removeEventListener?.('start', turned);
      resetRef.current = null;
    };
  }, [controls, gl, onTurned, resetRef, turnedRef]);
  return null;
}

class SceneBoundary extends Component<{ children: ReactNode; failedText: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) return <p className={styles.failed}>{this.props.failedText}</p>;
    return this.props.children;
  }
}

export default function BrainScene(props: BrainSceneProps) {
  const { bloom, onTurned, resetRef, failedText, ...model } = props;
  const turnedRef = useRef(false);
  return (
    <SceneBoundary failedText={failedText}>
      <Canvas className={styles.canvas} dpr={[1, 1.5]} camera={{ position: CAMERA_POSITION, fov: 28, near: 0.1, far: 50 }} gl={{ antialias: true, powerPreference: 'high-performance' }} aria-hidden="true">
        <color attach="background" args={['#050505']} />
        <OrbitControls makeDefault enablePan={false} enableZoom={false} enableDamping dampingFactor={0.08} target={[0, 0, 0]} />
        <ViewReset onTurned={onTurned} resetRef={resetRef} turnedRef={turnedRef} />
        <FitCamera turnedRef={turnedRef} />
        <Suspense fallback={null}>
          <BrainModel {...model} />
        </Suspense>
        {bloom ? (
          <EffectComposer multisampling={0}>
            <Bloom luminanceThreshold={1} luminanceSmoothing={0.2} mipmapBlur intensity={0.9} />
          </EffectComposer>
        ) : (
          <></>
        )}
      </Canvas>
    </SceneBoundary>
  );
}
