import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import './style.css';

const viewport = document.querySelector<HTMLElement>('#viewport')!;
const panesEl = document.querySelector<HTMLElement>('#panes')!;
const splitViewBtn = document.querySelector<HTMLButtonElement>('#split-view-btn')!;
const navCubeBtn = document.querySelector<HTMLButtonElement>('#nav-cube-btn')!;
const axisGizmoBtn = document.querySelector<HTMLButtonElement>('#axis-gizmo-btn')!;
const clipPlaneBtn = document.querySelector<HTMLButtonElement>('#clip-plane-btn')!;
const clipPlaneDialog = document.querySelector<HTMLElement>('#clip-plane-dialog')!;
const clipPlaneCloseBtn = document.querySelector<HTMLButtonElement>('#clip-plane-close-btn')!;
const clipPlaneList = document.querySelector<HTMLElement>('#clip-plane-list')!;
const clipPlaneEmpty = document.querySelector<HTMLElement>('#clip-plane-empty')!;
const clipPlaneAddBtn = document.querySelector<HTMLButtonElement>('#clip-plane-add-btn')!;
const clipPlaneBanner = document.querySelector<HTMLElement>('#clip-plane-banner')!;
const clipPlaneCancelBtn = document.querySelector<HTMLButtonElement>('#clip-plane-cancel-btn')!;

// Shared across every pane, so one button hides/shows the cube/axes everywhere at once.
// The nav cube cycles full -> mini -> off -> full: "mini" renders small and
// schematic, expanding to full size/detail on hover (see createPane).
type NavCubeMode = 'full' | 'mini' | 'off';
let navCubeMode: NavCubeMode = 'full';
let axisGizmoVisible = true;

// Cutting planes: a named list the user manages from the header dialog, but
// only one clips the model at a time (see applyActiveClipPlane). Each plane
// is a point + unit normal — the plane keeps the half-space the normal points
// into and clips away the other side, matching THREE.Plane's own convention.
type ClipPlaneDef = { id: string; name: string; point: THREE.Vector3; normal: THREE.Vector3 };
let clipPlanes: ClipPlaneDef[] = [];
let activeClipPlaneId: string | null = null;
let nextClipPlaneNumber = 1;
// True while waiting for the user to click a point on the model to place a
// new plane (triggered by the dialog's "+ Add plane" button) — see the
// pointerdown handling in createPane and addClipPlane below.
let placementModeActive = false;
// Mutated in place from the active ClipPlaneDef rather than replaced, so every
// pane's renderer.clippingPlanes array (set in step()) can reference this same
// object without needing to be reassigned when the active plane changes.
const sharedClipPlane = new THREE.Plane();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a1a);

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

// World axes helper, colored per this project's direction convention (see
// axisArrow below): world Z reads as "X"/red, world X as "Y"/green, world Y
// (up) as "Z"/blue. THREE.AxesHelper bakes in the opposite (literal X=red/
// Y=green/Z=blue) convention, so this is a small hand-built equivalent instead.
scene.add(worldAxesHelper(3));

// Actual scene content (as opposed to helpers like the grid/axes above) lives
// in this group, so "zoom to fit" can frame it without including the grid.
const content = new THREE.Group();
scene.add(content);

// Placeholder bar/box with distinct dimensions along every axis so orientation
// is unambiguous: width (world X, shown as "Y") = 1, height (world Y/up,
// shown as "Z") = 2, depth (world Z, shown as "X") = 3
const box = new THREE.Mesh(
  new THREE.BoxGeometry(1, 2, 3),
  // Double-sided so a cutting plane (see applyActiveClipPlane) exposes a
  // solid-looking interior wall at the cut instead of culling those
  // newly-visible back faces and showing gaps through to whatever's behind.
  new THREE.MeshStandardMaterial({ color: 0x4a9eff, metalness: 0.1, roughness: 0.6, side: THREE.DoubleSide }),
);
box.position.y = 1; // sit on top of the grid
content.add(box);

function contentBoundsCenter(): THREE.Vector3 | null {
  const box3 = new THREE.Box3().setFromObject(content);
  return box3.isEmpty() ? null : box3.getCenter(new THREE.Vector3());
}

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

// A minimal THREE.AxesHelper equivalent, but colored per this project's
// direction convention instead of AxesHelper's built-in X=red/Y=green/Z=blue.
function worldAxesHelper(length: number): THREE.Group {
  const group = new THREE.Group();
  const axes: { axis: 0 | 1 | 2; color: number }[] = [
    { axis: 0, color: 0x44dd44 }, // world X, shown as "Y" (green)
    { axis: 1, color: 0x4488ff }, // world Y (up), shown as "Z" (blue)
    { axis: 2, color: 0xff4444 }, // world Z, shown as "X" (red)
  ];
  for (const { axis, color } of axes) {
    const end = new THREE.Vector3();
    end.setComponent(axis, length);
    const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), end]);
    group.add(new THREE.Line(geometry, new THREE.LineBasicMaterial({ color })));
  }
  return group;
}

function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

function makeAxisLabelSprite(text: string, color: string): THREE.Sprite {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.font = 'bold 42px "Helvetica Neue", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, size / 2, size / 2 + 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
  sprite.renderOrder = 1000;
  sprite.scale.set(0.8, 0.8, 1);
  return sprite;
}

// A single-direction arrow (shaft + cone tip) from the origin out along one
// axis, for the corner axis-indicator gizmo — unlike axisRod above, which is
// a symmetric double-ended rod through the origin (used for the pivot
// indicator), this points one way only, matching how a "which way is X/Y/Z"
// aid should read. The label sprite always billboards to face the camera
// (a Sprite's own rotation is special-cased in WebGL regardless of its
// parent's), even though it's parented to the group that rotates with the
// view, so it tracks the arrow tip's position but always reads upright.
function axisArrow(length: number, thickness: number, axis: 0 | 1 | 2, color: number, label: string, labelColor: string) {
  const material = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true });
  const shaftLength = length * 0.8;
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(thickness, thickness, shaftLength, 8), material);
  shaft.position.y = shaftLength / 2;
  const head = new THREE.Mesh(new THREE.ConeGeometry(thickness * 2.5, length - shaftLength, 8), material);
  head.position.y = shaftLength + (length - shaftLength) / 2;

  const labelSprite = makeAxisLabelSprite(label, labelColor);
  labelSprite.position.y = length + 0.22;

  const group = new THREE.Group();
  group.add(shaft, head, labelSprite);
  group.renderOrder = 999;
  // These primitives are built along local +Y; rotate so that axis points
  // along the requested world axis instead (Y needs no rotation).
  if (axis === 0) group.rotation.z = -Math.PI / 2; // +Y -> +X
  else if (axis === 2) group.rotation.x = Math.PI / 2; // +Y -> +Z
  return group;
}

