# frontend

React + TypeScript + Tailwind v4 + Vite + react-router-dom. Built against the
`researchgraph-frontend` skill's phase plan (`references/phases.md`).

```bash
npm install
npm run dev          # http://localhost:5173, API at VITE_API_URL (default http://localhost:8000)
npm run typecheck
npm run build
npm test
npm run gen:api       # regenerate src/api/schema.d.ts from a running backend's /openapi.json
npm run check:coverage
```
