/**
 * Curated parameter hints for RawTherapee. The pp3 dump gives every key and
 * its default but not GUI ranges or the allowed values of string enums; these
 * hints (from RawTherapee's GUI adjusters, 5.9–5.13) refine the generated
 * schema. Keys without hints remain fully usable with inferred types; RT
 * clamps out-of-range numbers itself.
 */
export interface Hint { min?: number; max?: number; enum?: string[]; description?: string; unit?: string }

const R = (min: number, max: number, description?: string, unit?: string): Hint => ({ min, max, ...(description ? { description } : {}), ...(unit ? { unit } : {}) })
const E = (values: string[], description?: string): Hint => ({ enum: values, ...(description ? { description } : {}) })
const CURVE_MODES = ['Standard', 'FilmLike', 'SatAndValueBlending', 'WeightedStd', 'Luminance', 'Perceptual']

export const RT_HINTS: Record<string, Hint> = {
  'Exposure.Compensation': R(-5, 12, 'exposure compensation', 'EV'),
  'Exposure.Brightness': R(-100, 100), 'Exposure.Contrast': R(-100, 100), 'Exposure.Saturation': R(-100, 100),
  'Exposure.Black': R(-16384, 32768), 'Exposure.HighlightCompr': R(0, 500), 'Exposure.HighlightComprThreshold': R(0, 100),
  'Exposure.ShadowCompr': R(0, 100), 'Exposure.Clip': R(0, 0.99), 'Exposure.CurveMode': E(CURVE_MODES), 'Exposure.CurveMode2': E(CURVE_MODES),
  'Exposure.Curve': { description: 'tone curve 1: "type;x;y;…;" (0 linear, 1 spline, 2 parametric, 3 NURBS, 4 flexible); or pass {"type":1,"points":[[x,y],…]}' },
  'Exposure.Curve2': { description: 'tone curve 2 (same format as Curve)' },
  'HLRecovery.Method': E(['Luminance', 'CIELab blending', 'Color', 'Blend', 'Coloropp'], 'highlight reconstruction method'),
  'HLRecovery.Hlbl': R(0, 4), 'HLRecovery.Hlth': R(0.25, 1.75),
  'White Balance.Setting': E(['Camera', 'autitcgreen', 'autold', 'Custom', 'Daylight', 'Cloudy', 'Shade', 'Water 1', 'Water 2', 'Tungsten', 'Fluo F1', 'Fluo F2', 'Fluo F3', 'Fluo F4', 'Fluo F5', 'Fluo F6', 'Fluo F7', 'Fluo F8', 'Fluo F9', 'Fluo F10', 'Fluo F11', 'Fluo F12', 'HMI Lamp', 'GTI Lamp', 'JudgeIII Lamp', 'Solux Lamp 3500K', 'Solux Lamp 4100K', 'Solux Lamp 4700K', 'NG Solux Lamp 4700K', 'LED LSI Lumelex 2040', 'LED CRS SP12 WWMR16', 'Flash Standard', 'Flash Canon Speedlite 430EX', 'Flash Nikon SB-600', 'Flash Nikon SB-800'], 'white balance mode (Custom to use Temperature/Green)'),
  'White Balance.Temperature': R(1500, 60000, 'colour temperature', 'K'), 'White Balance.Green': R(0.02, 10, 'tint'), 'White Balance.Equal': R(0.8, 1.5, 'blue/red equalizer'),
  'White Balance.TemperatureBias': R(-0.5, 0.5),
  'Sharpening.Method': E(['usm', 'rld'], 'unsharp mask or RL deconvolution'), 'Sharpening.Radius': R(0.3, 3), 'Sharpening.Amount': R(1, 1000),
  'Sharpening.Contrast': R(0, 200, 'contrast threshold'), 'Sharpening.BlurRadius': R(0.2, 2), 'Sharpening.DeconvRadius': R(0.4, 2.5), 'Sharpening.DeconvAmount': R(0, 100),
  'Sharpening.DeconvDamping': R(0, 100), 'Sharpening.DeconvIterations': R(5, 100), 'Sharpening.HalocontrolAmount': R(0, 100),
  'Vibrance.Pastels': R(-100, 100), 'Vibrance.Saturated': R(-100, 100),
  'Local Contrast.Radius': R(20, 1024), 'Local Contrast.Amount': R(0, 1), 'Local Contrast.Darkness': R(0, 3), 'Local Contrast.Lightness': R(0, 3),
  'Shadows & Highlights.Highlights': R(0, 100), 'Shadows & Highlights.HighlightTonalWidth': R(10, 100), 'Shadows & Highlights.Shadows': R(0, 100),
  'Shadows & Highlights.ShadowTonalWidth': R(10, 100), 'Shadows & Highlights.Radius': R(5, 100),
  'Dehaze.Strength': R(-100, 100), 'Dehaze.Depth': R(0, 100), 'Dehaze.Saturation': R(0, 100),
  'Directional Pyramid Denoising.Luma': R(0, 100), 'Directional Pyramid Denoising.Ldetail': R(0, 100), 'Directional Pyramid Denoising.Chroma': R(0, 100),
  'Directional Pyramid Denoising.Redchro': R(-100, 100), 'Directional Pyramid Denoising.Bluechro': R(-100, 100), 'Directional Pyramid Denoising.Gamma': R(1, 3),
  'Directional Pyramid Denoising.Passes': R(1, 3), 'Directional Pyramid Denoising.Method': E(['Lab', 'RGB']),
  'Impulse Denoising.Threshold': R(0, 100), 'Defringing.Radius': R(0.5, 5), 'Defringing.Threshold': R(0, 100),
  'Crop.Ratio': E(['As Image', '3:2', '4:3', '16:9', '16:10', '1:1', '2:1', '3:1', '4:1', '5:4', '5:7', '6:7', '7:5', '8.5:11', 'DIN', 'Square', '65:24', '1.85:1', '2.35:1'], 'aspect ratio when FixedRatio'),
  'Crop.Orientation': E(['As Image', 'Landscape', 'Portrait']), 'Crop.X': { description: 'left (px)' }, 'Crop.Y': { description: 'top (px)' }, 'Crop.W': { description: 'width (px)' }, 'Crop.H': { description: 'height (px)' },
  'Rotation.Degree': R(-45, 45, 'straighten', 'deg'),
  'Perspective.Method': E(['simple', 'camera_based']), 'Perspective.Horizontal': R(-100, 100), 'Perspective.Vertical': R(-100, 100),
  'Vignetting Correction.Amount': R(-100, 100), 'Vignetting Correction.Radius': R(0, 100), 'Vignetting Correction.Strength': R(1, 100),
  'Vignetting Correction.CenterX': R(-100, 100), 'Vignetting Correction.CenterY': R(-100, 100),
  'PCVignette.Strength': R(-6, 6, 'post-crop vignette strength', 'EV'), 'PCVignette.Feather': R(0, 100), 'PCVignette.Roundness': R(0, 100),
  'Gradient.Degree': R(-180, 180), 'Gradient.Feather': R(0, 100), 'Gradient.Strength': R(-5, 5, 'graduated filter strength', 'EV'), 'Gradient.CenterX': R(-100, 100), 'Gradient.CenterY': R(-100, 100),
  'Resize.Method': E(['Nearest', 'Bilinear', 'Bicubic', 'Bicubic (Softer)', 'Bicubic (Sharper)', 'Lanczos']), 'Resize.AppliesTo': E(['Full image', 'Cropped area']),
  'Resize.DataSpecified': { description: '0 scale, 1 width, 2 height, 3 bounding box, 4 long edge, 5 short edge' },
  'Color Management.OutputProfileIntent': E(['Perceptual', 'Relative', 'Saturation', 'Absolute']),
  'Film Simulation.Strength': R(0, 100), 'Film Simulation.ClutFilename': { description: 'HaldCLUT image (must be readable)' },
  'ToneEqualizer.Band0': R(-100, 100), 'ToneEqualizer.Band1': R(-100, 100), 'ToneEqualizer.Band2': R(-100, 100), 'ToneEqualizer.Band3': R(-100, 100), 'ToneEqualizer.Band4': R(-100, 100),
  'ToneEqualizer.Regularization': R(-5, 5), 'SoftLight.Strength': R(0, 100), 'EPD.Strength': R(-1, 2), 'EPD.EdgeStopping': R(0.1, 4), 'EPD.Scale': R(0.1, 10),
  'FattalToneMapping.Threshold': R(-100, 100), 'FattalToneMapping.Amount': R(1, 100), 'FattalToneMapping.Anchor': R(1, 100),
  'Locallab.Shape': E(['ELI', 'RECT'], 'spot shape: ellipse or rectangle'), 'Locallab.SpotMethod': E(['norm', 'exc', 'full', 'main'], 'normal, excluding, full image, global'),
  'Locallab.CenterX': R(-1000, 1000, 'spot center x (−1000 left … 1000 right)'), 'Locallab.CenterY': R(-1000, 1000, 'spot center y (−1000 top … 1000 bottom)'),
  'Locallab.Loc': { description: 'spot extents "right;left;top;bottom;" in 0..3000 (per-mille of half the image)' },
  'Locallab.Transit': R(2, 100, 'transition (feather) %'), 'Locallab.Feather': R(10, 100), 'Locallab.Colorscope': R(0, 100, 'colour scope (ΔE sensitivity)'),
}

export function hintFor(section: string, key: string): Hint | undefined {
  return RT_HINTS[`${section}.${key}`]
}
