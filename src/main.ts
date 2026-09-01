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
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 1, 0);
controls.update();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();