// Shortest-arc rotation that carries `from` onto `to` — used to reorient the
// camera by the smallest possible turn, rather than via OrbitControls' own
// lookAt() (see stableOrientationTowards below for why).
function quaternionBetween(from: THREE.Vector3, to: THREE.Vector3): THREE.Quaternion {
  const f = from.clone().normalize();
  const t = to.clone().normalize();
  const dot = THREE.MathUtils.clamp(f.dot(t), -1, 1);
  if (dot > 1 - 1e-6) return new THREE.Quaternion();
  if (dot < -1 + 1e-6) {
    let axis = new THREE.Vector3(0, 1, 0).cross(f);
    if (axis.lengthSq() < 1e-6) axis = new THREE.Vector3(1, 0, 0).cross(f);
    return new THREE.Quaternion().setFromAxisAngle(axis.normalize(), Math.PI);
  }
  const axis = f.clone().cross(t).normalize();
  return new THREE.Quaternion().setFromAxisAngle(axis, Math.acos(dot));
}

// OrbitControls.update() reorients the camera every frame via lookAt(camera
// position, target, world-up) — fine everywhere except when the camera's
// forward direction is this close to parallel with world-up: the up×forward
// cross product it needs to define "right" collapses toward zero there, and
// Three.js's fallback (nudging the forward vector by a fixed epsilon) picks
// an arbitrary, discontinuous roll rather than continuing whatever roll the
// view already had. That's what made rotating, or tweening, to an exactly
// vertical view feel like a sudden snap instead of a smooth approach. Reusing
// the previous frame's (still-valid) orientation and applying only the
// smallest rotation needed to reach the new forward direction keeps the roll
// continuous through the approach and while parked there, however
// controls.update() got to that forward (tween, pan, zoom, or idle).
function stableOrientationTowards(prevQuat: THREE.Quaternion, newForward: THREE.Vector3): THREE.Quaternion {
  const prevForward = new THREE.Vector3(0, 0, -1).applyQuaternion(prevQuat);
  return quaternionBetween(prevForward, newForward).multiply(prevQuat);
}

