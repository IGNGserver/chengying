export const VERTEX_SHADER_GLSL = `#version 300 es
precision highp float;

in vec2 a_pos;
out vec2 v_uv;

void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 1.0 - (a_pos.y * 0.5 + 0.5));
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`

export const FRAGMENT_SHADER_GLSL = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_photo;
uniform sampler2D u_curveLut;
uniform vec2 u_texelSize;
uniform vec2 u_resolution;
uniform float u_time;

// Graded parameters
uniform float u_exposure;
uniform float u_temp;
uniform float u_tint;
uniform float u_contrast;
uniform float u_highlights;
uniform float u_shadows;
uniform float u_blacks;
uniform float u_vibrance;
uniform float u_saturation;
uniform float u_clarity;
uniform float u_dehaze;
uniform vec3 u_shadowTint;
uniform vec3 u_highlightTint;

// Ungraded baseline parameters (for split-curtain left side or hold-compare)
uniform vec4 u_rawBase; // x: ev, y: contrast, z: sat, w: temp

// Local Mask: x=kind (0 none, 1 ellipse, 2 gradient, 3 radial), y=cx, z=cy, w=feather
uniform vec4 u_maskGeomA;
// x=rx, y=ry, z=maskEv, w=maskTemp
uniform vec4 u_maskGeomB;

// Viewport tools
uniform float u_splitPos;      // 0..1 curtain x; < 0 disables split
uniform float u_compareHold;   // 1.0 = full ungraded original
uniform float u_showMask;      // 1.0 = show darktable amber mask overlay
uniform float u_showZebra;     // 1.0 = show highlight/shadow clipping zebra
uniform vec3 u_loupe;          // x=uv.x, y=uv.y, z=enabled (0 or 1)

vec3 srgbToLinear(vec3 c) {
  bvec3 cutoff = lessThanEqual(c, vec3(0.04045));
  vec3 higher = pow((c + vec3(0.055)) / vec3(1.055), vec3(2.4));
  vec3 lower = c / vec3(12.92);
  return mix(higher, lower, cutoff);
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, vec3(0.0));
  bvec3 cutoff = lessThanEqual(c, vec3(0.0031308));
  vec3 higher = vec3(1.055) * pow(c, vec3(1.0 / 2.4)) - vec3(0.055);
  vec3 lower = c * vec3(12.92);
  return clamp(mix(higher, lower, cutoff), 0.0, 1.0);
}

