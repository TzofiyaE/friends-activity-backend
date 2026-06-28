# Contributing

Thanks for helping keep Friends Activity healthy! This repo runs in full TypeScript strict mode and blocks explicit `any`. Please read the guidelines below before opening a PR.

## Getting Started

1. Install Node.js 20+.
2. `npm install`
3. Copy `.env.example` to `.env` and fill in the required values (GitHub token, DB connection, API key).
4. Run `npm run migration:run` to initialise the database schema.
5. Run `npm run dev` to start the development server.

## Branch Flow

1. Create an issue (or pick an existing one) and branch from `main` using `issue-<id>/<short-name>`.
2. Keep commits focused; include tests and docs with behaviour changes.
3. Before opening a PR, run:
   - `npm run lint`
   - `npm run build`
   - `npm test`

## Type Safety Policy

- `tsconfig.json` enforces `"strict": true` + `"noImplicitAny": true`.
- ESLint treats `@typescript-eslint/no-explicit-any` as an error.
- The Husky pre-commit hook lints staged TypeScript files (`npx eslint --max-warnings=0`).
- Prefer `unknown` + narrowing over `any` when working with external data.

## Tests & Static Analysis

- Add or update unit tests in `src/ingest/__tests__/` when touching ingestion logic.
- All tests must pass locally before opening a PR; CI runs on Node 20 and 22.

Need help? Open a discussion or tag a maintainer in your issue/PR. Happy hacking!