// The exact same "zero roll, up-locked" orientation OrbitControls.update()'s
// lookAt() computes for a given forward direction — safe to use directly
// here since the caller only ever calls this away from the near-parallel-to-up
// zone where that computation is unstable. Used so a snapToView tween's
// destination orientation matches, bit-for-bit, whatever lookAt() will derive
// once the tween ends and hands orientation back to it — otherwise the two
// could disagree on roll (schemes-based-on-continuity have no reason to land
// on the same "canonical" roll lookAt() would pick) and the hand-off itself
// would be a visible snap, just moved to the end of the tween instead of
// happening mid-flight.
function canonicalOrientation(forward: THREE.Vector3, up: THREE.Vector3): THREE.Quaternion {
  const z = forward.clone().negate().normalize();
  const x = new THREE.Vector3().crossVectors(up, z).normalize();
  const y = new THREE.Vector3().crossVectors(z, x);
  const m = new THREE.Matrix4().makeBasis(x, y, z);
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

const raycaster = new THREE.Raycaster();
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const ROTATE_SPEED = 0.5;
const POLE_EPS = THREE.MathUtils.degToRad(2);
const TWEEN_MS = 400;
const FIT_PADDING = 1.2;
const PIVOT_INDICATOR_SCALE = 0.035; // fraction of camera distance
const AXIS_GIZMO_SIZE = 110; // px, corner overlay size
const AXIS_GIZMO_MARGIN_BOTTOM = 34; // clears #build-stamp, which sits in the same corner

// Navigation cube: one labeled face per standard view. BoxGeometry's default
// material-group order is [+X, -X, +Y, -Y, +Z, -Z], which is exactly the
// order these labels and directions are listed in below.
const NAV_CUBE_SIZE_FULL = 225; // px, corner overlay size (180 * 1.25)
const NAV_CUBE_SIZE_MINI = 90; // px, schematic size shown when not hovered in 'mini' mode
const NAV_CUBE_SIZE_ANIM_SPEED = 900; // px/sec, growing/shrinking between mini and full
const NAV_LABELS = ['RIGHT', 'LEFT', 'TOP', 'BOTTOM', 'FRONT', 'BACK'];
const NAV_CUBE_HALF = 0.7; // half-extent of the 1.4-unit BoxGeometry below
const NAV_EDGE_FRACTION = 0.5; // beyond this fraction of the half-extent, an axis counts as "near that edge" too

function makeNavFaceTexture(label: string): THREE.CanvasTexture {
  // Rendered well above the face's typical on-screen size (the cube can
  // appear close to NAV_CUBE_SIZE across on a face viewed near head-on, at
  // any device pixel ratio) so the text stays crisp rather than upscaled/soft.
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#3a3a3a';
  ctx.fillRect(0, 0, size, size);
  // The real face boundary is muted relative to the zone grid below, so the
  // actual clickable zones (not just where one face ends) read as the more
  // prominent lines.
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, size - 4, size - 4);

  // A 3x3 grid marking the actual clickable zones: the center cell is a
  // pure single-axis click, the four edge-mid cells combine with the
  // adjacent face (a 2-axis view), and the four corner cells combine with
  // two adjacent faces (a 3-axis view) — see hitTestNavCube. The lines sit
  // exactly at NAV_EDGE_FRACTION so the outline always matches the hit-test.
  const inner = ((1 - NAV_EDGE_FRACTION) / 2) * size;
  const outer = size - inner;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.moveTo(inner, 0);
  ctx.lineTo(inner, size);
  ctx.moveTo(outer, 0);
  ctx.lineTo(outer, size);
  ctx.moveTo(0, inner);
  ctx.lineTo(size, inner);
  ctx.moveTo(0, outer);
  ctx.lineTo(size, outer);
  ctx.stroke();

  ctx.fillStyle = '#f2f0ea';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Text must fit inside the center cell only (the other 8 cells are
  // edge/corner click zones, see above) — shrink the longest labels
  // ("BOTTOM") down until they fit rather than clipping into the grid lines.
  const maxTextWidth = (outer - inner) * 0.82;
  let fontSize = 72;
  const fontFamily = '"Helvetica Neue", Arial, sans-serif';
  do {
    ctx.font = `600 ${fontSize}px ${fontFamily}`;
    fontSize -= 2;
  } while (ctx.measureText(label).width > maxTextWidth && fontSize > 20);
  ctx.fillText(label, size / 2, size / 2 + 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

type Tween = {
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  // Set only by snapToView, since that's the only tween that changes viewing
  // direction (zoomToFit keeps it fixed) — see snapToView for why orientation
  // needs its own explicit, continuity-preserving interpolation instead of
  // being left for OrbitControls' lookAt() to derive each frame.
  fromQuat?: THREE.Quaternion;
  toQuat?: THREE.Quaternion;
  start: number;
};

type PaneSeed = { position: THREE.Vector3; quaternion: THREE.Quaternion; target: THREE.Vector3 };

// One pane = one independent camera + controls + gesture state, all sharing
// the single `scene` above so every pane shows the same objects. Everything
// here (pivot pick/rotation, zoom-to-fit, cursor icons) is exactly what used
// to be single global state — just scoped to one pane so a second one can
// exist alongside it without the two fighting over shared globals.
function createPane(container: HTMLElement, seed?: PaneSeed) {
  const camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.1, 1000);
  if (seed) camera.position.copy(seed.position);
  else camera.position.set(4, 3, 5);
  if (seed) camera.quaternion.copy(seed.quaternion);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  // The nav cube is a second render() call into a corner viewport; render()
  // auto-clears the whole canvas by default regardless of viewport, which
  // would wipe out the main scene's just-drawn pixels everywhere else. So
  // clearing is done manually, once, at the start of each frame instead.
  renderer.autoClear = false;
  // Required for renderer.clippingPlanes (set per-frame in step()) to have
  // any effect at all — the array itself is what actually turns clipping on.
  renderer.localClippingEnabled = true;
  container.appendChild(renderer.domElement);

  // Camera controls: left = none (reserved for future selection/manipulation),
  // middle = pan, right = rotate (handled entirely by our own code below, see
  // "Custom rotation" — enableRotate is off so OrbitControls never touches it),
  // wheel = zoom.
  // Touch: one finger = pan, two fingers = pinch-to-zoom (still OrbitControls,
  // via enableZoom) + two-finger-drag-to-rotate (also custom, below).
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: null };
  controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
  controls.enableRotate = false;
  controls.enableDamping = false;
  controls.minDistance = 0.5;
  controls.maxDistance = 50;
  controls.target.copy(seed ? seed.target : new THREE.Vector3(0, 1, 0));
  controls.update();

  // Pivot indicator: a 3D crosshair shown at the rotation pivot only when the
  // gesture actually started on real content (not the bounding-box
  // fallback). Its three arms stay parallel to the world axes (colored per
  // this project's X=red/Y=green/Z=blue convention, see worldAxesHelper)
  // rather than billboarding toward the camera — it's a point in space, not
  // a screen-facing icon. It scales with camera distance so it reads as a
  // roughly constant on-screen size.
  const pivotIndicator = new THREE.Group();
  pivotIndicator.add(axisRod(2, 0.08, 0, 0x44dd44), axisRod(2, 0.08, 1, 0x4488ff), axisRod(2, 0.08, 2, 0xff4444));
  pivotIndicator.visible = false;
  scene.add(pivotIndicator);

  let tween: Tween | null = null;
  // Tracked every frame (see step()) so stableOrientationTowards always has
  // a continuous basis to rotate from when the camera nears a pole.
  let lastStableQuat = camera.quaternion.clone();

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

  // Navigation cube: a small labeled-face overlay in this pane's corner —
  // one per pane, each tied to that pane's own camera. Clicking a face snaps
  // the camera to that standard view, preserving the current pivot and
  // distance, tweened the same way as zoom-to-fit (only camera.position
  // moves; controls.target stays fixed, so OrbitControls' own lookAt()
  // derives the correct orientation each frame with no extra work).
  const navMaterials = NAV_LABELS.map((label, index) => {
    const map = makeNavFaceTexture(label);
    // BoxGeometry's default UV layout renders the -Y (BOTTOM, index 3) face's
    // texture upside down relative to the others; rotate it back upright.
    if (index === 3) {
      map.center.set(0.5, 0.5);
      map.rotation = Math.PI;
    }
    return new THREE.MeshBasicMaterial({ map });
  });
  const navCube = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.4, 1.4), navMaterials);

  // Schematic version shown at NAV_CUBE_SIZE_MINI in 'mini' mode: a plain
  // translucent box with crisp edges, no labels/zones — just enough to read
  // as "there's a nav cube here" until hovered, at which point the pane
  // switches to showing navCube at full size instead (see step()).
  const miniCubeGeometry = new THREE.BoxGeometry(1.4, 1.4, 1.4);
  const miniCube = new THREE.Mesh(
    miniCubeGeometry,
    new THREE.MeshBasicMaterial({ color: 0x4a9eff, transparent: true, opacity: 0.35, depthWrite: false }),
  );
  const miniCubeEdges = new THREE.LineSegments(
    new THREE.EdgesGeometry(miniCubeGeometry),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 }),
  );
  miniCube.add(miniCubeEdges);

  const navScene = new THREE.Group();
  navScene.add(navCube, miniCube);
  const navCamera = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 10);
  navCamera.position.set(0, 0, 4);
  navCamera.lookAt(0, 0, 0);
  const navViewport = new THREE.Vector4();

  // In 'mini' mode the cube renders small/schematic until hovered, at which
  // point it's treated as 'full' (showing the real labeled cube at full
  // size, clickable) until the pointer leaves. displaySize is the actual
  // animated on-screen size, grown/shrunk at NAV_CUBE_SIZE_ANIM_SPEED px/sec
  // each frame — hit-testing and rendering both read it, so they never
  // disagree about how big the cube currently looks.
  let navCubeHovering = false;
  let displaySize = navCubeMode === 'mini' ? NAV_CUBE_SIZE_MINI : NAV_CUBE_SIZE_FULL;
  let lastStepTime = performance.now();

  function navCubeShowingFull(): boolean {
    return navCubeMode === 'full' || (navCubeMode === 'mini' && navCubeHovering);
  }

  function pointerOverNavCubeRegion(clientX: number, clientY: number): boolean {
    if (navCubeMode === 'off') return false;
    const rect = renderer.domElement.getBoundingClientRect();
    const offsetX = rect.left + container.clientWidth - displaySize - 8;
    const offsetY = rect.top + container.clientHeight - displaySize - 8;
    const localX = clientX - offsetX;
    const localY = clientY - offsetY;
    return localX >= 0 && localX <= displaySize && localY >= 0 && localY <= displaySize;
  }

  // Marks exactly the clicked zone(s) — the one cell for a face click, the
  // edge-mid cell on each of the two faces for an edge, the corner cell on
  // each of the three faces for a corner — with a thin colored patch flush
  // against the cube surface, replaced (not accumulated) by the next click.
  // Built from the same NAV_CUBE_HALF/NAV_EDGE_FRACTION geometry hitTestNavCube
  // uses, so the highlighted region always matches the actual zone boundaries.
  const SELECTED_COLOR = 0x4a9eff; // the box's own blue, not an unrelated accent
  // Once the user rotates the view away from the direction that was clicked,
  // the highlight no longer describes the current view, so it's dropped.
  const SELECTION_CLEAR_ANGLE = THREE.MathUtils.degToRad(1.5);
  let selectionPatches: THREE.Mesh[] = [];
  let selectedDir: THREE.Vector3 | null = null;

  function clearSelection() {
    selectionPatches.forEach((patch) => {
      navCube.remove(patch);
      patch.geometry.dispose();
      (patch.material as THREE.Material).dispose();
    });
    selectionPatches = [];
    selectedDir = null;
  }

  function selectFacesForDirection(dir: THREE.Vector3) {
    clearSelection();
    selectedDir = dir.clone();

    const half = NAV_CUBE_HALF;
    const threshold = half * NAV_EDGE_FRACTION;
    const bandCenter = (half + threshold) / 2;
    const bandWidth = half - threshold;
    const fullWidth = threshold * 2;
    const flush = 0.01;

    // dir arrives normalized (edge/corner directions have fractional
    // per-axis magnitude, e.g. 0.577 for a corner), but patch placement
    // needs the pure ±1 sign of each axis, not its normalized length.
    const axes: { key: 'x' | 'y' | 'z'; sign: number }[] = [
      { key: 'x', sign: Math.sign(dir.x) },
      { key: 'y', sign: Math.sign(dir.y) },
      { key: 'z', sign: Math.sign(dir.z) },
    ];

    for (const primary of axes) {
      if (primary.sign === 0) continue;
      const size = new THREE.Vector3(fullWidth, fullWidth, fullWidth);
      const center = new THREE.Vector3(0, 0, 0);
      center[primary.key] = primary.sign * (half + flush / 2);
      size[primary.key] = flush;

      for (const other of axes) {
        if (other.key === primary.key || other.sign === 0) continue;
        center[other.key] = other.sign * bandCenter;
        size[other.key] = bandWidth;
      }

      const patch = new THREE.Mesh(
        new THREE.BoxGeometry(size.x, size.y, size.z),
        new THREE.MeshBasicMaterial({ color: SELECTED_COLOR, transparent: true, opacity: 0.55, depthTest: false }),
      );
      patch.position.copy(center);
      patch.renderOrder = 1000;
      navCube.add(patch);
      selectionPatches.push(patch);
    }
  }

  function snapToView(dir: THREE.Vector3) {
    const center = contentBoundsCenter() ?? controls.target.clone();
    const distance = camera.position.distanceTo(controls.target);
    const toPos = center.clone().add(dir.clone().multiplyScalar(distance));

    // Orientation is tweened explicitly (rather than left for OrbitControls'
    // per-frame lookAt() to derive from the lerped position/target) because
    // lookAt()'s roll becomes numerically unstable within several degrees of
    // vertical: composing it frame-by-frame with the near-pole correction in
    // step() meant the correction was "on" for the first frame or two (still
    // near the previous, unrelated pole-parked roll) and then handed off to
    // raw lookAt() once forward tilted just past POLE_EPS — and that raw
    // roll, computed from a near-zero up×forward cross product, has no
    // relation to the roll the correction was just holding, so the hand-off
    // itself was a visible snap. Computing a single fromQuat/toQuat up front
    // and slerping across the whole tween sidesteps lookAt() entirely for
    // its duration, so there's no boundary left to snap across.
    const fromForward = new THREE.Vector3();
    camera.getWorldDirection(fromForward);
    const toForward = center.clone().sub(toPos).normalize();
    const fromQuat = camera.quaternion.clone();
    // The destination orientation must match what lookAt() will derive once
    // the tween ends and hands orientation back to it (see canonicalOrientation)
    // — true for every direction except exactly TOP/BOTTOM, where that's the
    // undefined case this whole scheme exists to avoid; there, continuity
    // from the current orientation is the only sensible definition of "roll".
    const toAngleToUp = toForward.angleTo(WORLD_UP);
    const toQuat =
      toAngleToUp <= POLE_EPS || toAngleToUp >= Math.PI - POLE_EPS
        ? quaternionBetween(fromForward, toForward).multiply(fromQuat.clone())
        : canonicalOrientation(toForward, WORLD_UP);

    tween = {
      fromPos: camera.position.clone(),
      toPos,
      fromTarget: controls.target.clone(),
      toTarget: center,
      fromQuat,
      toQuat,
      start: performance.now(),
    };
  }

  // Faces, edges, and corners are all clickable, matching how CAD nav cubes
  // work — an edge gives a combined 2-axis view (e.g. TOP+RIGHT), a corner a
  // combined 3-axis view. Rather than modeling 26 separate face/edge/corner
  // pieces, this stays a plain 6-face box: a hit is turned into up to three
  // axis directions by checking, in the cube's own local space (undoing its
  // current billboard rotation), which coordinates sit out near an edge —
  // the axis actually hit is always exactly at the extreme, and the other
  // two range across the face, close to an edge/corner when out that far.
  function hitTestNavCube(clientX: number, clientY: number): THREE.Vector3 | null {
    // The schematic 'mini' cube (not yet hovered) isn't click-interactive —
    // only the real labeled cube, shown once "effectively full", is.
    if (!navCubeShowingFull() || !pointerOverNavCubeRegion(clientX, clientY)) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    const offsetX = rect.left + container.clientWidth - NAV_CUBE_SIZE_FULL - 8;
    const offsetY = rect.top + container.clientHeight - NAV_CUBE_SIZE_FULL - 8;
    const ndc = new THREE.Vector2(
      ((clientX - offsetX) / NAV_CUBE_SIZE_FULL) * 2 - 1,
      -((clientY - offsetY) / NAV_CUBE_SIZE_FULL) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, navCamera);
    const hit = raycaster.intersectObject(navCube)[0];
    if (!hit) return null;

    const local = navCube.worldToLocal(hit.point.clone());
    const threshold = NAV_CUBE_HALF * NAV_EDGE_FRACTION;
    const dir = new THREE.Vector3();
    if (Math.abs(local.x) > threshold) dir.x = Math.sign(local.x);
    if (Math.abs(local.y) > threshold) dir.y = Math.sign(local.y);
    if (Math.abs(local.z) > threshold) dir.z = Math.sign(local.z);
    return dir.lengthSq() > 0 ? dir.normalize() : null;
  }

  function stepNavCube(dt: number) {
    if (navCubeMode === 'off') return;
    const showFull = navCubeShowingFull();
    navCube.visible = showFull;
    miniCube.visible = !showFull;

    const target = showFull ? NAV_CUBE_SIZE_FULL : NAV_CUBE_SIZE_MINI;
    const maxStep = NAV_CUBE_SIZE_ANIM_SPEED * dt;
    displaySize += THREE.MathUtils.clamp(target - displaySize, -maxStep, maxStep);
  }

  function renderNavCube() {
    if (navCubeMode === 'off') return;
    navCube.quaternion.copy(camera.quaternion).invert();
    miniCube.quaternion.copy(camera.quaternion).invert();
    renderer.getViewport(navViewport);
    renderer.clearDepth();
    const x = container.clientWidth - displaySize - 8;
    const y = 8; // viewport y is measured bottom-up, so a small value sits near the bottom
    renderer.setViewport(x, y, displaySize, displaySize);
    renderer.render(navScene, navCamera);
    renderer.setViewport(navViewport.x, navViewport.y, navViewport.z, navViewport.w);
  }

  // XYZ direction aid: bottom-left corner, one per pane, same corner-overlay
  // technique as the nav cube. Purely informational (no click handling) — it
  // rotates to reflect the pane's current orientation, same as the cube.
  const axisGizmo = new THREE.Group();
  axisGizmo.add(
    axisArrow(1, 0.05, 0, 0x44dd44, 'Y', '#88ff88'),
    axisArrow(1, 0.05, 1, 0x4488ff, 'Z', '#88bbff'),
    axisArrow(1, 0.05, 2, 0xff4444, 'X', '#ff8888'),
  );
  const axisGizmoScene = new THREE.Group();
  axisGizmoScene.add(axisGizmo);
  const axisGizmoCamera = new THREE.OrthographicCamera(-1.8, 1.8, 1.8, -1.8, 0.1, 10);
  axisGizmoCamera.position.set(0, 0, 4);
  axisGizmoCamera.lookAt(0, 0, 0);

  function renderAxisGizmo() {
    if (!axisGizmoVisible) return;
    axisGizmo.quaternion.copy(camera.quaternion).invert();
    renderer.getViewport(navViewport);
    renderer.clearDepth();
    renderer.setViewport(8, AXIS_GIZMO_MARGIN_BOTTOM, AXIS_GIZMO_SIZE, AXIS_GIZMO_SIZE);
    renderer.render(axisGizmoScene, axisGizmoCamera);
    renderer.setViewport(navViewport.x, navViewport.y, navViewport.z, navViewport.w);
  }

  // Double-middle-click zooms to fit (native dblclick only fires for the left
  // button, so this is detected manually — same pattern as the touch double-tap).
  let lastMiddleClick = { time: 0, x: 0, y: 0 };

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
  // `camera.lookAt(target)` — the instant `target` becomes an off-center
  // point, that lookAt snaps the view to recenter on it. So rotation is
  // implemented here instead: at gesture start, pick a pivot (raycast into
  // `content`, or the content bounding-box center if nothing's hit), then on
  // every move, rotate the camera's position *and* orientation together,
  // rigidly, around that pivot. Since both move by the same incremental
  // rotation, the pivot point stays visually fixed wherever it was on screen
  // when the drag began — everything else swings around it — instead of
  // snapping to center.
  //
  // controls.target is kept re-projected onto the camera's new forward axis
  // (at whatever distance it already was) after every step, purely so
  // OrbitControls' own pan/zoom stay internally consistent (it always
  // assumes target sits dead ahead) and don't jump the next time they're used.
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

    const h = container.clientHeight;
    const deltaTheta = ((2 * Math.PI * dx) / h) * ROTATE_SPEED;
    const deltaPhi = ((2 * Math.PI * dy) / h) * ROTATE_SPEED;

    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    const qYaw = new THREE.Quaternion().setFromAxisAngle(WORLD_UP, deltaTheta);
    const qPitch = new THREE.Quaternion().setFromAxisAngle(right, deltaPhi);

    // Rotating around world-up (yaw) never changes the camera's angle to
    // world-up, so it's always safe. Pitch can push the camera's forward
    // vector nearly parallel to world-up — exactly where camera.up (fixed at
    // world-up) makes the lookAt() inside OrbitControls.update() degenerate,
    // which is what caused a 180° snap when rotating all the way to the top
    // or bottom. So: reject the pitch component for this step if it would
    // cross too close to either pole; the yaw component still applies.
    // The nav cube can snap the camera to land exactly at a pole (see
    // snapToView), which starts a subsequent drag already inside — or right
    // at the edge of — the rejection zone above. A single frame's pitch is
    // usually a couple of degrees, smaller than that zone, so a plain
    // reject-if-still-too-close rule would never let a step through and the
    // view would get stuck unable to pitch away at all. So: once already at
    // or past a boundary, pitch is always allowed through (each step then
    // moves further from the pole, escaping within a frame or two); the
    // reject rule only guards the normal case of approaching the boundary
    // from a safe position.
    const currentForward = new THREE.Vector3();
    camera.getWorldDirection(currentForward);
    const currentAngleToUp = currentForward.angleTo(WORLD_UP);
    const startedAtPole = currentAngleToUp <= POLE_EPS || currentAngleToUp >= Math.PI - POLE_EPS;

    const qYawPitch = qYaw.clone().multiply(qPitch);
    const tentativeForward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion.clone().premultiply(qYawPitch));
    const angleToUp = tentativeForward.angleTo(WORLD_UP);
    const pitchAllowed = startedAtPole || (angleToUp > POLE_EPS && angleToUp < Math.PI - POLE_EPS);
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

  // Cursor reflects the active action: crosshair idle, a custom pan icon
  // while middle-drag/one-finger-drag is panning, a custom rotate icon
  // while right-drag/two-finger-drag is rotating.
  function setCursor(mode: 'idle' | 'pan' | 'rotate') {
    if (mode === 'pan') renderer.domElement.style.cursor = "url('/cursor-pan.svg') 14 14, move";
    else if (mode === 'rotate') renderer.domElement.style.cursor = "url('/cursor-rotate.svg') 16 16, grab";
    else renderer.domElement.style.cursor = '';
  }

  // Pointer events unify mouse/touch/pen, but two-finger touch rotation is
  // handled separately below (it needs the midpoint of both fingers, not a
  // single pointer's position) — so these only ever act on the mouse.
  let isPanning = false;

  renderer.domElement.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'mouse') return;
    if (event.button === 2) {
      event.preventDefault();
      renderer.domElement.setPointerCapture(event.pointerId);
      beginOrbit(event.clientX, event.clientY);
    } else if (event.button === 1) {
      isPanning = true;
      setCursor('pan');
    }
  });
  renderer.domElement.addEventListener('pointermove', (event) => {
    if (event.pointerType !== 'mouse') return;
    stepOrbit(event.clientX, event.clientY);
    navCubeHovering = pointerOverNavCubeRegion(event.clientX, event.clientY);
    if (!orbit.active && !isPanning) {
      renderer.domElement.style.cursor = navCubeHovering && navCubeShowingFull() ? 'pointer' : '';
    }
  });
  renderer.domElement.addEventListener('pointerleave', () => {
    navCubeHovering = false;
  });
  renderer.domElement.addEventListener('pointerup', (event) => {
    if (event.pointerType !== 'mouse') return;
    if (event.button === 2) {
      endOrbit();
    } else if (event.button === 1) {
      isPanning = false;
      setCursor('idle');
      const now = performance.now();
      const dx = event.clientX - lastMiddleClick.x;
      const dy = event.clientY - lastMiddleClick.y;
      if (now - lastMiddleClick.time < 300 && Math.hypot(dx, dy) < 10) {
        zoomToFit();
        lastMiddleClick = { time: 0, x: 0, y: 0 };
      } else {
        lastMiddleClick = { time: now, x: event.clientX, y: event.clientY };
      }
    } else if (event.button === 0) {
      if (placementModeActive) {
        placeClipPlaneAt(event.clientX, event.clientY);
        return;
      }
      const dir = hitTestNavCube(event.clientX, event.clientY);
      if (dir) {
        snapToView(dir);
        selectFacesForDirection(dir);
      }
    }
  });

  // Cutting-plane placement: while the dialog's "+ Add plane" flow is
  // waiting for a click (placementModeActive), a left-click anywhere on the
  // model places a plane through that point, facing this pane's camera —
  // matching "click a point, the plane goes through it, parallel to my
  // viewing direction" rather than the nav cube's click-to-snap-view. Nav
  // cube clicks are ignored entirely during placement, so the two never mix.
  function placeClipPlaneAt(clientX: number, clientY: number) {
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObject(content, true)[0];
    if (!hit) return;
    const point = hit.point.clone();
    const normal = camera.position.clone().sub(point).normalize();
    addClipPlane(point, normal);
  }

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

  function resize() {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  }

  function step() {
    // Set only while a snapToView tween is both active and driving
    // orientation (see snapToView) — holds the slerped quaternion for this
    // frame so it can be (re-)applied after controls.update() below, since
    // that call would otherwise overwrite it via its own lookAt().
    let tweenQuat: THREE.Quaternion | null = null;

    if (tween) {
      const t = Math.min(1, (performance.now() - tween.start) / TWEEN_MS);
      const e = easeOutCubic(t);
      camera.position.lerpVectors(tween.fromPos, tween.toPos, e);
      controls.target.lerpVectors(tween.fromTarget, tween.toTarget, e);
      if (tween.fromQuat && tween.toQuat) {
        tweenQuat = new THREE.Quaternion().slerpQuaternions(tween.fromQuat, tween.toQuat, e);
      }
      if (t === 1) tween = null;
    }

    if (pivotIndicator.visible) {
      const scale = camera.position.distanceTo(pivotIndicator.position) * PIVOT_INDICATOR_SCALE;
      pivotIndicator.scale.setScalar(scale);
    }

    const now = performance.now();
    const dt = (now - lastStepTime) / 1000;
    lastStepTime = now;
    stepNavCube(dt);

    controls.update();

    if (tweenQuat) {
      // A snapToView tween is mid-flight: its own slerp already owns
      // orientation for this frame, so the lookAt() controls.update() just
      // ran is discarded rather than left to fight it near a pole.
      camera.quaternion.copy(tweenQuat);
    } else {
      // Otherwise (idle, panning, zooming, or mid-drag) trust controls.update()'s
      // lookAt() — except within a couple of degrees of vertical, where its
      // roll becomes numerically unstable (see stableOrientationTowards):
      // reconstruct orientation there as the smallest turn from the last
      // frame's (still-good) orientation instead.
      const rawForward = new THREE.Vector3();
      camera.getWorldDirection(rawForward);
      const angleToUp = rawForward.angleTo(WORLD_UP);
      if (angleToUp <= POLE_EPS || angleToUp >= Math.PI - POLE_EPS) {
        camera.quaternion.copy(stableOrientationTowards(lastStableQuat, rawForward));
      }
    }
    lastStableQuat.copy(camera.quaternion);

    if (selectedDir && !tween) {
      const forward = new THREE.Vector3();
      camera.getWorldDirection(forward);
      if (forward.angleTo(selectedDir.clone().negate()) > SELECTION_CLEAR_ANGLE) clearSelection();
    }

    renderer.clear();
    // Clipping applies only to the main scene render — the nav cube and axis
    // gizmo are drawn afterward from their own small, unrelated local-origin
    // scenes, and would otherwise risk being clipped too if the active
    // plane's world-space position happened to fall within their own tiny
    // coordinate range.
    renderer.clippingPlanes = activeClipPlaneId ? [sharedClipPlane] : [];
    renderer.render(scene, camera);
    renderer.clippingPlanes = [];
    renderNavCube();
    renderAxisGizmo();
  }

  function dispose() {
    controls.dispose();
    renderer.dispose();
    scene.remove(pivotIndicator);
    navMaterials.forEach((material) => {
      material.map?.dispose();
      material.dispose();
    });
    navCube.geometry.dispose();
    selectionPatches.forEach((patch) => {
      patch.geometry.dispose();
      (patch.material as THREE.Material).dispose();
    });
    miniCubeGeometry.dispose();
    (miniCube.material as THREE.Material).dispose();
    miniCubeEdges.geometry.dispose();
    (miniCubeEdges.material as THREE.Material).dispose();
    axisGizmo.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        child.material.dispose();
      } else if (child instanceof THREE.Sprite) {
        child.material.map?.dispose();
        child.material.dispose();
      }
    });
    container.remove();
  }

  function currentSeed(): PaneSeed {
    return { position: camera.position.clone(), quaternion: camera.quaternion.clone(), target: controls.target.clone() };
  }

  return { container, camera, controls, resize, step, dispose, currentSeed, snapToView, hitTestNavCube };
}

