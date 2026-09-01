Rules for Claude Code to abide by:

1. This repo is the freebar 3D bar-shape modeling tool, deployed to freebar.virag.fun via GitHub Pages.
2. This repo must remain completely independent from cv.virag.fun and cv.virag.fun_private. Do not add a dependency, submodule, shared package, or build-time reference to either — not even to reuse styling or assets. If a visual match is wanted (e.g. matching a color), hardcode the value here instead of importing it from those repos.
3. This repo is deployed via GitHub Pages, thus cannot contain unsupported logic (no server-side code/secrets required to render the site).
4. This repo is public.
5. Every build must render a build timestamp in the bottom-left corner of the viewport (currently `#build-stamp` in src/main.ts, populated from the `__BUILD_TIME__` constant injected at build time in vite.config.ts). This lets a deployment be visually confirmed by checking that the shown time updated after pushing. Keep it working until the user says it can be removed.
