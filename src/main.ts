import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import './style.css';

// Invert vertical orbit rotation (mouse-drag and two-finger touch both route
// through this method) while leaving horizontal rotation untouched.
const orbitControlsProto = OrbitControls.prototype as unknown as { _rotateUp: (angle: number) => void };
const originalRotateUp = orbitControlsProto._rotateUp;
orbitControlsProto._rotateUp = function (this: OrbitControls, angle: number) {
  originalRotateUp.call(this, -angle);
};

const app = document.querySelector<HTMLDivElement>('#app')!;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a1a);

const camera = new THREE.PerspectiveCamera(
  50,
  window.innerWidth / window.innerHeight,
  0.1,
  1000,
);
camera.position.set(4, 3, 5);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
app.appendChild(renderer.domElement);

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
// middle = pan, right = rotate, wheel = zoom.
// Touch: one finger = pan, two fingers = pinch-to-zoom + two-finger-drag-to-rotate.
const controls = new OrbitControls(camera, renderer.domElement);
controls.mouseButtons = {
  LEFT: null,
  MIDDLE: THREE.MOUSE.PAN,
  RIGHT: THREE.MOUSE.ROTATE,
};
controls.touches = {
  ONE: THREE.TOUCH.PAN,
  TWO: THREE.TOUCH.DOLLY_ROTATE,
};
controls.enableDamping = false;
controls.minDistance = 0.5;
controls.maxDistance = 50;
controls.target.set(0, 1, 0);
controls.update();

// Double-click/double-tap: zoom to fit the bounding box of all content.
type Tween = { fromPos: THREE.Vector3; toPos: THREE.Vector3; fromTarget: THREE.Vector3; toTarget: THREE.Vector3; start: number };
let tween: Tween | null = null;
const TWEEN_MS = 400;
const FIT_PADDING = 1.2;

function zoomToFit() {
  const box3 = new THREE.Box3().setFromObject(content);
  if (box3.isEmpty()) return;

  const center = box3.getCenter(new THREE.Vector3());
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

function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
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

  controls.update();
  renderer.render(scene, camera);
}
animate();