type Pane = ReturnType<typeof createPane>;
const panes: Pane[] = [];

function addPane(seed?: PaneSeed) {
  const container = document.createElement('div');
  container.className = 'pane';
  container.style.flexGrow = '1';
  panesEl.appendChild(container);
  panes.push(createPane(container, seed));
}

addPane();

// Draggable divider between the two panes, shown only in split view. Widths
// are driven by flex-grow on each pane (resizer stays a fixed width), so a
// drag just changes that ratio — a window resize alone doesn't need to touch it.
let resizerEl: HTMLElement | null = null;

function addResizer() {
  resizerEl = document.createElement('div');
  resizerEl.className = 'pane-resizer';
  panesEl.insertBefore(resizerEl, panes[1].container);

  let dragging = false;

  function setRatioFromClientX(clientX: number) {
    const rect = panesEl.getBoundingClientRect();
    const ratio = THREE.MathUtils.clamp((clientX - rect.left) / rect.width, 0.15, 0.85);
    panes[0].container.style.flexGrow = String(ratio);
    panes[1].container.style.flexGrow = String(1 - ratio);
    panes.forEach((pane) => pane.resize());
  }

  resizerEl.addEventListener('pointerdown', (event) => {
    dragging = true;
    resizerEl!.classList.add('dragging');
    resizerEl!.setPointerCapture(event.pointerId);
    document.body.style.userSelect = 'none';
  });
  resizerEl.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    setRatioFromClientX(event.clientX);
  });
  resizerEl.addEventListener('pointerup', () => {
    dragging = false;
    resizerEl!.classList.remove('dragging');
    document.body.style.userSelect = '';
  });
}

