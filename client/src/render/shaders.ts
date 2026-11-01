// Materials. Lighting follows Java Edition's lightmap: per-vertex sky and block light (0..15) are mapped
// through brightness = l / (4 - 3l), sky light is scaled by the time of day, block light is warm, and the
// "brightness" setting blends in the 1-(1-x)^4 gamma curve. Face shade and AO are baked per vertex.

import * as THREE from "three";
import { TEX } from "../../../shared/blocks.ts";

/** Uniforms shared by every world material, updated once per frame. */
export const U = {
  uSky: { value: 1 }, // sky light multiplier (night ~0.2)
  uSkyTint: { value: new THREE.Color(1, 1, 1) },
  uGamma: { value: 0.5 },
  uFloor: { value: 0 }, // clankersmp spectators: the least light anything gets (a dim night vision)
  uFogColor: { value: new THREE.Color(0.75, 0.85, 1) },
  uFogNear: { value: 80 },
  uFogFar: { value: 128 },
  uTime: { value: 0 },
  uWaterFrame: { value: 0 },
};

const LIGHTMAP = /* glsl */ `
uniform float uSky;
uniform vec3 uSkyTint;
uniform float uGamma;
uniform float uFloor;
float lmCurve(float l) { return l / (4.0 - 3.0 * l); }
vec3 lightmap(float sky, float blk) {
  float s = lmCurve(clamp(sky, 0.0, 1.0)) * uSky;
  float b = lmCurve(clamp(blk, 0.0, 1.0));
  vec3 blockCol = vec3(b, b * ((b * 0.6 + 0.4) * 0.6 + 0.4), b * (b * b * 0.6 + 0.4));
  vec3 c = max(vec3(s) * uSkyTint + blockCol, vec3(uFloor));
  c = mix(c, vec3(0.75), 0.04);
  c = clamp(c, 0.0, 1.0);
  vec3 inv = 1.0 - c;
  vec3 ng = 1.0 - inv * inv * inv * inv;
  c = mix(c, ng, uGamma);
  c = mix(c, vec3(0.75), 0.04);
  return clamp(c, 0.0, 1.0);
}
`;

const FOG = /* glsl */ `
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
vec3 applyFog(vec3 c, float d) {
  float f = smoothstep(uFogNear, uFogFar, d);
  return mix(c, uFogColor, f);
}
`;

const CHUNK_VERT = /* glsl */ `
in vec4 uvp;
in vec4 data;
out vec3 vUv;
out vec2 vLight;
out float vShade;
out float vDist;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  vUv = vec3(uvp.xy / 16.0, data.x);
  vLight = data.yz / 240.0;
  vShade = data.w / 255.0;
  vDist = length(mv.xyz);
}
`;

const CHUNK_FRAG = /* glsl */ `
precision highp sampler2DArray;
uniform sampler2DArray atlas;
uniform float uWaterFrame;
in vec3 vUv;
in vec2 vLight;
in float vShade;
in float vDist;
${LIGHTMAP}
${FOG}
void main() {
#ifdef WATER
  vec4 t = texture(atlas, vec3(vUv.xy, vUv.z + uWaterFrame));
#else
  vec4 t = texture(atlas, vUv);
  if (t.a < 0.5) discard;
#endif
  vec3 col = t.rgb * vShade * lightmap(vLight.x, vLight.y);
  col = applyFog(col, vDist);
#ifdef WATER
  gl_FragColor = vec4(col, t.a);
#else
  gl_FragColor = vec4(col, 1.0);
#endif
}
`;

export function chunkMaterial(atlas: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...U, atlas: { value: atlas } },
    vertexShader: CHUNK_VERT,
    fragmentShader: CHUNK_FRAG,
    side: THREE.FrontSide,
  });
}

export function waterMaterial(atlas: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...U, atlas: { value: atlas } },
    vertexShader: CHUNK_VERT,
    fragmentShader: CHUNK_FRAG,
    defines: { WATER: 1 },
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
  });
}

