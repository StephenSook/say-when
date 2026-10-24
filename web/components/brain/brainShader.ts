/**
 * The Screen 1 brain material. Two soft patches, one per electrode, each a Gaussian over the angle between a surface
 * point's direction from the brain center and the electrode's direction. Brightness comes only from uniforms set from
 * measured numbers (patchTargets in lib/brain/model.ts); away from both electrodes the surface fades to neutral gray,
 * so a sparse montage never paints data where there is none. Values live in uniforms, not vertex colors: updating a
 * few floats per frame is free, rewriting colors on the whole mesh is not.
 *
 * Colors above 1.0 feed the selective Bloom pass; the material is not tone mapped.
 */
import { Color, ShaderMaterial, Vector3 } from 'three';
import { AMBER, CYAN } from '@/lib/brain/model';

/** Angular width of a patch, radians. Wide and soft on purpose: a scalp electrode sees a broad area. */
export const PATCH_SIGMA = 0.36;

const vertexShader = /* glsl */ `
varying vec3 vPos;
varying vec3 vNormal;
varying vec3 vView;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vPos = world.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vView = normalize(cameraPosition - world.xyz);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const fragmentShader = /* glsl */ `
uniform vec3 uCenter;
uniform vec3 uC3Dir;
uniform vec3 uC4Dir;
uniform float uC3;
uniform float uC4;
uniform float uSigma;
uniform float uHint;
uniform vec3 uCyan;
uniform vec3 uAmber;
uniform vec3 uBase;
uniform vec3 uRim;
uniform vec3 uLightDir;
varying vec3 vPos;
varying vec3 vNormal;
varying vec3 vView;

float patchWeight(vec3 d, vec3 dir) {
  float a = acos(clamp(dot(d, dir), -1.0, 1.0));
  return exp(-(a * a) / (2.0 * uSigma * uSigma));
}

void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(vView);
  vec3 d = normalize(vPos - uCenter);
  float w3 = patchWeight(d, uC3Dir);
  float w4 = patchWeight(d, uC4Dir);
  float coverage = smoothstep(0.0, 0.15, max(w3, w4));

  // Shape: a soft key light from above and in front, plus a wrap so the gyri read without harsh shadows.
  float diffuse = max(dot(n, normalize(uLightDir)), 0.0) * 0.7 + 0.3;
  float rim = pow(1.0 - max(dot(n, v), 0.0), 2.5);
  vec3 color = uBase * diffuse + uRim * rim * 0.35;

  // uHint is 0: a resting tint could read as a glow. The electrode dots and callouts show where each patch is.
  color += (uCyan * w3 + uAmber * w4) * uHint;

  // The measured glow. Above 1.0 at full strength so Bloom picks it up.
  vec3 glow = uCyan * uC3 * w3 + uAmber * uC4 * w4;
  color += glow * coverage * 1.6;

  gl_FragColor = vec4(color, 1.0);
  #include <colorspace_fragment>
}
`;

export interface BrainUniforms {
  [name: string]: { value: unknown };
  uCenter: { value: Vector3 };
  uC3Dir: { value: Vector3 };
  uC4Dir: { value: Vector3 };
  uC3: { value: number };
  uC4: { value: number };
  uSigma: { value: number };
  uHint: { value: number };
  uCyan: { value: Color };
  uAmber: { value: Color };
  uBase: { value: Color };
  uRim: { value: Color };
  uLightDir: { value: Vector3 };
}

export function makeBrainMaterial(c3Dir: Vector3, c4Dir: Vector3): ShaderMaterial {
  const uniforms: BrainUniforms = {
    uCenter: { value: new Vector3(0, 0, 0) },
    uC3Dir: { value: c3Dir.clone().normalize() },
    uC4Dir: { value: c4Dir.clone().normalize() },
    uC3: { value: 0 },
    uC4: { value: 0 },
    uSigma: { value: PATCH_SIGMA },
    uHint: { value: 0 },
    uCyan: { value: new Color(CYAN) },
    uAmber: { value: new Color(AMBER) },
    // Neutral gray-blue: no hue of its own, so only the two patches carry color.
    uBase: { value: new Color('#3a4150') },
    uRim: { value: new Color('#c8d2e6') },
    // From above, a little toward the viewer (the camera is above and behind the head).
    uLightDir: { value: new Vector3(-0.25, 1, 0.45) },
  };
  const material = new ShaderMaterial({ uniforms, vertexShader, fragmentShader });
  material.toneMapped = false;
  return material;
}
