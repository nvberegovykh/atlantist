/**
 * Postprocessing pipeline — bolt-on, does not replace existing renderers.
 * Exports initPostProcessing(renderer, scene, camera) → pipeline object.
 * EffectComposer + OutlinePass + SSAOPass + UnrealBloomPass + OutputPass.
 * RP-1/RP-3 render modes activate these passes; default 3D mode runs plain.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }     from 'three/addons/postprocessing/RenderPass.js';
import { OutlinePass }    from 'three/addons/postprocessing/OutlinePass.js';
import { SSAOPass }      from 'three/addons/postprocessing/SSAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass }    from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass }    from 'three/addons/postprocessing/OutputPass.js';

// ─── Per-viewport pipeline registry ──────────────────────────────────────────
const _pipelines = new Map(); // canvasId → { composer, outlinePass, ssaoPass, bloomPass }

// ─── Build a pipeline for a given renderer/scene/camera ──────────────────────
function buildPipeline(renderer, scene, camera) {
  const composer = new EffectComposer(renderer);

  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  // SSAOPass — screen-space ambient occlusion for architectural depth
  // RP-3: Subtle occlusion — don't overpower scene lighting
  const ssaoPass = new SSAOPass(scene, camera, renderer.domElement.clientWidth, renderer.domElement.clientHeight);
  ssaoPass.radius = 4;
  ssaoPass.minDistance = 0.001;
  ssaoPass.maxDistance = 0.1;
  ssaoPass.outsideKernelRadius = 16; // disable noise halos at silhouettes
  ssaoPass.outsideHeuristicOffset = 0.5;
  composer.addPass(ssaoPass);

  // OutlinePass — selection highlight for RP-1/RP-3 modes
  const outlinePass = new OutlinePass(
    renderer.domElement.clientWidth,
    renderer.domElement.clientHeight,
    scene,
    camera
  );
  outlinePass.edgeStrength = 3.0;
  outlinePass.edgeGlow = 0.5;
  outlinePass.edgeThickness = 1.0;
  outlinePass.pulsePeriod = 0;
  outlinePass.visibleEdgeColor.set('#3479c4');
  outlinePass.hiddenEdgeColor.set('#1d5fa6');
  composer.addPass(outlinePass);

  // UnrealBloomPass — HDR glow for render quality
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(renderer.domElement.clientWidth, renderer.domElement.clientHeight),
    0.4,   // strength
    0.4,   // radius
    0.85   // threshold
  );
  composer.addPass(bloomPass);

  // OutputPass — tone mapping / color space correct output
  const outputPass = new OutputPass();
  composer.addPass(outputPass);

  return { composer, renderPass, ssaoPass, outlinePass, bloomPass, outputPass };
}

// ─── Init postprocessing for a canvas ID ─────────────────────────────────────
export function initPostProcessing(canvasId, renderer, scene, camera) {
  if (_pipelines.has(canvasId)) return _pipelines.get(canvasId);
  const pipeline = buildPipeline(renderer, scene, camera);
  _pipelines.set(canvasId, pipeline);
  return pipeline;
}

// ─── Set outline targets (selected elements) ─────────────────────────────────
export function setOutlineTargets(canvasId, objects) {
  const p = _pipelines.get(canvasId);
  if (!p) return;
  p.outlinePass.selectedObjects = objects || [];
}

// ─── Enable/disable a pass by name ───────────────────────────────────────────
export function setPassEnabled(canvasId, passName, enabled) {
  const p = _pipelines.get(canvasId);
  if (!p) return;
  const pass = p[passName + 'Pass'];
  if (pass) pass.enabled = enabled;
}

// ─── Expose pipeline for external render loop integration ─────────────────────
export function renderWithPipeline(canvasId) {
  const p = _pipelines.get(canvasId);
  if (p?.composer) {
    p.composer.render();
    return true;
  }
  return false;
}

// ─── Render pipeline sizes (called on VP resize) ──────────────────────────────
export function resizePipelines(width, height) {
  for (const [, p] of _pipelines) {
    p.composer.setSize(width, height);
    p.ssaoPass.setSize(width, height);
    p.bloomPass.resolution.set(width, height);
  }
}

// ─── Debug: list active pipelines ─────────────────────────────────────────────
window.__atlPostFX = {
  init: initPostProcessing,
  setOutlineTargets,
  setPass: setPassEnabled,
  render: renderWithPipeline,
  resize: resizePipelines,
  pipelines: () => [..._pipelines.keys()],
};

export { buildPipeline };