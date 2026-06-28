# Maakaf Home Backend

[![CI](https://github.com/Maakaf/friends-activity-backend/actions/workflows/ci.yml/badge.svg)](https://github.com/Maakaf/friends-activity-backend/actions/workflows/ci.yml)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)

Backend service powering the community activity dashboard on [maakaf.com](https://maakaf.com). It ingests GitHub contribution data for registered community members, stores it in PostgreSQL, and exposes an analytics API consumed daily by the frontend.

---

## Table of Contents

- [Overview](#overview)
- [How It Works](#how-it-works)
- [Architecture](#architecture)
  - [Ingestion Pipeline](#ingestion-pipeline)
  - [Database Schema](#database-schema)
- [GitHub GraphQL Ingestion](#github-graphql-ingestion)
  - [Contribution Types](#contribution-types)
  - [Repository Filter](#repository-filter)
  - [Overflow Handling](#overflow-handling)
  - [Rolling Activity Algorithm](#rolling-activity-algorithm)
- [API Reference](#api-reference)
  - [Authentication](#authentication)
  - [Endpoints](#endpoints)
  - [Analytics Report Shape](#analytics-report-shape)
- [Setup](#setup)
  - [Prerequisites](#prerequisites)
  - [Environment Variables](#environment-variables)
  - [Database Setup](#database-setup)
  - [Running Locally](#running-locally)
- [Testing](#testing)
- [Daily Refresh Workflow](#daily-refresh-workflow)
- [User Management](#user-management)
- [Project Structure](#project-structure)
- [Known Limitations](#known-limitations)
- [Contributing](#contributing)
- [License](#license)

---

## Overview

Community members register their GitHub usernames in [`users.json`](users.json). This service fetches their public open-source contributions for the past 6 months via the GitHub GraphQL API and produces a structured analytics report. The frontend consumes this report as a static JSON file — updated daily by GitHub Actions — and renders per-member activity cards, contribution breakdowns, rolling activity graphs, a repository leaderboard, and a community-wide activity timeline.

---

## How It Works

```
users.json
    │
    ▼
POST /pipeline/v2/refreshAll          ← called daily by GitHub Actions at 01:00 UTC
    │
    ├─ Fetch each user from GitHub GraphQL API
    │   ├─ 180-day window  → per-repo contribution counts (table data)
    │   └─ 365-day window  → daily contribution counts (rolling graph data)
    │
    ├─ Atomic DB transaction per user (failed users keep previous data)
    │
    └─ Write to PostgreSQL (Neon)
            │
            ▼
    GET /pipeline/v2/analytics/report  ← called daily by frontend GitHub Actions
            │
            ▼
    data/github_data.json committed to maakaf_home repo
            │
            ▼
    Hugo static site build → maakaf.com
```

---

## Architecture

### Ingestion Pipeline

Each `refreshAll` run executes in two phases:

**Phase 1 — GitHub fetch (parallel, rate-limited)**

All users are fetched concurrently, batched in groups of 10 with a random 2–10 second delay between batches to respect GitHub's secondary rate limits. Each user is fetched twice:

- **180-day window**: Produces per-repo, per-type contribution counts used for the activity table.
- **365-day window**: Produces per-day contribution totals used to compute the rolling 6-month activity graph.

Fetching two windows per user — rather than one — avoids a subtle correctness issue: the overflow pagination strategy differs between the aggregate (bucket counts) and the daily timeline (dated events), making a single shared fetch produce incorrect results for one of them.

**Phase 2 — Atomic DB write (per user)**

For each successfully fetched user, a single transaction deletes their existing rows and inserts fresh data across all activity tables. Users whose GitHub fetch failed (e.g. due to a transient 5xx) are skipped — their previous data is preserved so they do not disappear from the dashboard until the next successful refresh.

### Database Schema

All tables live in the default `public` schema, managed by TypeORM migrations.

#### `user_profile`

Stores GitHub profile metadata per community member.

| Column | Type | Description |
|--------|------|-------------|
| `user_id` (PK) | `varchar(64)` | GitHub database ID (numeric string) |
| `login` | `varchar(255)` | GitHub username |
| `name` | `varchar(255)` | Display name |
| `avatar_url` | `text` | Profile picture URL |
| `html_url` | `text` | GitHub profile URL |
| `bio` | `text` | Profile bio |
| `location` | `varchar(255)` | Location string |
| `company` | `varchar(255)` | Company |
| `blog` | `text` | Website URL |
| `twitter_username` | `varchar(255)` | Twitter handle |
| `public_repos` | `integer` | Public repository count |
| `followers` | `integer` | Follower count |
| `following` | `integer` | Following count |
| `gh_created_at` | `timestamptz` | GitHub account creation date |
| `fetched_at` | `timestamptz` | Last time this record was refreshed |

#### `repository`

Stores metadata for every OSS repository a community member contributed to.

| Column | Type | Description |
|--------|------|-------------|
| `repo_id` (PK) | `varchar(64)` | GitHub repository node ID |
| `repo_name` | `varchar(512)` | Full name (`owner/repo`) |
| `description` | `text` | Repository description |
| `html_url` | `text` | GitHub URL |
| `fork_count` | `integer` | Number of forks |
| `stargazer_count` | `integer` | Number of stars |
| `primary_language` | `varchar(255)` | Primary programming language |
| `primary_language_color` | `varchar(32)` | Language color hex code |
| `license_name` | `varchar(255)` | License full name |
| `license_spdx` | `varchar(64)` | SPDX license identifier |
| `topics` | `text[]` | Repository topic tags |

#### `user_activity`

Per-user, per-repository, per-day, per-type contribution counts. The primary key is a composite of all four dimensions.

| Column | Type | Description |
|--------|------|-------------|
| `user_id` (PK) | `varchar(64)` | References `user_profile.user_id` |
| `day` (PK) | `date` | Contribution date |
| `repo_id` (PK) | `varchar(64)` | References `repository.repo_id` |
| `activity_type` (PK) | `varchar(32)` | One of: `commit`, `pr`, `issue`, `pr_review`, `pr_comment`, `issue_comment` |
| `activity_count` | `integer` | Number of contributions |

#### `user_daily_contribution`

Aggregated total OSS contributions per user per day (all types combined, all repos combined). Used as input to compute rolling activity.

| Column | Type | Description |
|--------|------|-------------|
| `user_id` (PK) | `varchar(64)` | References `user_profile.user_id` |
| `day` (PK) | `date` | Contribution date |
| `total` | `integer` | Total OSS contributions on this day |

#### `user_rolling_activity`

Pre-computed rolling 180-day window totals per user per day. Each row answers: "as of this date, how many total OSS contributions did this user make in the preceding 180 days?"

| Column | Type | Description |
|--------|------|-------------|
| `user_id` (PK) | `varchar(64)` | References `user_profile.user_id` |
| `day` (PK) | `date` | Reference date |
| `total` | `integer` | Sum of daily contributions in the 180 days ending on this date |

#### `user_sync`

Tracks the sync lifecycle of each user across refresh runs.

| Column | Type | Description |
|--------|------|-------------|
| `login` (PK) | `varchar(255)` | GitHub username |
| `user_id` | `varchar(64)` | GitHub database ID (populated after first successful fetch) |
| `status` | `varchar(32)` | `pending` / `ready` / `failed` / `not_found` |
| `last_synced_at` | `timestamptz` | Timestamp of last successful sync |
| `last_error` | `text` | Error message from last failed sync |
| `updated_at` | `timestamptz` | Timestamp of last status update |

---

## GitHub GraphQL Ingestion

### Contribution Types

The following contribution types are tracked, all scoped to the past 180 days (or 365 days for the daily timeline):

| Type | API source | Counted as |
|------|-----------|------------|
| **Commits** | `commitContributionsByRepository` → `commitCount` per day | Actual commits (not contribution days) |
| **Pull Requests** | `pullRequestContributionsByRepository` | 1 per PR opened |
| **Issues** | `issueContributionsByRepository` | 1 per issue opened |
| **PR Reviews** | `pullRequestReviewContributionsByRepository` | 1 per review submitted |
| **PR Comments** | `issueComments` (where `pullRequest` is set) + `pullRequestReviewContributions.comments.totalCount` | 1 per conversation comment + N per inline review comment batch |
| **Issue Comments** | `issueComments` (where `issue` is set) | 1 per comment |

### Repository Filter

Only contributions to repositories with **≥ 3 forks** (`MIN_FORK_COUNT = 3`) are counted. This filters out personal and toy projects, focusing the dashboard on community-relevant open-source work. Repository metadata (fork count, stars, language, license, topics) is fetched via `nodes(ids: [...])` in a single batched query.

### Overflow Handling

GitHub's GraphQL contributions API enforces two hard caps:

**Cap 1: Maximum 100 repositories** (`MAX_REPOSITORIES = 100`)

`commitContributionsByRepository`, `pullRequestContributionsByRepository`, etc. return at most 100 repos. For users who contributed to more than 100 repos in the window, the pipeline detects the overflow by comparing `totalRepositoriesWithContributed*` against the number of returned buckets, then paginates the full repo list via `repositoriesContributedTo`. Overflow commit counts are then fetched per-repo via `defaultBranchRef.target.history`.

**Cap 2: Maximum 100 contribution events per bucket** (`PAGE_SIZE = 100`)

Each repo's `contributions(first: 100)` connection may be truncated. For PRs, issues, and reviews, the pipeline detects `pageInfo.hasNextPage` on any bucket and switches to a flat paginated query (`pullRequestContributions`, `issueContributions`, `pullRequestReviewContributions`) that fetches all events across all repos in one stream.

For commits, which have no equivalent flat query, repos with `hasNextPage` are re-walked via `defaultBranchRef.target.history` with full pagination. This ensures heavy committers (e.g. users who commit daily for more than 100 days to a single repo) are counted correctly in the activity graph.

### Rolling Activity Algorithm

The 365-day fetch produces a `Map<date, count>` of daily OSS contribution totals per user. The rolling activity series is computed as follows:

```
for each day D in [today - 179 … today]:
    rolling[D] = Σ daily[d] for d in [D - 179 … D]
```

This produces 180 data points — one per day — where each point represents the total OSS activity in the 6-month window ending on that date. The series is stored in `user_rolling_activity` and returned in the analytics report as `rollingActivity`.

The **community rolling timeline** (`communityRolling` in the report) is the per-day sum of every user's rolling total:

```
communityRolling[D] = Σ user.rollingActivity[D] for all users
```

---

## API Reference

### Authentication

All endpoints (except `/health`) require an `X-API-Key` header matching the `API_KEY` environment variable.

```
X-API-Key: your-api-key
```

If `API_KEY` is not set, the guard runs in open-access mode (development only).

### Endpoints

#### `GET /health`

Health check. Returns `200` when the service is running.

```json
{ "status": "ok", "timestamp": "2026-06-27T01:00:00.000Z" }
```

---

#### `POST /pipeline/v2/refreshAll`

Wipes and re-ingests all users listed in `users.json`. This is the primary write operation, called daily by GitHub Actions.

**No request body required.**

**Response:**

```json
{
  "message": "Refresh completed",
  "successfulUsers": ["avifenesh", "EtanHey", "lirantal"],
  "failedUsers": []
}
```

Failed users retain their previous data. Check `GET /pipeline/v2/listUsers` to inspect per-user status.

**Duration:** Proportional to the number of users × 2 GitHub fetches per user. Expect 3–10 minutes for a typical community list.

---

#### `GET /pipeline/v2/listUsers`

Returns all users grouped by their current sync status.

**Response:**

```json
{
  "total": 18,
  "ready":      { "count": 17, "users": ["avifenesh", "EtanHey", ...] },
  "processing": { "count": 0,  "users": [] },
  "pending":    { "count": 0,  "users": [] },
  "failed":     { "count": 1,  "users": ["someuser"] }
}
```

| Status | Meaning |
|--------|---------|
| `ready` | Successfully ingested; data is current |
| `processing` | Refresh in progress |
| `pending` | Queued, not yet started |
| `failed` | Last fetch failed; previous data preserved |

---

#### `GET /pipeline/v2/analytics/report`

Returns the full analytics report consumed by the frontend. Only users with status `ready` are included.

See [Analytics Report Shape](#analytics-report-shape) for the full response structure.

---

### Analytics Report Shape

```typescript
{
  users: Array<{
    user: {
      username: string;          // GitHub login
      displayName: string | null;
      avatarUrl: string | null;
      bio: string | null;
      location: string | null;
      company: string | null;
      blog: string | null;
      twitterUsername: string | null;
      publicRepos: number;
      followers: number;
      following: number;
      accountType: string;
      createdAt: string;         // ISO 8601
    };
    repos: Array<{
      repoName: string;          // "owner/repo"
      description: string | null;
      url: string;
      primaryLanguage: string | null;
      primaryLanguageColor: string | null;
      stargazerCount: number;
      licenseName: string | null;
      licenseSpdx: string | null;
      topics: string[];
      commits: number;
      pullRequests: number;
      issues: number;
      prReviews: number;
      prComments: number;
      issueComments: number;
    }>;
    summary: {
      totalCommits: number;
      totalPRs: number;
      totalIssues: number;
      totalPRReviews: number;
      totalPRComments: number;
      totalIssueComments: number;
    };
    rollingActivity: Array<{
      date: string;   // "YYYY-MM-DD" — 180 entries, one per day
      total: number;  // sum of all OSS contributions in the 180 days ending on this date
    }>;
  }>;

  globalSummary: {
    totalCommits: number;
    totalPRs: number;
    totalIssues: number;
    totalPRReviews: number;
    totalPRComments: number;
    totalIssueComments: number;
    totalRepos: number;         // unique repos across all users
    successfulUsers: number;
    totalUsers: number;
    analysisTimeframe: string;  // "YYYY-MM-DD to YYYY-MM-DD"
    minForkCountFilter: string; // "3"
  };

  repoLeaderboard: Array<{
    repoName: string;
    description: string | null;
    url: string | null;
    forkCount: number;
    stargazerCount: number;
    primaryLanguage: string | null;
    primaryLanguageColor: string | null;
    licenseName: string | null;
    licenseSpdx: string | null;
    topics: string[];
    commits: number;
    pullRequests: number;
    issues: number;
    prReviews: number;
    prComments: number;
    issueComments: number;
    contributors: number;          // distinct community members who contributed
    contributorList: Array<{ login: string; avatarUrl: string | null }>;
    totalActivity: number;         // sum of all types — used for sort order
  }>;                              // sorted descending by totalActivity

  communityRolling: Array<{
    date: string;   // "YYYY-MM-DD" — covers the same 180-day window
    total: number;  // sum of all users' rolling totals on this date
  }>;

  excludedUsers: string[];  // always [] in current implementation
}
```

---

## Setup

### Prerequisites

- **Node.js** v20 or higher
- **npm** v9 or higher
- A **[Neon](https://neon.tech)** PostgreSQL database (free tier is sufficient)
- A **GitHub Personal Access Token** with the following scopes:
  - `public_repo` — read public repository data
  - `read:user` — read public user profile data

To create a token: **GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token**

### Environment Variables

Create a `.env` file in the project root:

```env
# PostgreSQL connection string (Neon or any Postgres-compatible URL)
DATABASE_URL=postgres://user:password@host.region.aws.neon.tech/dbname?sslmode=require

# GitHub Personal Access Token
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx

# API key required on all non-health endpoints
API_KEY=your-chosen-secret-key

# Optional: set to "false" to disable SSL (local Postgres only)
# DATABASE_SSL=false
```

### Database Setup

On first run, apply all migrations to create the required tables:

```bash
npm install
npm run build
npm run migration:run
```

To check which migrations have been applied:

```bash
npm run migration:show
```

### Running Locally

**Development** (TypeScript via `ts-node`, no build step required):

```bash
npm run dev
```

**Production** (compiled JavaScript):

```bash
npm run build
npm start
```

The server starts at `http://localhost:3000`. Interactive API documentation is available at `http://localhost:3000/docs` (Swagger UI).

**First-time data population:**

```bash
# Trigger a full ingest (takes several minutes)
curl -X POST http://localhost:3000/pipeline/v2/refreshAll \
  -H "X-API-Key: your-api-key"

# Monitor progress
curl http://localhost:3000/pipeline/v2/listUsers \
  -H "X-API-Key: your-api-key"

# Fetch the report once users are ready
curl http://localhost:3000/pipeline/v2/analytics/report \
  -H "X-API-Key: your-api-key"
```

### Available Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start development server (ts-node) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Start production server from `dist/` |
| `npm test` | Run unit tests |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:cov` | Run tests with coverage report |
| `npm run migration:run` | Apply all pending migrations |
| `npm run migration:revert` | Revert the last applied migration |
| `npm run migration:show` | List all migrations and their status |
| `npm run migration:generate` | Generate a new migration from entity changes |
| `npm run lint` | Run ESLint with auto-fix |
| `npm run format` | Run Prettier |

---

## Testing

Unit tests live alongside the source in `src/ingest/__tests__/`. Run them with:

```bash
npm test
```

The test suite covers the core logic of the ingestion pipeline:

| Test file | What it covers |
|-----------|----------------|
| `aggregate.spec.ts` | Contribution counts routed to the correct repo buckets; overflow counts overwriting bucket data; metadata (language, stars, topics) attached correctly |
| `overflow.spec.ts` | GraphQL query construction for users with > 100 repos; batch chunking at 25 repos; correct search qualifiers per contribution type |
| `pagination.spec.ts` | Issue comment pagination (walking backwards, halting at window boundary, cursor stagnation detection); PR review pagination |
| `rolling-activity.spec.ts` | Rolling 180-day window computation; missing days treated as zero; correct output size |

---

## Daily Refresh Workflow

A GitHub Actions workflow ([`.github/workflows/daily_stats.yml`](.github/workflows/daily_stats.yml)) runs every day at **01:00 UTC**:

1. Calls `POST /pipeline/v2/refreshAll` on the production server (hosted on Railway)
2. Waits for a `200` or `201` response
3. Fails the workflow run if any other status is returned

The production URL is `https://friends-activity-backend-production.up.railway.app`.

The **frontend** has its own daily workflow that calls `GET /pipeline/v2/analytics/report`, saves the result to `data/github_data.json`, and commits it to the `maakaf_home` repository. The Hugo build then bakes this JSON into the static site.

---

## User Management

The list of tracked community members is maintained in [`users.json`](users.json) — a flat JSON array of GitHub usernames:

```json
["avifenesh", "EtanHey", "lirantal", "fruch"]
```

**To add a user:** append their GitHub username to `users.json` and open a pull request. The next scheduled `refreshAll` will ingest their data automatically.

**To remove a user:** remove their username from `users.json`. The next `refreshAll` will not re-ingest them, but their existing data persists in the database until manually cleaned up. Their profile will no longer appear in the analytics report (only `ready` users are included, and their `user_sync` record will no longer be updated).

---

## Project Structure

```
src/
├── app.controller.ts          # Health check endpoint
├── app.module.ts              # Root NestJS module
├── auth/
│   └── api-key.guard.ts       # X-API-Key authentication guard
├── database/
│   ├── data-source.ts         # TypeORM data source (used by CLI)
│   ├── entities/app/          # TypeORM entity classes (one per DB table)
│   └── migrations/            # TypeORM migration history
├── ingest/
│   ├── aggregate.ts           # Maps GraphQL response → per-repo contribution buckets
│   ├── constants.ts           # MIN_FORK_COUNT, MAX_REPOSITORIES, PAGE_SIZE
│   ├── daily-contributions.ts # Computes dated daily counts + rolling activity
│   ├── graphql-client.ts      # Thin wrapper around GitHub GraphQL endpoint
│   ├── graphql-ingest.service.ts  # Main per-user fetch orchestration
│   ├── graphql-queries.ts     # All GraphQL query strings
│   ├── graphql-types.ts       # TypeScript types for GraphQL responses
│   ├── ingest.module.ts       # NestJS module
│   ├── metadata.ts            # Batch-fetches repo metadata by node ID
│   ├── overflow.ts            # Handles >100 repo and >100 event-per-bucket caps
│   ├── pagination.ts          # Issue comment and PR review pagination
│   ├── persistence.ts         # DB write helpers + computeRollingActivity
│   └── __tests__/             # Unit tests
├── pipeline-v2/
│   ├── pipeline-v2.controller.ts  # REST endpoints (/pipeline/v2/*)
│   ├── pipeline-v2.module.ts
│   └── pipeline-v2.service.ts     # refreshAll, generateReport, listUsers
└── main.ts                    # Application bootstrap
```

---

## Known Limitations

**Commit counting on non-default branches**

When a repo's contribution bucket is truncated (> 100 contribution days in the fetch window), the pipeline falls back to `defaultBranchRef.target.history` to recover the missing commit data. This means commits to non-default branches that were never merged into the default branch are not counted in those cases. For the vast majority of contributors this difference is negligible.

**PR reviews in `prComments`**

The `prComments` total in the analytics report includes both conversation comments on PRs and inline code review comments. The two are not separated in the per-repo breakdown. This is intentional — both represent engagement on pull requests.

**`prReviews` not displayed in the frontend**

The backend tracks PR review submissions as a distinct metric (`prReviews`), but the current frontend only displays five contribution types (commits, PRs, issues, PR comments, issue comments). As a result, the five visible numbers on a member's card do not sum to the rolling activity graph total, which does include PR reviews.

**User removal**

Removing a username from `users.json` stops future ingestion for that user but does not purge their historical data from the database. Data cleanup requires a manual database operation or a dedicated migration.

---

## Contributing

We welcome contributions. Please read [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow.

**Branch naming convention** (required for CI to run):

```
issue-<issue-number>/short-descriptive-name
```

Example: `issue-48/fix-commit-overflow`

**Quick checklist before opening a PR:**

- [ ] `npm test` passes locally
- [ ] `npm run build` compiles without errors
- [ ] New logic has unit tests in `src/ingest/__tests__/`
- [ ] No use of `any` (ESLint will reject it)
- [ ] TypeScript strict mode is satisfied

**Opening an issue:** Before starting work, open an issue describing what you intend to change and why. This prevents duplicate effort and gives maintainers a chance to flag concerns early.

---

## License

This project is licensed under the **GNU General Public License v3.0**. See [LICENSE](LICENSE) for the full text.

---

*Part of the [Maakaf](https://maakaf.com) open source community initiative.*