float luma709(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

float evalMask(vec2 uv) {
  int kind = int(u_maskGeomA.x + 0.5);
  if (kind == 0) return 0.0;
  vec2 center = u_maskGeomA.yz;
  float feather = max(0.02, u_maskGeomA.w);
  vec2 radii = max(vec2(0.03), u_maskGeomB.xy);

  if (kind == 1) {
    // Portrait faceBox / local ellipse
    vec2 d = (uv - center) / radii;
    float dist = length(d);
    return 1.0 - smoothstep(1.0 - feather, 1.0 + feather * 1.4, dist);
  } else if (kind == 2) {
    // Top-down linear sky gradient
    float span = max(0.06, radii.y + feather);
    return 1.0 - smoothstep(center.y - span * 0.5, center.y + span * 0.5, uv.y);
  } else {
    // Radial spotlight / vignette
    float aspect = u_resolution.x / max(1.0, u_resolution.y);
    vec2 d = uv - center;
    d.x *= aspect * 0.68;
    float dist = length(d) / max(0.08, radii.x * 1.6);
    return 1.0 - smoothstep(0.65, 1.0 + feather * 1.6, dist);
  }
}

vec3 gradeRawBaseline(vec3 srcSrgb) {
  vec3 lin = srgbToLinear(srcSrgb);
  lin *= exp2(u_rawBase.x);
  // Subtle cool sensor neutral shift
  float t = u_rawBase.w * 0.0045;
  lin.r *= (1.0 + t);
  lin.b *= (1.0 - t);
  vec3 s = linearToSrgb(lin);
  // Flatter log-like pre-grade contrast
  float c = 1.0 + u_rawBase.y * 0.008;
  s = (s - 0.5) * c + 0.5 + 0.015;
  float y = luma709(s);
  s = mix(vec3(y), s, 1.0 + u_rawBase.z * 0.01);
  return clamp(s, 0.0, 1.0);
}

vec3 gradeMaster(vec2 uv, vec3 srcSrgb, out float outMaskW) {
  vec3 lin = srgbToLinear(srcSrgb);
  outMaskW = evalMask(uv);

  // 1. Scene-referred linear exposure + local mask EV
  float totalEv = u_exposure + outMaskW * u_maskGeomB.z;
  lin *= exp2(totalEv);

  // 2. Linear white balance with >0.88 highlight neutral roll-off protection
  float yPre = luma709(lin);
  float hiGuard = 1.0 - smoothstep(0.82, 1.35, yPre);
  float temp = (u_temp + outMaskW * u_maskGeomB.w) * 0.0055 * hiGuard;
  float tint = u_tint * 0.0042 * hiGuard;
  lin.r *= (1.0 + temp + tint * 0.45);
  lin.g *= (1.0 - tint * 0.65);
  lin.b *= (1.0 - temp + tint * 0.35);

  // 3. Dehaze (dark-channel inspired atmospheric lift/recovery)
  if (abs(u_dehaze) > 0.2) {
    float dh = u_dehaze * 0.011;
    float minCh = min(min(lin.r, lin.g), lin.b);
    lin = max(vec3(0.0), (lin - minCh * dh * 0.55) / max(0.35, 1.0 - dh * 0.38));
  }

  // 4. Clarity (guided local micro-contrast in perceptual midtones)
  if (abs(u_clarity) > 0.3) {
    vec2 stepUv = u_texelSize * 3.2;
    vec3 blur = 0.25 * (
      srgbToLinear(texture(u_photo, clamp(uv + vec2(stepUv.x, 0.0), 0.0, 1.0)).rgb) +
      srgbToLinear(texture(u_photo, clamp(uv - vec2(stepUv.x, 0.0), 0.0, 1.0)).rgb) +
      srgbToLinear(texture(u_photo, clamp(uv + vec2(0.0, stepUv.y), 0.0, 1.0)).rgb) +
      srgbToLinear(texture(u_photo, clamp(uv - vec2(0.0, stepUv.y), 0.0, 1.0)).rgb)
    ) * exp2(totalEv);
    float midMask = 4.0 * clamp(yPre, 0.0, 1.0) * (1.0 - clamp(yPre, 0.0, 1.0));
    vec3 detail = tanh((lin - blur) * 3.0) * (u_clarity * 0.0065) * midMask;
    lin = max(vec3(0.0), lin + detail);
  }

  // 5. Soft-knee Sigmoid highlight roll-off, shadow lift & black point
  vec3 srgb = linearToSrgb(lin);
  float y = luma709(srgb);

  float shWeight = pow(1.0 - y, 2.1);
  float hiWeight = pow(y, 2.2);
  float deltaY = (u_shadows * 0.0028) * shWeight
               + (u_highlights * 0.0030) * hiWeight
               + (u_blacks * 0.0018) * pow(1.0 - y, 3.6);
  float targetY = clamp(y + deltaY, 0.0, 1.0);
  // Contrast around perceptual middle-grey 0.48
  float cSlope = 1.0 + u_contrast * 0.0075;
  targetY = clamp((targetY - 0.48) * cSlope + 0.48, 0.0, 1.0);

  vec3 ratio = srgb / max(y, 0.0008);
  srgb = clamp(mix(srgb + (targetY - y), ratio * targetY, 0.72), 0.0, 1.0);

  // 6. Split-toning (color_grading shadows & highlights)
  float yPost = luma709(srgb);
  srgb += u_shadowTint * pow(1.0 - yPost, 1.7) * (1.0 - yPost);
  srgb += u_highlightTint * pow(yPost, 1.6) * yPost;
  srgb = clamp(srgb, 0.0, 1.0);

  // 7. Vibrance with skin-hue protection (10°..50° warm orange damping) + global saturation
  float maxC = max(max(srgb.r, srgb.g), srgb.b);
  float minC = min(min(srgb.r, srgb.g), srgb.b);
  float satCurr = (maxC - minC) / max(maxC, 0.001);
  // Detect warm skin-tone dominance (R > G > B)
  float isSkin = smoothstep(0.02, 0.14, srgb.r - srgb.g) * smoothstep(0.01, 0.12, srgb.g - srgb.b);
  float vibBoost = (u_vibrance * 0.011) * (1.0 - satCurr * 0.75) * mix(1.0, 0.45, isSkin);
  float satScale = max(0.0, 1.0 + u_saturation * 0.01 + vibBoost);
  float yFinal = luma709(srgb);
  srgb = clamp(mix(vec3(yFinal), srgb, satScale), 0.0, 1.0);

  // 8. 256x1 RGBA Fritsch-Carlson Spline Curve LUT (R, G, B channels -> Master channel)
  float rLut = texture(u_curveLut, vec2(clamp(srgb.r, 0.002, 0.998), 0.5)).r;
  float gLut = texture(u_curveLut, vec2(clamp(srgb.g, 0.002, 0.998), 0.5)).g;
  float bLut = texture(u_curveLut, vec2(clamp(srgb.b, 0.002, 0.998), 0.5)).b;
  vec3 perCh = vec3(rLut, gLut, bLut);
  vec3 mastered = vec3(
    texture(u_curveLut, vec2(clamp(perCh.r, 0.002, 0.998), 0.5)).a,
    texture(u_curveLut, vec2(clamp(perCh.g, 0.002, 0.998), 0.5)).a,
    texture(u_curveLut, vec2(clamp(perCh.b, 0.002, 0.998), 0.5)).a
  );

  return clamp(mastered, 0.0, 1.0);
}

void main() {
  vec2 sampleUv = v_uv;
  bool inLoupe = false;
  float loupeRing = 0.0;

  if (u_loupe.z > 0.5) {
    float aspect = u_resolution.x / max(1.0, u_resolution.y);
    vec2 delta = v_uv - u_loupe.xy;
    delta.x *= aspect;
    float dist = length(delta);
    float radius = 0.145;
    if (dist < radius) {
      inLoupe = true;
      vec2 zoomDelta = (v_uv - u_loupe.xy) / 2.35;
      sampleUv = clamp(u_loupe.xy + zoomDelta, 0.002, 0.998);
      loupeRing = smoothstep(radius - 0.0045, radius - 0.001, dist);
    }
  }

  // Subtle optical refraction right along split curtain
  float curtainDist = v_uv.x - u_splitPos;
  if (u_splitPos >= 0.0 && abs(curtainDist) < 0.004 && !inLoupe) {
    sampleUv.x += sin(curtainDist * 780.0) * 0.0012;
  }

  vec3 texSrc = texture(u_photo, sampleUv).rgb;
  vec3 rawCol = gradeRawBaseline(texSrc);
  float maskW = 0.0;
  vec3 gradedCol = gradeMaster(sampleUv, texSrc, maskW);

  vec3 color = gradedCol;
  if (u_compareHold > 0.5) {
    color = rawCol;
  } else if (u_splitPos >= 0.0) {
    float edgeSoft = 1.5 / max(320.0, u_resolution.x);
    float side = smoothstep(u_splitPos - edgeSoft, u_splitPos + edgeSoft, v_uv.x);
    color = mix(rawCol, gradedCol, side);
  }

  // Darktable-style amber/gold mask density visualization
  if (u_showMask > 0.5 && maskW > 0.01) {
    float stripe = 0.5 + 0.5 * sin((v_uv.x * u_resolution.x + v_uv.y * u_resolution.y) * 0.24 - u_time * 3.0);
    vec3 maskTint = mix(vec3(0.92, 0.64, 0.22), vec3(0.98, 0.82, 0.34), stripe * 0.35);
    color = mix(color, maskTint, maskW * 0.52);
    float contour = smoothstep(0.47, 0.50, maskW) * (1.0 - smoothstep(0.50, 0.53, maskW));
    color = mix(color, vec3(1.0, 0.88, 0.45), contour * 0.85);
  }

  // Highlight / Shadow clipping Zebra overlay (5 Veto Red Lines check)
  if (u_showZebra > 0.5) {
    float yCheck = luma709(color);
    float diag = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) * 0.09 - u_time * 1.4));
    if (yCheck > 0.975 || max(max(color.r, color.g), color.b) > 0.992) {
      color = mix(color, vec3(0.94, 0.24, 0.22), 0.65 * diag + 0.25);
    } else if (yCheck < 0.016) {
      color = mix(color, vec3(0.24, 0.54, 0.96), 0.65 * diag + 0.25);
    }
  }

  if (inLoupe) {
    color = mix(color, vec3(0.88, 0.72, 0.46), loupeRing * 0.92);
  }

  outColor = vec4(color, 1.0);
}
`
