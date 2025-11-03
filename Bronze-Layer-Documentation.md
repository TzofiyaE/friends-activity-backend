The Bronze Layer is responsible for collecting and storing raw data from the GitHub API. This layer implements the **"Write Once, Read Many"** pattern, storing data exactly as received from GitHub without any transformation or processing.

## Table of Contents
- [Overview](#overview)
- [Architecture](#architecture)
- [Core Components](#core-components)
- [API Endpoints](#api-endpoints)
- [Data Flow Details](#data-flow-details)
- [GitHub API Integration](#github-api-integration)
- [Error Handling](#error-handling)
- [Database Schema](#database-schema)

---

## Overview

The Bronze Layer serves as the foundation of our data pipeline, providing:
- **Raw Data Preservation**: Stores GitHub API responses in their original JSONB format
- **Audit Trail**: Complete historical record of all API interactions
- **Reprocessing Capability**: Allows rebuilding Silver/Gold layers from raw data
- **API Resilience**: Handles GitHub API rate limits and failures gracefully

### Key Principles
1. **No Transformation**: Data stored exactly as received from GitHub
2. **Idempotency**: Duplicate ingestion requests don't create duplicate records
3. **Atomicity**: All-or-nothing writes per user
4. **Immutability**: Once written, bronze data is never modified

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        BRONZE LAYER                             │
│                                                                  │
│  ┌────────────────┐         ┌──────────────┐                   │
│  │ RawController  │────────▶│ RawService   │                   │
│  │ (HTTP Entry)   │         │ (Business    │                   │
│  │                │         │  Logic)      │                   │
│  └────────────────┘         └──────────────┘                   │
│                                     │                            │
│                                     ▼                            │
│                             ┌──────────────┐                    │
│                             │  RawSaver    │                    │
│                             │ (Persistence │                    │
│                             │   Layer)     │                    │
│                             └──────────────┘                    │
│                                     │                            │
│                    ┌────────────────┼────────────────┐          │
│                    ▼                ▼                ▼          │
│           ┌────────────┐  ┌────────────┐  ┌────────────┐       │
│           │ Raw Memory │  │  Database  │  │   GitHub   │       │
│           │   Store    │  │ Repository │  │    API     │       │
│           │  (Cache)   │  │  (TypeORM) │  │  (Octokit) │       │
│           └────────────┘  └────────────┘  └────────────┘       │
│                                     │                            │
│                                     ▼                            │
│           ┌─────────────────────────────────────────┐           │
│           │      PostgreSQL Bronze Schema           │           │
│           │  • bronze.github_events                 │           │
│           │  • bronze.github_users                  │           │
│           │  • bronze.github_repos                  │           │
│           └─────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────────┘
```

---

## Core Components

### 1. RawController (`raw.controller.ts`)

HTTP endpoint handler for raw data ingestion.

**Location**: `src/raw/raw.controller.ts`

#### Endpoints

##### POST /raw/users
Ingests GitHub data for specified users.

**Request Handler Flow**:
```typescript
@Post('users')
async ingestUsers(@Body() dto: IngestUsersDto)
```

**Flow**:
```
1. Receive HTTP POST request
   ↓
2. Validate DTO using class-validator
   • usernames: string[] (required, non-empty)
   ↓
3. Call RawService.ingestUsers(usernames)
   ↓
4. Return success/error response
```

**Request Example**:
```json
{
  "usernames": ["octocat", "torvalds"]
}
```

**Response Example**:
```json
{
  "success": true,
  "message": "Successfully ingested data for 2 users",
  "details": {
    "processedUsers": ["octocat", "torvalds"],
    "totalEvents": 300,
    "totalUsers": 2,
    "totalRepos": 45
  }
}
```

---

### 2. RawService (`raw.service.ts`)

Core business logic for fetching and orchestrating GitHub data ingestion.

**Location**: `src/raw/raw.service.ts`

#### Main Methods

##### `ingestUsers(usernames: string[]): Promise<void>`

Orchestrates the complete data ingestion process for multiple users.

**Detailed Flow**:

```
┌─────────────────────────────────────────────────────────────────┐
│ Step 1: INITIALIZATION                                          │
│  • Validate usernames array is not empty                        │
│  • Initialize Octokit client with GitHub token                  │
│  • Prepare result tracking variables                            │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ Step 2: USER ITERATION                                          │
│  For each username in usernames:                                │
│    ↓                                                             │
│    ├─▶ Call fetchUserData(username)                             │
│    ├─▶ Call fetchUserEvents(username)                           │
│    └─▶ Aggregate results                                        │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ Step 3: DATA PERSISTENCE                                        │
│  • Call RawSaver.saveAll(aggregatedData)                        │
│  • Commit to database                                           │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ Step 4: LOGGING & RESPONSE                                      │
│  • Log success/failure statistics                               │
│  • Return summary to caller                                     │
└─────────────────────────────────────────────────────────────────┘
```

**Code Flow Visualization**:
```typescript
async ingestUsers(usernames: string[]) {
  // 1. Setup
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const results = { events: [], users: [], repos: [] };

  // 2. Fetch data for each user
  for (const username of usernames) {
    const userData = await this.fetchUserData(octokit, username);
    const userEvents = await this.fetchUserEvents(octokit, username);
    
    results.users.push(userData);
    results.events.push(...userEvents.events);
    results.repos.push(...userEvents.repos);
  }

  // 3. Save to database
  await this.rawSaver.saveAll(results);

  // 4. Log and return
  this.logger.log(`Ingested ${results.events.length} events for ${usernames.length} users`);
}
```

---

##### `fetchUserData(octokit: Octokit, username: string): Promise<GitHubUser>`

Fetches user profile information from GitHub.

**GitHub API Call**: `GET /users/{username}`

**Detailed Flow**:

```
┌─────────────────────────────────────────────────────────────────┐
│ Step 1: API REQUEST PREPARATION                                 │
│  • Build request URL: https://api.github.com/users/{username}   │
│  • Set authentication headers (GitHub token)                    │
│  • Configure timeout and retry settings                         │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ Step 2: MAKE API CALL                                           │
│  octokit.rest.users.getByUsername({                             │
│    username: username                                           │
│  })                                                             │
│                                                                  │
│  Rate Limit Check:                                              │
│  • Remaining: X-RateLimit-Remaining header                      │
│  • Reset Time: X-RateLimit-Reset header                         │
│  • If rate limited → wait until reset time                      │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ Step 3: RESPONSE PROCESSING                                     │
│  Extract fields from response.data:                             │
│  • login (username)                                             │
│  • id (GitHub user ID)                                          │
│  • avatar_url                                                   │
│  • name                                                         │
│  • company                                                      │
│  • blog                                                         │
│  • location                                                     │
│  • email                                                        │
│  • bio                                                          │
│  • public_repos                                                 │
│  • followers                                                    │
│  • following                                                    │
│  • created_at                                                   │
│  • updated_at                                                   │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ Step 4: ERROR HANDLING                                          │
│  Try-Catch Block:                                               │
│  • 404 Not Found → Log warning, return null                     │
│  • 403 Forbidden → Rate limit exceeded, throw error             │
│  • 401 Unauthorized → Invalid token, throw error                │
│  • Network errors → Retry with exponential backoff              │
│  • Other errors → Log and throw                                 │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ Step 5: RETURN USER DATA                                        │
│  Return complete user object for storage                        │
└─────────────────────────────────────────────────────────────────┘
```

**Response Structure**:
```typescript
{
  login: "octocat",
  id: 583231,
  avatar_url: "https://avatars.githubusercontent.com/u/583231?v=4",
  name: "The Octocat",
  company: "@github",
  blog: "https://github.blog",
  location: "San Francisco",
  email: "octocat@github.com",
  bio: "GitHub mascot",
  public_repos: 8,
  followers: 12000,
  following: 9,
  created_at: "2011-01-25T18:44:36Z",
  updated_at: "2025-11-03T10:00:00Z"
}
```

---

##### `fetchUserEvents(octokit: Octokit, username: string, since?: Date): Promise<UserEventsResult>`

Fetches user activity events from the last 6 months.

**GitHub API Call**: `GET /users/{username}/events`

**Detailed Flow**:

```
┌─────────────────────────────────────────────────────────────────┐
│ Step 1: TIME RANGE CALCULATION                                  │
│  • Calculate 'since' date:                                      │
│    - Default: 6 months ago from now                             │
│    - Or use provided 'since' parameter                          │
│  • Format: ISO 8601 (YYYY-MM-DDTHH:mm:ssZ)                      │
│  • Example: 2025-05-03T10:00:00Z                                │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ Step 2: PAGINATION SETUP                                        │
│  • GitHub API returns max 100 events per page                   │
│  • Initialize:                                                  │
│    - page = 1                                                   │
│    - per_page = 100                                             │
│    - allEvents = []                                             │
│    - hasMore = true                                             │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ Step 3: PAGINATED API CALLS (LOOP)                              │
│  While hasMore:                                                 │
│    ↓                                                             │
│    A. Make API Request                                          │
│       octokit.rest.activity.listPublicEventsForUser({           │
│         username: username,                                     │
│         per_page: 100,                                          │
│         page: page                                              │
│       })                                                        │
│    ↓                                                             │
│    B. Rate Limit Check                                          │
│       • Check X-RateLimit-Remaining header                      │
│       • If < 100 remaining → pause and wait                     │
│       • Calculate wait time from X-RateLimit-Reset              │
│    ↓                                                             │
│    C. Process Response                                          │
│       • Filter events by date (created_at >= since)             │
│       • Extract event types:                                    │
│         - PushEvent (commits)                                   │
│         - PullRequestEvent (PRs)                                │
│         - IssuesEvent (issues)                                  │
│         - IssueCommentEvent (comments)                          │
│         - PullRequestReviewEvent (PR reviews)                   │
│         - PullRequestReviewCommentEvent (PR comments)           │
│         - CreateEvent (branch/tag creation)                     │
│         - DeleteEvent (branch/tag deletion)                     │
│         - ForkEvent (repository forks)                          │
│         - WatchEvent (starring repos)                           │
│    ↓                                                             │
│    D. Extract Repository Data                                   │
│       For each event:                                           │
│         • Extract event.repo (repository info)                  │
│         • Fetch full repo details if fork_count >= 3            │
│         • Store in repos array                                  │
│    ↓                                                             │
│    E. Check Continuation                                        │
│       • If response.data.length < 100 → hasMore = false         │
│       • If oldest event < since date → hasMore = false          │
│       • Else → page++, continue loop                            │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ Step 4: REPOSITORY ENRICHMENT                                   │
│  For each unique repository in events:                          │
│    ↓                                                             │
│    A. Check Fork Count Filter                                   │
│       • If repo.fork_count < 3 → skip                           │
│    ↓                                                             │
│    B. Fetch Full Repository Data                                │
│       octokit.rest.repos.get({                                  │
│         owner: repo.owner,                                      │
│         repo: repo.name                                         │
│       })                                                        │
│    ↓                                                             │
│    C. Extract Repository Details                                │
│       • id, name, full_name                                     │
│       • description                                             │
│       • fork_count, stargazers_count                            │
│       • language, topics                                        │
│       • created_at, updated_at, pushed_at                       │
│       • license, homepage                                       │
│       • open_issues_count                                       │
│    ↓                                                             │
│    D. Store Enriched Repo Data                                  │
│       • Add to repos array                                      │
│       • Deduplicate by repo.id                                  │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ Step 5: ERROR HANDLING                                          │
│  Try-Catch for Each API Call:                                   │
│  • 404 → User not found or no public activity                   │
│  • 403 → Rate limit exceeded                                    │
│    - Wait until rate limit reset                                │
│    - Retry the request                                          │
│  • 422 → Validation error (invalid username format)             │
│  • 500/502/503 → GitHub service issues                          │
│    - Retry with exponential backoff (max 3 attempts)            │
│  • Network timeout → Retry with increased timeout               │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ Step 6: RETURN AGGREGATED RESULTS                               │
│  Return {                                                       │
│    events: Event[],      // All filtered events                │
│    repos: Repository[]   // Enriched repo data (fork_count>=3) │
│  }                                                              │
└─────────────────────────────────────────────────────────────────┘
```

**Event Types Processing**:

```typescript
// PushEvent - Code commits
{
  type: "PushEvent",
  actor: { login: "octocat" },
  repo: { name: "octocat/Hello-World" },
  payload: {
    commits: [
      {
        sha: "abc123...",
        message: "Fix bug in authentication",
        author: { name: "Octocat", email: "octocat@github.com" }
      }
    ],
    ref: "refs/heads/main",
    size: 3  // number of commits
  },
  created_at: "2025-11-03T10:00:00Z"
}

// PullRequestEvent - PR opened/closed/merged
{
  type: "PullRequestEvent",
  actor: { login: "octocat" },
  repo: { name: "octocat/Hello-World" },
  payload: {
    action: "opened",  // or "closed", "merged"
    pull_request: {
      number: 42,
      title: "Add new feature",
      state: "open",
      merged: false,
      created_at: "2025-11-03T09:00:00Z",
      updated_at: "2025-11-03T10:00:00Z"
    }
  },
  created_at: "2025-11-03T10:00:00Z"
}

// IssuesEvent - Issue opened/closed
{
  type: "IssuesEvent",
  actor: { login: "octocat" },
  repo: { name: "octocat/Hello-World" },
  payload: {
    action: "opened",  // or "closed"
    issue: {
      number: 123,
      title: "Bug in login flow",
      state: "open",
      created_at: "2025-11-03T10:00:00Z"
    }
  },
  created_at: "2025-11-03T10:00:00Z"
}

// IssueCommentEvent - Comments on issues/PRs
{
  type: "IssueCommentEvent",
  actor: { login: "octocat" },
  repo: { name: "octocat/Hello-World" },
  payload: {
    action: "created",
    issue: { number: 123 },
    comment: {
      body: "I think the issue is in line 45",
      created_at: "2025-11-03T10:00:00Z"
    }
  },
  created_at: "2025-11-03T10:00:00Z"
}
```

---

### 3. RawSaver (`raw-saver.ts`)

Handles persistence of raw data to the database.

**Location**: `src/raw/raw-saver.ts`

#### Main Methods

##### `saveAll(data: RawIngestData): Promise<void>`

Saves all collected data to the bronze schema in a single transaction.

**Detailed Flow**:

```
┌─────────────────────────────────────────────────────────────────┐
│ Step 1: TRANSACTION INITIALIZATION                              │
│  • Begin database transaction                                   │
│  • Set isolation level: READ COMMITTED                          │
│  • Acquire connection from pool                                 │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ Step 2: SAVE USERS (bronze.github_users)                        │
│  For each user in data.users:                                   │
│    ↓                                                             │
│    A. Check for Existing Record                                 │
│       SELECT * FROM bronze.github_users                         │
│       WHERE username = user.login                               │
│    ↓                                                             │
│    B. Upsert Strategy                                           │
│       INSERT INTO bronze.github_users (                         │
│         username,                                               │
│         user_id,                                                │
│         raw_data,          -- Complete JSON from GitHub         │
│         fetched_at         -- Current timestamp                 │
│       ) VALUES (...)                                            │
│       ON CONFLICT (username) DO UPDATE SET                      │
│         raw_data = EXCLUDED.raw_data,                           │
│         fetched_at = EXCLUDED.fetched_at                        │
│    ↓                                                             │
│    C. Log Operation                                             │
│       • Log: "Saved/Updated user: {username}"                   │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ Step 3: SAVE REPOSITORIES (bronze.github_repos)                 │
│  For each repo in data.repos:                                   │
│    ↓                                                             │
│    A. Filter by Fork Count                                      │
│       • Skip if repo.fork_count < 3                             │
│    ↓                                                             │
│    B. Check for Existing Record                                 │
│       SELECT * FROM bronze.github_repos                         │
│       WHERE repo_id = repo.id                                   │
│    ↓                                                             │
│    C. Upsert Strategy                                           │
│       INSERT INTO bronze.github_repos (                         │
│         repo_id,                                                │
│         full_name,                                              │
│         owner,                                                  │
│         name,                                                   │
│         raw_data,          -- Complete JSON from GitHub         │
│         fork_count,        -- For filtering                     │
│         fetched_at                                              │
│       ) VALUES (...)                                            │
│       ON CONFLICT (repo_id) DO UPDATE SET                       │
│         raw_data = EXCLUDED.raw_data,                           │
│         fork_count = EXCLUDED.fork_count,                       │
│         fetched_at = EXCLUDED.fetched_at                        │
│    ↓                                                             │
│    D. Log Operation                                             │
│       • Log: "Saved/Updated repo: {full_name}"                  │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ Step 4: SAVE EVENTS (bronze.github_events)                      │
│  For each event in data.events:                                 │
│    ↓                                                             │
│    A. Extract Event Metadata                                    │
│       • event_id (from GitHub)                                  │
│       • event_type (PushEvent, PullRequestEvent, etc.)          │
│       • actor (username)                                        │
│       • repo (repository name)                                  │
│       • created_at (event timestamp)                            │
│    ↓                                                             │
│    B. Check for Duplicate                                       │
│       SELECT * FROM bronze.github_events                        │
│       WHERE event_id = event.id                                 │
│    ↓                                                             │
│    C. Insert New Event                                          │
│       INSERT INTO bronze.github_events (                        │
│         event_id,                                               │
│         event_type,                                             │
│         actor_username,                                         │
│         repo_name,                                              │
│         raw_data,          -- Complete event JSON               │
│         created_at,        -- GitHub event timestamp            │
│         fetched_at         -- Our ingestion timestamp           │
│       ) VALUES (...)                                            │
│       ON CONFLICT (event_id) DO NOTHING                         │
│         -- Skip duplicates, don't update                        │
│    ↓                                                             │
│    D. Log Operation                                             │
│       • Log: "Saved event: {event_type} for {actor}"            │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ Step 5: TRANSACTION COMMIT                                      │
│  • Commit transaction if all inserts succeed                    │
│  • Release database connection                                  │
│  • Log success summary                                          │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ Step 6: ERROR HANDLING & ROLLBACK                               │
│  If any error occurs:                                           │
│  • Rollback entire transaction                                  │
│  • Log detailed error message                                   │
│  • Throw error to caller                                        │
│  • No partial data saved                                        │
└─────────────────────────────────────────────────────────────────┘
```

**SQL Examples**:

```sql
-- User Upsert
INSERT INTO bronze.github_users (
  username, 
  user_id, 
  raw_data, 
  fetched_at
) VALUES (
  'octocat',
  583231,
  '{"login":"octocat","id":583231,...}'::jsonb,
  NOW()
)
ON CONFLICT (username) 
DO UPDATE SET 
  raw_data = EXCLUDED.raw_data,
  fetched_at = EXCLUDED.fetched_at;

-- Repository Upsert
INSERT INTO bronze.github_repos (
  repo_id,
  full_name,
  owner,
  name,
  raw_data,
  fork_count,
  fetched_at
) VALUES (
  1296269,
  'octocat/Hello-World',
  'octocat',
  'Hello-World',
  '{"id":1296269,"full_name":"octocat/Hello-World",...}'::jsonb,
  450,
  NOW()
)
ON CONFLICT (repo_id)
DO UPDATE SET
  raw_data = EXCLUDED.raw_data,
  fork_count = EXCLUDED.fork_count,
  fetched_at = EXCLUDED.fetched_at;

-- Event Insert (no update on conflict)
INSERT INTO bronze.github_events (
  event_id,
  event_type,
  actor_username,
  repo_name,
  raw_data,
  created_at,
  fetched_at
) VALUES (
  '12345678901',
  'PushEvent',
  'octocat',
  'octocat/Hello-World',
  '{"id":"12345678901","type":"PushEvent",...}'::jsonb,
  '2025-11-03T10:00:00Z',
  NOW()
)
ON CONFLICT (event_id) DO NOTHING;
```

---

### 4. RawMemoryStore (`raw-memory.store.ts`)

In-memory cache for raw data (used in testing and development).

**Location**: `src/raw/raw-memory.store.ts`

**Purpose**:
- Provides fast in-memory storage for development/testing
- Implements same interface as database repository
- Useful for unit tests without database dependency

**Key Methods**:
```typescript
class RawMemoryStore {
  private users: Map<string, GitHubUser> = new Map();
  private repos: Map<number, GitHubRepo> = new Map();
  private events: Map<string, GitHubEvent> = new Map();

  // Save methods
  async saveUser(user: GitHubUser): Promise<void>;
  async saveRepo(repo: GitHubRepo): Promise<void>;
  async saveEvent(event: GitHubEvent): Promise<void>;

  // Retrieval methods
  async getUser(username: string): Promise<GitHubUser | null>;
  async getRepo(repoId: number): Promise<GitHubRepo | null>;
  async getUserEvents(username: string): Promise<GitHubEvent[]>;

  // Utility methods
  async clear(): Promise<void>;  // Clear all data
  async count(): Promise<{ users: number; repos: number; events: number }>;
}
```

---

## GitHub API Integration

### Authentication

**Token Setup**:
```typescript
const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
  userAgent: 'friends-activity-backend/1.0.0',
  timeZone: 'UTC'
});
```

**Environment Variable**:
```bash
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
```

### Rate Limiting

GitHub imposes the following rate limits:

| Authentication | Requests/Hour | Core API | Search API |
|---------------|---------------|----------|------------|
| Authenticated | 5,000 | 5,000/hr | 30/min |
| Unauthenticated | 60 | 60/hr | 10/min |

**Rate Limit Handling Strategy**:

```typescript
async function handleRateLimit(response: Response) {
  const remaining = parseInt(response.headers['x-ratelimit-remaining']);
  const reset = parseInt(response.headers['x-ratelimit-reset']);
  
  if (remaining < 100) {
    const now = Math.floor(Date.now() / 1000);
    const waitTime = (reset - now) * 1000;
    
    this.logger.warn(`Approaching rate limit. ${remaining} requests remaining.`);
    this.logger.warn(`Waiting ${waitTime}ms until reset...`);
    
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }
}
```

### Retry Logic

**Exponential Backoff**:
```typescript
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries) throw error;
      
      const isRetryable = [500, 502, 503, 504].includes(error.status);
      if (!isRetryable) throw error;
      
      const backoffMs = Math.pow(2, attempt) * 1000;  // 2s, 4s, 8s
      this.logger.warn(`Attempt ${attempt} failed. Retrying in ${backoffMs}ms...`);
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }
}
```

---

## Error Handling

### Error Types and Responses

#### 1. GitHub API Errors

**404 - User Not Found**:
```typescript
try {
  const userData = await octokit.rest.users.getByUsername({ username });
} catch (error) {
  if (error.status === 404) {
    this.logger.warn(`User not found: ${username}`);
    return null;  // Skip this user, continue with others
  }
  throw error;
}
```

**403 - Rate Limit Exceeded**:
```typescript
if (error.status === 403 && error.response?.headers['x-ratelimit-remaining'] === '0') {
  const reset = error.response.headers['x-ratelimit-reset'];
  const waitUntil = new Date(parseInt(reset) * 1000);
  
  this.logger.error(`Rate limit exceeded. Resets at ${waitUntil.toISOString()}`);
  throw new HttpException(
    `GitHub rate limit exceeded. Try again after ${waitUntil.toISOString()}`,
    HttpStatus.TOO_MANY_REQUESTS
  );
}
```

**401 - Invalid Token**:
```typescript
if (error.status === 401) {
  this.logger.error('GitHub authentication failed. Check GITHUB_TOKEN environment variable.');
  throw new HttpException(
    'Invalid GitHub token. Please check configuration.',
    HttpStatus.UNAUTHORIZED
  );
}
```

#### 2. Database Errors

**Connection Failure**:
```typescript
try {
  await this.rawSaver.saveAll(data);
} catch (error) {
  if (error.code === 'ECONNREFUSED') {
    this.logger.error('Database connection refused');
    throw new HttpException(
      'Database unavailable',
      HttpStatus.SERVICE_UNAVAILABLE
    );
  }
  throw error;
}
```

**Constraint Violation**:
```typescript
// This is handled gracefully via ON CONFLICT in our upsert queries
// No error thrown - just skip duplicate records
```

#### 3. Validation Errors

**Invalid Username Format**:
```typescript
// Handled by class-validator in DTO
@IsNotEmpty()
@IsArray()
@ArrayMinSize(1)
@ArrayMaxSize(10)  // Limit batch size
@IsString({ each: true })
@Matches(/^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i, {
  each: true,
  message: 'Invalid GitHub username format'
})
usernames: string[];
```

---

## Database Schema

### bronze.github_events

```sql
CREATE TABLE bronze.github_events (
  event_id VARCHAR(50) PRIMARY KEY,
  event_type VARCHAR(50) NOT NULL,
  actor_username VARCHAR(255) NOT NULL,
  repo_name VARCHAR(255) NOT NULL,
  raw_data JSONB NOT NULL,
  created_at TIMESTAMP NOT NULL,
  fetched_at TIMESTAMP NOT NULL DEFAULT NOW(),
  
  INDEX idx_actor (actor_username),
  INDEX idx_repo (repo_name),
  INDEX idx_type (event_type),
  INDEX idx_created (created_at),
  INDEX idx_fetched (fetched_at)
);
```

### bronze.github_users

```sql
CREATE TABLE bronze.github_users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(255) UNIQUE NOT NULL,
  user_id BIGINT UNIQUE NOT NULL,
  raw_data JSONB NOT NULL,
  fetched_at TIMESTAMP NOT NULL DEFAULT NOW(),
  
  INDEX idx_username (username),
  INDEX idx_user_id (user_id),
  INDEX idx_fetched (fetched_at)
);
```

### bronze.github_repos

```sql
CREATE TABLE bronze.github_repos (
  id SERIAL PRIMARY KEY,
  repo_id BIGINT UNIQUE NOT NULL,
  full_name VARCHAR(255) NOT NULL,
  owner VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  raw_data JSONB NOT NULL,
  fork_count INTEGER NOT NULL DEFAULT 0,
  fetched_at TIMESTAMP NOT NULL DEFAULT NOW(),
  
  INDEX idx_repo_id (repo_id),
  INDEX idx_full_name (full_name),
  INDEX idx_owner (owner),
  INDEX idx_fork_count (fork_count),
  INDEX idx_fetched (fetched_at),
  
  CONSTRAINT chk_fork_count CHECK (fork_count >= 0)
);
```

---

## Performance Considerations

### 1. Batch Processing
- Process multiple users in a single request
- Limit: 10 users per request to avoid timeouts

### 2. Database Indexing
- Indexes on frequently queried fields (username, repo_id, event_type)
- Composite indexes for common query patterns
- JSONB GIN indexes for raw_data queries (if needed)

### 3. Connection Pooling
```typescript
// TypeORM configuration
{
  type: 'postgres',
  url: process.env.DATABASE_URL,
  extra: {
    max: 20,  // Maximum pool size
    min: 5,   // Minimum pool size
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000
  }
}
```

### 4. Data Volume Estimates

For a typical user (6 months):
- Events: ~300-500 records
- Raw JSON size: ~50-100KB per user
- Storage per user: ~100-200KB in bronze schema

For 100 users:
- Total events: ~30,000-50,000
- Total storage: ~10-20MB

---

## Monitoring and Logging

### Log Levels

**INFO**: Normal operation
```typescript
this.logger.log(`Starting ingestion for ${usernames.length} users`);
this.logger.log(`Successfully ingested ${eventCount} events`);
```

**WARN**: Recoverable issues
```typescript
this.logger.warn(`User not found: ${username}`);
this.logger.warn(`Approaching rate limit: ${remaining} requests remaining`);
```

**ERROR**: Failures requiring attention
```typescript
this.logger.error(`Failed to fetch events for ${username}: ${error.message}`);
this.logger.error(`Database transaction failed: ${error.message}`);
```

### Metrics to Monitor

1. **API Call Success Rate**: % of successful GitHub API calls
2. **Rate Limit Usage**: Current usage vs. limit
3. **Processing Time**: Average time per user
4. **Error Rate**: % of failed ingestions
5. **Data Volume**: Events/users/repos ingested per hour

---

## Testing

### Unit Tests

```typescript
describe('RawService', () => {
  it('should fetch user data from GitHub', async () => {
    const service = new RawService(mockRawSaver, mockLogger);
    const userData = await service.fetchUserData(mockOctokit, 'octocat');
    
    expect(userData).toBeDefined();
    expect(userData.login).toBe('octocat');
  });
  
  it('should handle rate limiting gracefully', async () => {
    // Mock rate limit exceeded response
    const mockOctokit = createMockOctokit({
      rateLimitRemaining: 0,
      rateLimitReset: Date.now() + 60000
    });
    
    await expect(
      service.fetchUserEvents(mockOctokit, 'octocat')
    ).rejects.toThrow('Rate limit exceeded');
  });
});
```

### Integration Tests

```typescript
describe('Raw Data Ingestion (Integration)', () => {
  it('should ingest real GitHub data', async () => {
    const service = new RawService(realRawSaver, logger);
    
    await service.ingestUsers(['octocat']);
    
    const savedUser = await database.query(
      'SELECT * FROM bronze.github_users WHERE username = $1',
      ['octocat']
    );
    
    expect(savedUser.rows).toHaveLength(1);
    expect(savedUser.rows[0].raw_data).toBeDefined();
  });
});
```

---

## Best Practices

### 1. Token Management
- ✅ Store token in environment variables
- ✅ Never commit tokens to version control
- ✅ Rotate tokens periodically
- ✅ Use tokens with minimum required scopes

### 2. Error Handling
- ✅ Always wrap API calls in try-catch
- ✅ Implement retry logic for transient failures
- ✅ Log detailed error information
- ✅ Return meaningful error messages to clients

### 3. Data Integrity
- ✅ Use database transactions for atomic writes
- ✅ Validate data before storage
- ✅ Handle duplicate records gracefully
- ✅ Preserve complete raw data for auditability

### 4. Performance
- ✅ Batch process when possible
- ✅ Respect API rate limits
- ✅ Use connection pooling
- ✅ Implement appropriate indexes
- ✅ Monitor and optimize slow queries

---

## Troubleshooting

### Common Issues

**Issue**: "GitHub API rate limit exceeded"
```
Solution:
1. Wait for rate limit reset (check X-RateLimit-Reset header)
2. Reduce batch size of requests
3. Verify GITHUB_TOKEN is set correctly
4. Consider using multiple tokens (if allowed by GitHub ToS)
```

**Issue**: "User not found (404)"
```
Solution:
1. Verify username spelling
2. Check if user account still exists
3. Ensure user has public activity
4. Check GitHub service status
```

**Issue**: "Database connection timeout"
```
Solution:
1. Verify DATABASE_URL is correct
2. Check database server is running
3. Verify network connectivity
4. Check connection pool settings
5. Monitor active connections
```

**Issue**: "Slow ingestion performance"
```
Solution:
1. Check GitHub API response times
2. Verify database indexes exist
3. Monitor network latency
4. Consider reducing batch size
5. Check for database locks/contention
```

---

## Future Enhancements

1. **Incremental Updates**: Fetch only new events since last ingestion
2. **Parallel Processing**: Process multiple users concurrently
3. **Data Compression**: Compress raw_data JSONB for storage efficiency
4. **Archive Old Data**: Move old bronze data to cold storage
5. **Webhook Integration**: Real-time updates via GitHub webhooks
6. **Multi-Token Support**: Rotate between multiple tokens for higher rate limits
