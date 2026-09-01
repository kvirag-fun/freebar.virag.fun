import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import './style.css';

const viewport = document.querySelector<HTMLElement>('#viewport')!;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a1a);

const camera = new THREE.PerspectiveCamera(
  50,
  viewport.clientWidth / viewport.clientHeight,
  0.1,
  1000,
);
camera.position.set(4, 3, 5);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(viewport.clientWidth, viewport.clientHeight);
renderer.setPixelRatio(window.devicePixelRatio);
viewport.appendChild(renderer.domElement);

// Build-time stamp so a redeploy can be confirmed by eye: this should change
// on every commit once the workflow rebuilds. Remove once real UI (header/
// footer controls) makes a version indicator redundant.
const buildStamp = document.createElement('div');
buildStamp.id = 'build-stamp';
buildStamp.textContent = `build ${new Date(__BUILD_TIME__).toLocaleString()}`;
viewport.appendChild(buildStamp);

// Lighting
scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
keyLight.position.set(5, 8, 6);
scene.add(keyLight);

// Ground grid for spatial reference
const grid = new THREE.GridHelper(10, 10, 0x444444, 0x2a2a2a);
scene.add(grid);

// Axes helper: red = X, green = Y, blue = Z
scene.add(new THREE.AxesHelper(3));

// Actual scene content (as opposed to helpers like the grid/axes above) lives
// in this group, so "zoom to fit" can frame it without including the grid.
const content = new THREE.Group();
scene.add(content);

// Placeholder bar/box with distinct X/Y/Z dimensions so orientation is unambiguous:
// width (X) = 1, height (Y) = 2, depth (Z) = 3
const box = new THREE.Mesh(
  new THREE.BoxGeometry(1, 2, 3),
  new THREE.MeshStandardMaterial({ color: 0x4a9eff, metalness: 0.1, roughness: 0.6 }),
);
box.position.y = 1; // sit on top of the grid
content.add(box);

// Camera controls: left = none (reserved for future selection/manipulation),
// middle = pan, right = rotate (handled entirely by our own code below, see
// "Custom rotation" — enableRotate is off so OrbitControls never touches it),
// wheel = zoom.
// Touch: one finger = pan, two fingers = pinch-to-zoom (still OrbitControls,
// via enableZoom) + two-finger-drag-to-rotate (also custom, below).
const controls = new OrbitControls(camera, renderer.domElement);
controls.mouseButtons = {
  LEFT: null,
  MIDDLE: THREE.MOUSE.PAN,
  RIGHT: null,
};
controls.touches = {
  ONE: THREE.TOUCH.PAN,
  TWO: THREE.TOUCH.DOLLY_ROTATE,
};
controls.enableRotate = false;
controls.enableDamping = false;
controls.minDistance = 0.5;
controls.maxDistance = 50;
controls.target.set(0, 1, 0);
controls.update();

// Pivot indicator: a 3D crosshair shown at the rotation pivot only when the
// gesture actually started on real content (not the bounding-box fallback).
// Its three arms stay parallel to the world X/Y/Z axes (matching the
// AxesHelper's red/green/blue convention) rather than billboarding toward
// the camera — it's a point in space, not a screen-facing icon. It scales
// with camera distance so it reads as a roughly constant on-screen size.
function axisRod(length: number, thickness: number, axis: 0 | 1 | 2, color: number) {
  const size: [number, number, number] = [thickness, thickness, thickness];
  size[axis] = length;
  const rod = new THREE.Mesh(
    new THREE.BoxGeometry(...size),
    new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true }),
  );
  rod.renderOrder = 999;
  return rod;
}

const pivotIndicator = new THREE.Group();
pivotIndicator.add(
  axisRod(2, 0.08, 0, 0xff4444),
  axisRod(2, 0.08, 1, 0x44dd44),
  axisRod(2, 0.08, 2, 0x4488ff),
);
pivotIndicator.visible = false;
scene.add(pivotIndicator);
const PIVOT_INDICATOR_SCALE = 0.035; // fraction of camera distance

function contentBoundsCenter(): THREE.Vector3 | null {
  const box3 = new THREE.Box3().setFromObject(content);
  return box3.isEmpty() ? null : box3.getCenter(new THREE.Vector3());
}