function removeResizer() {
  resizerEl?.remove();
  resizerEl = null;
}

splitViewBtn.addEventListener('click', () => {
  if (panes.length === 1) {
    const seed = panes[0].currentSeed();
    addPane(seed);
    addResizer();
    splitViewBtn.classList.add('active');
    splitViewBtn.querySelector('.tooltip')!.textContent = 'Single view';
    splitViewBtn.setAttribute('aria-label', 'Single view');
  } else {
    removeResizer();
    panes.pop()!.dispose();
    panes[0].container.style.flexGrow = '1';
    splitViewBtn.classList.remove('active');
    splitViewBtn.querySelector('.tooltip')!.textContent = 'Split view';
    splitViewBtn.setAttribute('aria-label', 'Split view');
  }
  panes.forEach((pane) => pane.resize());
});

// Cycles full -> mini -> off -> full. The tooltip always names what the
// NEXT click will do, matching the other toggle buttons' convention.
const NAV_CUBE_NEXT_MODE: Record<NavCubeMode, NavCubeMode> = { full: 'mini', mini: 'off', off: 'full' };
const NAV_CUBE_NEXT_LABEL: Record<NavCubeMode, string> = {
  full: 'Minimize navigation cube',
  mini: 'Hide navigation cube',
  off: 'Show navigation cube',
};
navCubeBtn.addEventListener('click', () => {
  navCubeMode = NAV_CUBE_NEXT_MODE[navCubeMode];
  navCubeBtn.classList.toggle('active', navCubeMode !== 'off');
  const label = NAV_CUBE_NEXT_LABEL[navCubeMode];
  navCubeBtn.querySelector('.tooltip')!.textContent = label;
  navCubeBtn.setAttribute('aria-label', label);
});

