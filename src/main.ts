import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import './style.css';

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

// Placeholder bar/box with distinct X/Y/Z dimensions so orientation is unambiguous:
// width (X) = 1, height (Y) = 2, depth (Z) = 3
const box = new THREE.Mesh(
  new THREE.BoxGeometry(1, 2, 3),
  new THREE.MeshStandardMaterial({ color: 0x4a9eff, metalness: 0.1, roughness: 0.6 }),
);
box.position.y = 1; // sit on top of the grid
scene.add(box);

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

// Double-click/double-tap: zoom in on whatever point is under the cursor and
// re-center the orbit pivot there, like map-style double-click zoom.
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

type Tween = { fromPos: THREE.Vector3; toPos: THREE.Vector3; fromTarget: THREE.Vector3; toTarget: THREE.Vector3; start: number };
let tween: Tween | null = null;
const TWEEN_MS = 350;
const ZOOM_FACTOR = 0.5; // halve the distance to the clicked point each time

function pointerToNdc(clientX: number, clientY: number) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
}

function pickPoint(clientX: number, clientY: number): THREE.Vector3 | null {
  pointerToNdc(clientX, clientY);
  raycaster.setFromCamera(pointer, camera);

  const hit = raycaster.intersectObject(box)[0];
  if (hit) return hit.point;

  const groundHit = new THREE.Vector3();
  return raycaster.ray.intersectPlane(groundPlane, groundHit);
}

function zoomToPoint(clientX: number, clientY: number) {
  const point = pickPoint(clientX, clientY);
  if (!point) return;

  const offset = camera.position.clone().sub(point);
  const newDistance = Math.max(controls.minDistance, offset.length() * ZOOM_FACTOR);
  const toPos = point.clone().add(offset.normalize().multiplyScalar(newDistance));

  tween = {
    fromPos: camera.position.clone(),
    toPos,
    fromTarget: controls.target.clone(),
    toTarget: point.clone(),
    start: performance.now(),
  };
}

renderer.domElement.addEventListener('dblclick', (event) => {
  zoomToPoint(event.clientX, event.clientY);
});

// Mobile: synthesize double-tap since dblclick from touch is unreliable.
let lastTap = { time: 0, x: 0, y: 0 };
renderer.domElement.addEventListener('touchend', (event) => {
  if (event.changedTouches.length !== 1) return;
  const touch = event.changedTouches[0];
  const now = performance.now();
  const dx = touch.clientX - lastTap.x;
  const dy = touch.clientY - lastTap.y;
  if (now - lastTap.time < 300 && Math.hypot(dx, dy) < 30) {
    zoomToPoint(touch.clientX, touch.clientY);
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