// Double-click/double-tap: zoom to fit the bounding box of all content.
type Tween = { fromPos: THREE.Vector3; toPos: THREE.Vector3; fromTarget: THREE.Vector3; toTarget: THREE.Vector3; start: number };
let tween: Tween | null = null;
const TWEEN_MS = 400;
const FIT_PADDING = 1.2;

function zoomToFit() {
  const center = contentBoundsCenter();
  if (!center) return;

  const box3 = new THREE.Box3().setFromObject(content);
  const sphere = box3.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, 0.001);

  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const distance = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * FIT_PADDING;

  const direction = camera.position.clone().sub(controls.target);
  if (direction.lengthSq() < 1e-6) direction.set(0, 0, 1);
  direction.normalize();

  tween = {
    fromPos: camera.position.clone(),
    toPos: center.clone().add(direction.multiplyScalar(distance)),
    fromTarget: controls.target.clone(),
    toTarget: center.clone(),
    start: performance.now(),
  };
}

renderer.domElement.addEventListener('dblclick', () => zoomToFit());

// Mobile: synthesize double-tap since dblclick from touch is unreliable.
let lastTap = { time: 0, x: 0, y: 0 };
renderer.domElement.addEventListener('touchend', (event) => {
  if (event.changedTouches.length !== 1) return;
  const touch = event.changedTouches[0];
  const now = performance.now();
  const dx = touch.clientX - lastTap.x;
  const dy = touch.clientY - lastTap.y;
  if (now - lastTap.time < 300 && Math.hypot(dx, dy) < 30) {
    zoomToFit();
    lastTap = { time: 0, x: 0, y: 0 };
  } else {
    lastTap = { time: now, x: touch.clientX, y: touch.clientY };
  }
});

// Custom rotation: orbiting a point that isn't dead-center of the view is
// fundamentally incompatible with OrbitControls, which always forces
// `camera.lookAt(target)` — the instant `target` becomes an off-center point,
// that lookAt snaps the view to recenter on it. So rotation is implemented
// here instead: at gesture start, pick a pivot (raycast into `content`, or
// the content bounding-box center if nothing's hit), then on every move,
// rotate the camera's position *and* orientation together, rigidly, around
// that pivot. Since both move by the same incremental rotation, the pivot
// point stays visually fixed wherever it was on screen when the drag began —
// everything else swings around it — instead of snapping to center.
//
// controls.target is kept re-projected onto the camera's new forward axis
// (at whatever distance it already was) after every step, purely so
// OrbitControls' own pan/zoom stay internally consistent (it always assumes
// target sits dead ahead) and don't jump the next time they're used.
const raycaster = new THREE.Raycaster();
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const ROTATE_SPEED = 0.5;
const POLE_EPS = THREE.MathUtils.degToRad(2);

function pickPivot(clientX: number, clientY: number): { point: THREE.Vector3; hit: boolean } {
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, camera);

  const hit = raycaster.intersectObject(content, true)[0];
  if (hit) return { point: hit.point.clone(), hit: true };
  return { point: contentBoundsCenter() ?? controls.target.clone(), hit: false };
}

const orbit = { active: false, pivot: new THREE.Vector3(), lastX: 0, lastY: 0 };

function beginOrbit(clientX: number, clientY: number) {
  tween = null; // a fresh user gesture always wins over an in-flight zoom-to-fit
  orbit.active = true;
  const { point, hit } = pickPivot(clientX, clientY);
  orbit.pivot.copy(point);
  orbit.lastX = clientX;
  orbit.lastY = clientY;

  pivotIndicator.visible = hit;
  if (hit) pivotIndicator.position.copy(point);
  setCursor('rotate');
}