axisGizmoBtn.addEventListener('click', () => {
  axisGizmoVisible = !axisGizmoVisible;
  axisGizmoBtn.classList.toggle('active', axisGizmoVisible);
  const label = axisGizmoVisible ? 'Hide axis indicator' : 'Show axis indicator';
  axisGizmoBtn.querySelector('.tooltip')!.textContent = label;
  axisGizmoBtn.setAttribute('aria-label', label);
});

// Cutting-plane manager: dialog list (rename/select-active/align-to-axis/
// flip/view/delete), the "+ Add plane" placement flow, and applying the
// active plane to every pane's renderer (see step()'s clippingPlanes toggle).

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function applyActiveClipPlane() {
  const active = clipPlanes.find((p) => p.id === activeClipPlaneId);
  if (active) sharedClipPlane.setFromNormalAndCoplanarPoint(active.normal, active.point);
}

function renderClipPlaneList() {
  clipPlaneEmpty.hidden = clipPlanes.length > 0;
  clipPlaneList.innerHTML = clipPlanes
    .map(
      (p) => `
    <li class="clip-plane-row" data-id="${p.id}">
      <input type="radio" name="clip-plane-active" class="clip-plane-radio" ${p.id === activeClipPlaneId ? 'checked' : ''} aria-label="Enable ${escapeHtml(p.name)}" />
      <input type="text" class="clip-plane-name" value="${escapeHtml(p.name)}" aria-label="Plane name" />
      <span class="clip-plane-axis-btns">
        <button type="button" data-axis="x" title="Align to X axis">X</button>
        <button type="button" data-axis="y" title="Align to Y axis">Y</button>
        <button type="button" data-axis="z" title="Align to Z axis">Z</button>
        <button type="button" data-axis="flip" title="Flip normal">&#8645;</button>
      </span>
      <button type="button" class="clip-plane-view-btn" data-dir="pos" title="View from + side">View &rarr;</button>
      <button type="button" class="clip-plane-view-btn" data-dir="neg" title="View from &minus; side">View &larr;</button>
      <button type="button" class="clip-plane-delete-btn" title="Delete plane" aria-label="Delete ${escapeHtml(p.name)}">&times;</button>
    </li>`,
    )
    .join('');
}

