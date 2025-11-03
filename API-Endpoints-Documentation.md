This document provides detailed descriptions of the data flow and processing that occurs when requests enter the server.

## Table of Contents
- [Health Check](#health-check)
- [Pipeline Endpoints](#pipeline-endpoints)
  - [Full Pipeline Stats](#full-pipeline-stats)
  - [Analytics Report](#analytics-report)
  - [Remove Users](#remove-users)
  - [Add New Users](#add-new-users)
  - [List Users](#list-users)

---

## Health Check

### `GET /health`

**Purpose**: Simple endpoint to verify the server is running and responsive.

**Request Flow**:
1. Client sends GET request to `/health`
2. Server's `AppController` receives the request
3. Returns a simple status response

**Response**: 
```json
{
  "status": "ok",
  "timestamp": "2025-11-03T10:00:00.000Z"
}
```

**Use Case**: Load balancers, monitoring tools, or deployment scripts use this to verify service availability.

---

## Pipeline Endpoints

All pipeline endpoints are prefixed with `/pipeline` and are handled by the `PipelineController`.

### Full Pipeline Stats

#### `POST /pipeline/stats`

**Purpose**: Executes the complete data pipeline for specified GitHub users, processing from raw data collection through to analytics-ready data.

**Request Body**:
```json
{
  "usernames": ["user1", "user2", "user3"]
}
```

**Detailed Data Flow**:

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. REQUEST VALIDATION                                           │
│    - Validates usernames array (class-validator)                │
│    - Ensures proper format and non-empty values                 │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. BRONZE LAYER: RAW DATA COLLECTION                            │
│    - RawService.ingestUsers(usernames)                          │
│    - For each username:                                         │
│      • Fetches last 6 months of GitHub events via GitHub API    │
│      • Stores raw JSON in bronze.github_events                  │
│      • Extracts user info → bronze.github_users                 │
│      • Extracts repo info → bronze.github_repos                 │
│    - Data stored as-is (JSONB format)                           │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 3. SILVER LAYER: DATA NORMALIZATION                             │
│    - NormalizedOrchestrator.processUsers(usernames)             │
│    - Parallel Processing for Each Data Type:                    │
│                                                                  │
│      A. User Processing (UserService)                           │
│         • Extracts user metadata from bronze.github_users       │
│         • Creates normalized user records                       │
│         • Stores in silver.users table                          │
│                                                                  │
│      B. Repository Processing (RepoService)                     │
│         • Extracts repository data from bronze.github_repos     │
│         • Filters repos with fork_count >= 3                    │
│         • Normalizes repo metadata                              │
│         • Stores in silver.repositories table                   │
│                                                                  │
│      C. Commit Processing (CommitService)                       │
│         • Parses PushEvent from bronze.github_events            │
│         • Extracts commit details (SHA, message, author)        │
│         • Links commits to repositories                         │
│         • Stores in silver.commits table                        │
│                                                                  │
│      D. Pull Request Processing (PrService)                     │
│         • Parses PullRequestEvent from bronze events            │
│         • Extracts PR metadata (title, state, dates)            │
│         • Links PRs to repositories                             │
│         • Stores in silver.pull_requests table                  │
│                                                                  │
│      E. Issue Processing (IssueService)                         │
│         • Parses IssuesEvent from bronze events                 │
│         • Extracts issue details                                │
│         • Links issues to repositories                          │
│         • Stores in silver.issues table                         │
│                                                                  │
│      F. Comment Processing (CommentService)                     │
│         • Parses IssueCommentEvent & PullRequestReviewComment   │
│         • Extracts comment text and metadata                    │
│         • Links to parent issues/PRs                            │
│         • Stores in silver.comments table                       │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 4. GOLD LAYER: ANALYTICS AGGREGATION                            │
│    - AnalyticsService.processUsers(usernames)                   │
│    - For each user:                                             │
│                                                                  │
│      A. User Profile Creation (gold.user_profile)               │
│         • Aggregates user statistics                            │
│         • Calculates total contributions                        │
│         • Computes engagement metrics                           │
│                                                                  │
│      B. Repository Aggregation (gold.repository)                │
│         • Groups user activity by repository                    │
│         • Calculates per-repo contribution counts               │
│         • Includes only repos with fork_count >= 3              │
│                                                                  │
│      C. Activity Timeline (gold.user_activity)                  │
│         • Creates daily/weekly activity summaries               │
│         • Aggregates contributions by time period               │
│         • Tracks activity trends                                │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 5. RESPONSE GENERATION                                          │
│    - Collects processing statistics                             │
│    - Returns summary of processed data                          │
└─────────────────────────────────────────────────────────────────┘
```

**Response Example**:
```json
{
  "success": true,
  "usersProcessed": 3,
  "stats": {
    "rawEvents": 1250,
    "normalizedRecords": {
      "commits": 450,
      "pullRequests": 89,
      "issues": 67,
      "comments": 234
    },
    "analyticsRecords": {
      "userProfiles": 3,
      "repositories": 45,
      "activityEntries": 180
    }
  }
}
```

**Error Handling**:
- Returns 400 if usernames array is invalid
- Returns 500 if GitHub API fails
- Returns 503 if database is unavailable
- Partial failures are logged but don't stop the entire process

---

### Analytics Report

#### `POST /pipeline/analytics/report`

**Purpose**: Generates a frontend-ready analytics report from already-processed normalized data (last 180 days, repositories with fork_count >= 3).

**Request Body**:
```json
{
  "usernames": ["user1", "user2"]
}
```

**Detailed Data Flow**:

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. REQUEST VALIDATION                                           │
│    - Validates usernames array                                  │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. DATA RETRIEVAL FROM SILVER LAYER                             │
│    - AnalyticsReportService.generateReport(usernames)           │
│    - Queries silver.* tables with filters:                      │
│      • Date range: Last 180 days                                │
│      • Repository filter: fork_count >= 3                       │
│      • User filter: Specified usernames                         │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 3. DATA AGGREGATION                                             │
│    For each user:                                               │
│                                                                  │
│      A. Activity Summary                                        │
│         • Count commits by repository                           │
│         • Count PRs (opened, merged, closed)                    │
│         • Count issues (opened, closed)                         │
│         • Count comments on PRs and issues                      │
│                                                                  │
│      B. Repository Ranking                                      │
│         • Rank repositories by contribution count               │
│         • Include only repos with fork_count >= 3               │
│         • Calculate contribution percentage per repo            │
│                                                                  │
│      C. Timeline Analysis                                       │
│         • Group activity by week/month                          │
│         • Identify activity patterns                            │
│         • Calculate streak data                                 │
│                                                                  │
│      D. Engagement Metrics                                      │
│         • Calculate PR review participation                     │
│         • Measure comment engagement rate                       │
│         • Compute collaboration score                           │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 4. REPORT FORMATTING                                            │
│    - Structures data for frontend consumption                   │
│    - Sorts repositories by activity                             │
│    - Formats dates and numbers                                  │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 5. RESPONSE GENERATION                                          │
│    - Returns formatted analytics report                         │
└─────────────────────────────────────────────────────────────────┘
```

**Response Example**:
```json
{
  "users": [
    {
      "username": "user1",
      "totalContributions": 523,
      "breakdown": {
        "commits": 350,
        "pullRequests": 89,
        "issues": 34,
        "comments": 50
      },
      "topRepositories": [
        {
          "name": "awesome-project",
          "owner": "organization",
          "contributions": 145,
          "forkCount": 450
        }
      ],
      "activityTimeline": [
        {
          "week": "2025-W44",
          "commits": 25,
          "prs": 5,
          "issues": 2
        }
      ]
    }
  ],
  "generatedAt": "2025-11-03T10:00:00.000Z"
}
```

**Performance Considerations**:
- Uses database indexes on username and created_at fields
- Implements query result caching for frequently accessed reports
- Aggregations done at database level for efficiency

---

### Remove Users

#### `POST /pipeline/removeUsers`

**Purpose**: Completely removes users and all their associated data from all database tables across all three layers (Bronze, Silver, Gold).

**Request Body**:
```json
{
  "usernames": ["user1", "user2"]
}
```

**Detailed Data Flow**:

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. REQUEST VALIDATION                                           │
│    - Validates usernames array                                  │
│    - Checks for empty or malformed input                        │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. DATABASE TRANSACTION INITIATION                              │
│    - Starts a database transaction for atomicity                │
│    - Ensures all-or-nothing deletion                            │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 3. GOLD LAYER CLEANUP                                           │
│    - Delete from gold.user_activity                             │
│    - Delete from gold.repository (user-owned entries)           │
│    - Delete from gold.user_profile                              │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 4. SILVER LAYER CLEANUP                                         │
│    - Delete from silver.comments (cascade to related records)   │
│    - Delete from silver.pull_requests                           │
│    - Delete from silver.issues                                  │
│    - Delete from silver.commits                                 │
│    - Delete from silver.repositories (user-owned)               │
│    - Delete from silver.users                                   │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 5. BRONZE LAYER CLEANUP                                         │
│    - Delete from bronze.github_events                           │
│    - Delete from bronze.github_repos (user-owned)               │
│    - Delete from bronze.github_users                            │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 6. PROCESSING QUEUE CLEANUP                                     │
│    - Remove from processing_queue table                         │
│    - Clear any pending processing tasks                         │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 7. TRANSACTION COMMIT                                           │
│    - Commits the transaction if all deletions succeed           │
│    - Rolls back if any deletion fails                           │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 8. RESPONSE GENERATION                                          │
│    - Returns deletion summary                                   │
└─────────────────────────────────────────────────────────────────┘
```

**Response Example**:
```json
{
  "success": true,
  "usersRemoved": 2,
  "deletedRecords": {
    "goldLayer": 245,
    "silverLayer": 1523,
    "bronzeLayer": 2456
  },
  "message": "Users and all associated data removed successfully"
}
```

**Important Notes**:
- **Irreversible Operation**: Data cannot be recovered after deletion
- **Cascading Deletes**: Uses database foreign key constraints to ensure referential integrity
- **Transaction Safety**: All deletions happen within a transaction
- **Audit Trail**: Deletion is logged for compliance purposes

---

### Add New Users

#### `POST /pipeline/addNewUsers`

**Purpose**: Adds new GitHub users to the system with asynchronous processing of their last 6 months of activity data.

**Request Body**:
```json
{
  "usernames": ["newuser1", "newuser2"]
}
```

**Detailed Data Flow**:

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. REQUEST VALIDATION                                           │
│    - Validates usernames array                                  │
│    - Checks for duplicate usernames                             │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. USER EXISTENCE CHECK                                         │
│    - Queries bronze.github_users                                │
│    - Filters out users already in the system                    │
│    - Prepares list of truly new users                           │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 3. PROCESSING QUEUE REGISTRATION                                │
│    - For each new user:                                         │
│      • Creates entry in processing_queue table                  │
│      • Sets status = 'pending'                                  │
│      • Records timestamp and metadata                           │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 4. IMMEDIATE RESPONSE                                           │
│    - Returns 202 Accepted status                                │
│    - Provides queue ID for tracking                             │
│    - Processing continues asynchronously                        │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 5. ASYNCHRONOUS PROCESSING (Background)                         │
│    For each queued user:                                        │
│                                                                  │
│    A. Status Update: 'processing'                               │
│       • Updates processing_queue.status                         │
│                                                                  │
│    B. Bronze Layer: Data Collection                             │
│       • Calls GitHub API for user events (last 6 months)        │
│       • Stores raw data in bronze.github_events                 │
│       • Rate limit handling and retry logic                     │
│       • Error logging and recovery                              │
│                                                                  │
│    C. Silver Layer: Normalization                               │
│       • Processes raw events into structured data               │
│       • Creates records in silver.* tables                      │
│       • Handles data validation and cleaning                    │
│                                                                  │
│    D. Gold Layer: Analytics                                     │
│       • Aggregates normalized data                              │
│       • Creates user profile and activity records               │
│       • Calculates initial metrics                              │
│                                                                  │
│    E. Status Update: 'completed' or 'failed'                    │
│       • Updates processing_queue with final status              │
│       • Records completion timestamp                            │
│       • Logs any errors encountered                             │
└─────────────────────────────────────────────────────────────────┘
```

**Immediate Response (202 Accepted)**:
```json
{
  "success": true,
  "message": "Users queued for processing",
  "queuedUsers": ["newuser1", "newuser2"],
  "queueIds": ["uuid-1", "uuid-2"],
  "statusCheckUrl": "/pipeline/listUsers"
}
```

**Processing States**:
1. **pending**: User is in queue, waiting for processing
2. **processing**: Data collection and processing is in progress
3. **completed**: All layers successfully processed
4. **failed**: An error occurred during processing

**Rate Limiting**:
- GitHub API has rate limits (5000 requests/hour for authenticated)
- Queue processing respects rate limits
- Failed requests are retried with exponential backoff

**Error Handling**:
- Individual user failures don't affect others
- Partial data is rolled back on failure
- Detailed error messages stored in processing_queue
- Failed users can be retried manually

---

### List Users

#### `GET /pipeline/listUsers`

**Purpose**: Retrieves all users in the system grouped by their current processing status.

**Request**: No body required (GET request)

**Detailed Data Flow**:

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. REQUEST RECEIVED                                             │
│    - No parameters required                                     │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. DATABASE QUERY                                               │
│    - Queries processing_queue table                             │
│    - Joins with bronze.github_users for user details            │
│    - Orders by processing timestamp (newest first)              │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 3. DATA GROUPING                                                │
│    - Groups users by status field                               │
│    - Categories:                                                │
│      • pending: Users waiting to be processed                   │
│      • processing: Currently being processed                    │
│      • completed: Successfully processed                        │
│      • failed: Processing encountered errors                    │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 4. METADATA ENRICHMENT                                          │
│    For each user:                                               │
│      • Adds processing timestamps                               │
│      • Includes error messages (if failed)                      │
│      • Adds data availability indicators                        │
│      • Calculates processing duration                           │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 5. RESPONSE FORMATTING                                          │
│    - Structures data by status groups                           │
│    - Includes summary statistics                                │
└─────────────────────────────────────────────────────────────────┘
```

**Response Example**:
```json
{
  "totalUsers": 15,
  "summary": {
    "pending": 2,
    "processing": 1,
    "completed": 10,
    "failed": 2
  },
  "users": {
    "pending": [
      {
        "username": "newuser1",
        "queuedAt": "2025-11-03T09:45:00.000Z",
        "queueId": "uuid-1"
      }
    ],
    "processing": [
      {
        "username": "newuser2",
        "startedAt": "2025-11-03T09:50:00.000Z",
        "queueId": "uuid-2",
        "progress": "bronze_layer_complete"
      }
    ],
    "completed": [
      {
        "username": "user1",
        "completedAt": "2025-11-03T08:30:00.000Z",
        "processingDuration": "2m 34s",
        "dataLayers": ["bronze", "silver", "gold"]
      }
    ],
    "failed": [
      {
        "username": "faileduser",
        "failedAt": "2025-11-03T07:15:00.000Z",
        "error": "GitHub API rate limit exceeded",
        "retryable": true
      }
    ]
  }
}
```

**Use Cases**:
- **Monitoring**: Check processing status of recently added users
- **Debugging**: Identify users with failed processing
- **Administration**: Get overview of all users in the system
- **Frontend**: Display user list with processing indicators

**Performance Considerations**:
- Query is indexed on status and timestamp fields
- Results can be paginated for large user bases (add pagination parameters if needed)
- Cached for 30 seconds to reduce database load

---

## Common Error Responses

All endpoints may return these common error responses:

### 400 Bad Request
```json
{
  "statusCode": 400,
  "message": ["usernames must be an array", "usernames should not be empty"],
  "error": "Bad Request"
}
```

### 401 Unauthorized
```json
{
  "statusCode": 401,
  "message": "Invalid API key",
  "error": "Unauthorized"
}
```

### 500 Internal Server Error
```json
{
  "statusCode": 500,
  "message": "An unexpected error occurred",
  "error": "Internal Server Error"
}
```

### 503 Service Unavailable
```json
{
  "statusCode": 503,
  "message": "Database connection failed",
  "error": "Service Unavailable"
}
```

---

## Authentication

All pipeline endpoints require API key authentication via the `X-API-Key` header:

```bash
curl -X POST http://localhost:3000/pipeline/stats \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key-here" \
  -d '{"usernames": ["user1"]}'
```

---

## Rate Limiting

- **GitHub API**: 5000 requests/hour (authenticated)
- **Internal API**: No explicit rate limiting (consider adding if needed)
- **Recommendation**: Space out large batch requests to avoid overwhelming the system

---

## Best Practices

1. **Use `/pipeline/addNewUsers` for new users**: Don't use `/pipeline/stats` for initial user addition
2. **Monitor with `/pipeline/listUsers`**: Check processing status before generating reports
3. **Batch requests**: Process multiple users in a single request when possible
4. **Error recovery**: Check failed users in `/pipeline/listUsers` and retry if needed
5. **Data cleanup**: Use `/pipeline/removeUsers` to remove stale or test data