/** Crack overlay: multiplies the block below by 2 x crack colour (Java's DST_COLOR, SRC_COLOR blend). */
export function crackMaterial(atlas: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { atlas: { value: atlas }, uLayer: { value: TEX.crack0 } },
    vertexShader: /* glsl */ `
      out vec2 vUv;
      void main() { vUv = vec2(uv.x, 1.0 - uv.y); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      precision highp sampler2DArray;
      uniform sampler2DArray atlas;
      uniform float uLayer;
      in vec2 vUv;
      void main() {
        vec4 t = texture(atlas, vec3(vUv, uLayer));
        if (t.a < 0.5) discard;
        gl_FragColor = vec4(t.rgb, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.DstColorFactor,
    blendDst: THREE.SrcColorFactor,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4,
  });
}

/** Entities (players): Java's two fixed light directions + ambient, times the lightmap at their feet. */
export function entityMaterial(map: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...U, map: { value: map }, uLight: { value: new THREE.Vector2(1, 0) }, uTint: { value: new THREE.Color(1, 1, 1) } },
    vertexShader: /* glsl */ `
      out vec2 vUv;
      out float vDiffuse;
      out float vDist;
      void main() {
        vUv = uv;
        vec3 n = normalize(mat3(modelMatrix) * normal);
        vec3 l0 = normalize(vec3(0.2, 1.0, -0.7));
        vec3 l1 = normalize(vec3(-0.2, 1.0, 0.7));
        vDiffuse = min(1.0, 0.4 + 0.6 * (max(dot(n, l0), 0.0) + max(dot(n, l1), 0.0)));
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vDist = length(mv.xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      uniform vec2 uLight;
      uniform vec3 uTint;
      in vec2 vUv;
      in float vDiffuse;
      in float vDist;
      ${LIGHTMAP}
      ${FOG}
      void main() {
        vec4 t = texture(map, vUv);
        if (t.a < 0.5) discard;
        vec3 col = t.rgb * uTint * vDiffuse * lightmap(uLight.x, uLight.y);
        // v6: texels painted three-quarters opaque glow (a night mob's eyes): full bright in the dark
        if (t.a < 0.9) col = t.rgb * uTint;
        gl_FragColor = vec4(applyFog(col, vDist), 1.0);
      }
    `,
  });
}

/** Held block in first person: the chunk shader with a fixed light value. */
export function heldMaterial(atlas: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...U, atlas: { value: atlas }, uLight: { value: new THREE.Vector2(1, 0) } },
    vertexShader: /* glsl */ `
      in vec4 uvp;
      in vec4 data;
      out vec3 vUv;
      out float vShade;
      void main() {
        vUv = vec3(uvp.xy / 16.0, data.x);
        vShade = data.w / 255.0;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp sampler2DArray;
      uniform sampler2DArray atlas;
      uniform vec2 uLight;
      in vec3 vUv;
      in float vShade;
      ${LIGHTMAP}
      void main() {
        vec4 t = texture(atlas, vUv);
        if (t.a < 0.5) discard;
        gl_FragColor = vec4(t.rgb * vShade * lightmap(uLight.x, uLight.y), 1.0);
      }
    `,
    depthTest: true,
    depthWrite: true,
  });
}

/** Block-break particles: screen-aligned squares showing a 4x4 piece of the block's texture. */
export function particleMaterial(atlas: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...U, atlas: { value: atlas }, uScale: { value: 800 } },
    vertexShader: /* glsl */ `
      in vec4 pdata; // layer, u0, v0, size
      in vec2 plight;
      uniform float uScale;
      out vec3 vBase;
      out vec2 vLight;
      out float vDist;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        vDist = length(mv.xyz);
        gl_PointSize = max(1.0, pdata.w * uScale / max(0.05, -mv.z));
        vBase = pdata.xyz;
        vLight = plight;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp sampler2DArray;
      uniform sampler2DArray atlas;
      in vec3 vBase;
      in vec2 vLight;
      in float vDist;
      ${LIGHTMAP}
      ${FOG}
      void main() {
        vec2 uv = vBase.yz + gl_PointCoord * 0.25;
        vec4 t = textureLod(atlas, vec3(uv, vBase.x), 0.0);
        if (t.a < 0.5) discard;
        vec3 col = t.rgb * lightmap(vLight.x, vLight.y);
        gl_FragColor = vec4(applyFog(col, vDist), 1.0);
      }
    `,
  });
}

/** Clouds: flat-shaded white boxes, faded by fog. */
export function cloudMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...U, uCloudColor: { value: new THREE.Color(1, 1, 1) }, uCloudFar: { value: 300 } },
    vertexShader: /* glsl */ `
      in float shade;
      out float vShade;
      out float vDist;
      void main() {
        vShade = shade;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vDist = length(mv.xz);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uCloudColor;
      uniform vec3 uFogColor;
      uniform float uCloudFar;
      in float vShade;
      in float vDist;
      void main() {
        float f = smoothstep(uCloudFar * 0.55, uCloudFar, vDist);
        vec3 c = mix(uCloudColor * vShade, uFogColor, f);
        gl_FragColor = vec4(c, 0.8 * (1.0 - f));
      }
    `,
    transparent: true,
    depthWrite: true,
    side: THREE.FrontSide,
  });
}

/** Sky dome gradient with a sunrise/sunset glow toward the sun. */
export function skyMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uZenith: { value: new THREE.Color(0.47, 0.65, 1) },
      uHorizon: { value: new THREE.Color(0.75, 0.85, 1) },
      uVoid: { value: new THREE.Color(0.2, 0.25, 0.45) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uGlow: { value: new THREE.Color(1, 0.55, 0.25) },
      uGlowAmt: { value: 0 },
    },
    vertexShader: /* glsl */ `
      out vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uZenith;
      uniform vec3 uHorizon;
      uniform vec3 uVoid;
      uniform vec3 uSunDir;
      uniform vec3 uGlow;
      uniform float uGlowAmt;
      in vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 c = h > 0.0 ? mix(uHorizon, uZenith, smoothstep(0.0, 0.45, h)) : mix(uHorizon, uVoid, smoothstep(0.0, 0.25, -h));
        vec2 sd = normalize(uSunDir.xz + vec2(1e-5));
        float toward = max(0.0, dot(normalize(d.xz + vec2(1e-5)), sd));
        float band = exp(-abs(h - 0.05) * 7.0);
        c = mix(c, uGlow, clamp(uGlowAmt * band * pow(toward, 3.0), 0.0, 0.85));
        gl_FragColor = vec4(c, 1.0);
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
  });
}

/** World border: animated diagonal stripes, visible only when you are close. */
export function borderMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: U.uTime, uCam: { value: new THREE.Vector3() } },
    vertexShader: /* glsl */ `
      out vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uCam;
      in vec3 vWorld;
      void main() {
        float d = length(vWorld.xz - uCam.xz);
        float a = clamp(1.0 - d / 14.0, 0.0, 1.0);
        if (a <= 0.0) discard;
        float s = fract((vWorld.x + vWorld.z + vWorld.y) * 0.5 + uTime * 0.02);
        float stripe = step(0.5, s);
        if (stripe < 0.5) discard;
        gl_FragColor = vec4(0.13, 0.4, 1.0, a * 0.55);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}