function stepOrbit(clientX: number, clientY: number) {
  if (!orbit.active) return;
  const dx = clientX - orbit.lastX;
  const dy = clientY - orbit.lastY;
  orbit.lastX = clientX;
  orbit.lastY = clientY;
  if (dx === 0 && dy === 0) return;

  const distanceToTarget = camera.position.distanceTo(controls.target);

  const h = viewport.clientHeight;
  const deltaTheta = ((2 * Math.PI * dx) / h) * ROTATE_SPEED;
  const deltaPhi = ((2 * Math.PI * dy) / h) * ROTATE_SPEED;

  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
  const qYaw = new THREE.Quaternion().setFromAxisAngle(WORLD_UP, deltaTheta);
  const qPitch = new THREE.Quaternion().setFromAxisAngle(right, deltaPhi);

  // Rotating around world-up (yaw) never changes the camera's angle to
  // world-up, so it's always safe. Pitch can push the camera's forward
  // vector nearly parallel to world-up — exactly where camera.up (fixed at
  // world-up) makes the lookAt() inside OrbitControls.update() degenerate,
  // which is what caused the 180° snap when rotating all the way to the top
  // or bottom. So: reject the pitch component for this step if it would
  // cross too close to either pole; the yaw component still applies.
  const qYawPitch = qYaw.clone().multiply(qPitch);
  const tentativeForward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion.clone().premultiply(qYawPitch));
  const angleToUp = tentativeForward.angleTo(WORLD_UP);
  const pitchAllowed = angleToUp > POLE_EPS && angleToUp < Math.PI - POLE_EPS;
  const qDelta = pitchAllowed ? qYawPitch : qYaw;

  const offset = camera.position.clone().sub(orbit.pivot).applyQuaternion(qDelta);
  camera.position.copy(orbit.pivot).add(offset);
  camera.quaternion.premultiply(qDelta);
  camera.updateMatrixWorld();

  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  controls.target.copy(camera.position).addScaledVector(forward, distanceToTarget);
}

function endOrbit() {
  orbit.active = false;
  pivotIndicator.visible = false;
  setCursor('idle');
}

// Cursor reflects the active action: crosshair idle, a custom pan icon while
// middle-drag/one-finger-drag is panning, a custom rotate icon while
// right-drag/two-finger-drag is rotating.
function setCursor(mode: 'idle' | 'pan' | 'rotate') {
  if (mode === 'pan') renderer.domElement.style.cursor = "url('/cursor-pan.svg') 14 14, move";
  else if (mode === 'rotate') renderer.domElement.style.cursor = "url('/cursor-rotate.svg') 16 16, grab";
  else renderer.domElement.style.cursor = '';
}

// Pointer events unify mouse/touch/pen, but two-finger touch rotation is
// handled separately below (it needs the midpoint of both fingers, not a
// single pointer's position) — so these only ever act on the mouse.
renderer.domElement.addEventListener('pointerdown', (event) => {
  if (event.pointerType !== 'mouse') return;
  if (event.button === 2) {
    event.preventDefault();
    renderer.domElement.setPointerCapture(event.pointerId);
    beginOrbit(event.clientX, event.clientY);
  } else if (event.button === 1) {
    setCursor('pan');
  }
});
renderer.domElement.addEventListener('pointermove', (event) => {
  if (event.pointerType !== 'mouse') return;
  stepOrbit(event.clientX, event.clientY);
});
renderer.domElement.addEventListener('pointerup', (event) => {
  if (event.pointerType !== 'mouse') return;
  if (event.button === 2) endOrbit();
  else if (event.button === 1) setCursor('idle');
});

renderer.domElement.addEventListener('touchstart', (event) => {
  tween = null;
  if (event.touches.length !== 2) {
    endOrbit();
    return;
  }
  const [t1, t2] = event.touches;
  beginOrbit((t1.clientX + t2.clientX) / 2, (t1.clientY + t2.clientY) / 2);
});
renderer.domElement.addEventListener('touchmove', (event) => {
  if (event.touches.length !== 2) return;
  const [t1, t2] = event.touches;
  stepOrbit((t1.clientX + t2.clientX) / 2, (t1.clientY + t2.clientY) / 2);
});
renderer.domElement.addEventListener('touchend', () => endOrbit());
renderer.domElement.addEventListener('touchcancel', () => endOrbit());

function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

window.addEventListener('resize', () => {
  camera.aspect = viewport.clientWidth / viewport.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(viewport.clientWidth, viewport.clientHeight);
});

function animate() {
  requestAnimationFrame(animate);

  if (tween) {
    const t = Math.min(1, (performance.now() - tween.start) / TWEEN_MS);
    const e = easeOutCubic(t);
    camera.position.lerpVectors(tween.fromPos, tween.toPos, e);
    controls.target.lerpVectors(tween.fromTarget, tween.toTarget, e);
    if (t === 1) tween = null;
  }

  if (pivotIndicator.visible) {
    const scale = camera.position.distanceTo(pivotIndicator.position) * PIVOT_INDICATOR_SCALE;
    pivotIndicator.scale.setScalar(scale);
  }

  controls.update();
  renderer.render(scene, camera);
}
animate();
