# SQLite vs PostgreSQL for Plugin State Management in CLI Tools

## Architectural Context

Plugin state management in CLI tools requires careful trade-off analysis between deployment simplicity, scalability, and operational burden. This analysis compares SQLite and PostgreSQL for tools like Claude Code plugins that manage pipeline verification state, session artifacts, and agent metadata.

## Key Trade-Offs

### Deployment & Operational Burden

**SQLite (File-Based)**
- Zero external dependencies — embedded in-process or embedded in CLI binary
- No server setup, authentication, or networking required
- Database lives in user's project/home directory — transparent, portable, inspectable
- Ideal for single-user dev tooling, plugin distribution, offline-first workflows

**PostgreSQL (Server-Based)**
- Requires separate database server installation and management
- Network connectivity, authentication, and schema migrations
- Suitable for multi-user systems, CI/CD platforms, or shared state across deployments
- Operational overhead: monitoring, backups, high-availability setup

**Winner for CLI plugins**: SQLite — eliminates friction for end-user adoption

### Concurrency & Reliability

**SQLite**
- Single-writer, multi-reader model — adequate for sequential CLI operations
- File-level locking prevents true concurrent writes
- ACID guarantees at filesystem level (journaling)
- Weak point: concurrent writes from multiple processes block or fail

**PostgreSQL**
- Full multi-writer concurrency with row-level locking
- MVCC (multi-version concurrency control) allows readers and writers to coexist
- Transactions serialize reliably across distributed agents/sessions
- Backup and recovery infrastructure built-in

**Trade-off**: SQLite suffices for single-user CLI tools; PostgreSQL needed for concurrent multi-agent systems or cloud deployments

### Schema Evolution & Complexity

**SQLite**
- Schema changes are straightforward but require downtime migration
- ALTER TABLE limited — some changes force table recreation
- Simple schema works well; complex relational logic gets clunky
- Easier to ship schema changes in plugin updates

**PostgreSQL**
- Rich data types, constraints, and procedural capabilities
- ALTER TABLE more flexible — can add/drop columns without recreation
- Schema versioning and migration tooling mature (Flyway, Liquibase)
- Complex queries, stored procedures, and window functions available

**Trade-off**: SQLite forces simpler schemas; PostgreSQL enables richer models but adds schema management complexity

### State Volume & Query Performance

**SQLite**
- Performance degrades past 10GB–100GB depending on indices
- Single-threaded query execution
- Sufficient for bounded session state and pipeline metadata
- Slow for analytics or large result sets

**PostgreSQL**
- Handles terabytes efficiently
- Parallel query execution and query planner optimization
- Complex analytical queries, aggregations, and joins scale well
- Better for systems storing unbounded audit trails or multi-tenant data

**Trade-off**: For plugin state (typically <1GB per user), SQLite is plenty; PostgreSQL unnecessary unless storing historical analytics

### Availability & Resilience

**SQLite**
- Database file is part of user's project — version controlled or backed up naturally
- Corrupted file loses state but doesn't affect system
- No single point of failure
- Restore = copy database file

**PostgreSQL**
- Requires backup/restore strategy, point-in-time recovery
- Server outage blocks all clients
- Data loss requires disaster recovery
- Complex HA setup needed for critical systems

**Trade-off**: SQLite is more resilient for distributed CLI use; PostgreSQL better for centralized services

## Recommendation

**Use SQLite for Claude Code plugins** — the tool manages per-user, per-session state that:
1. Lives in user's workspace (not shared)
2. Is ephemeral or regenerable (not critical production data)
3. Benefits from zero operational overhead
4. Must work offline or without server setup

**Migrate to PostgreSQL only if**:
- Multiple agents/processes need concurrent reads/writes on shared state
- State grows beyond SQLite's practical limits (100GB+)
- Operational burden is justified by multi-user or cloud deployment model
- Analytics or complex querying becomes primary use case

## Implementation Pattern

For CLI tools, use SQLite as the default with a migration path:
- Store connection details in config file (SQLite path or PostgreSQL DSN)
- Implement repository layer that abstracts database backend
- Test both backends in CI, but ship with SQLite as default
- Document PostgreSQL setup for advanced users only

This mirrors the approach in `claude-gates`: SQLite embedded in `.sessions/` directory, transparent to end users, zero operational burden.