function addClipPlane(point: THREE.Vector3, normal: THREE.Vector3) {
  const id = `plane-${nextClipPlaneNumber}`;
  const def: ClipPlaneDef = { id, name: `Plane ${nextClipPlaneNumber}`, point: point.clone(), normal: normal.clone() };
  nextClipPlaneNumber++;
  clipPlanes.push(def);
  activeClipPlaneId = id;
  applyActiveClipPlane();
  exitPlacementMode();
  clipPlaneDialog.hidden = false;
  renderClipPlaneList();
}

function exitPlacementMode() {
  placementModeActive = false;
  clipPlaneBanner.hidden = true;
}

clipPlaneBtn.addEventListener('click', () => {
  renderClipPlaneList();
  clipPlaneDialog.hidden = false;
});

clipPlaneCloseBtn.addEventListener('click', () => {
  clipPlaneDialog.hidden = true;
});

clipPlaneDialog.addEventListener('click', (event) => {
  if (event.target === clipPlaneDialog) clipPlaneDialog.hidden = true;
});

clipPlaneAddBtn.addEventListener('click', () => {
  clipPlaneDialog.hidden = true;
  clipPlaneBanner.hidden = false;
  placementModeActive = true;
});

clipPlaneCancelBtn.addEventListener('click', () => {
  exitPlacementMode();
  clipPlaneDialog.hidden = false;
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && placementModeActive) {
    exitPlacementMode();
    clipPlaneDialog.hidden = false;
  }
});

clipPlaneList.addEventListener('change', (event) => {
  const target = event.target as HTMLElement;
  const row = target.closest<HTMLElement>('.clip-plane-row');
  if (!row) return;
  const id = row.dataset.id!;
  if (target.classList.contains('clip-plane-radio')) {
    activeClipPlaneId = id;
    applyActiveClipPlane();
  } else if (target.classList.contains('clip-plane-name')) {
    const plane = clipPlanes.find((p) => p.id === id);
    const value = (target as HTMLInputElement).value.trim();
    if (plane && value) plane.name = value;
  }
});

clipPlaneList.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest('button');
  if (!button) return;
  const row = button.closest<HTMLElement>('.clip-plane-row');
  if (!row) return;
  const id = row.dataset.id!;
  const plane = clipPlanes.find((p) => p.id === id);
  if (!plane) return;

  if (button.classList.contains('clip-plane-delete-btn')) {
    clipPlanes = clipPlanes.filter((p) => p.id !== id);
    if (activeClipPlaneId === id) {
      activeClipPlaneId = null;
    }
    renderClipPlaneList();
    return;
  }

  if (button.classList.contains('clip-plane-view-btn')) {
    const dir = button.dataset.dir === 'pos' ? plane.normal.clone() : plane.normal.clone().negate();
    panes.forEach((pane) => pane.snapToView(dir));
    return;
  }

  const axis = button.dataset.axis;
  if (axis === 'x') plane.normal.set(1, 0, 0);
  else if (axis === 'y') plane.normal.set(0, 1, 0);
  else if (axis === 'z') plane.normal.set(0, 0, 1);
  else if (axis === 'flip') plane.normal.negate();
  if (plane.id === activeClipPlaneId) applyActiveClipPlane();
});

window.addEventListener('resize', () => {
  panes.forEach((pane) => pane.resize());
});

function animate() {
  requestAnimationFrame(animate);
  panes.forEach((pane) => pane.step());
}
animate();
