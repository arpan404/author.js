import { Pool } from "pg";
import type {
  AuthorStore,
  GetPermissionsInput,
  GetRelationsInput,
  GetRolesInput,
  HasPermissionInput,
  HasRelationInput,
  HasRoleInput,
  PermissionGrant,
  PolicyEffect,
  RelationTuple,
  RoleGrant,
} from "../../core/src/index.js";

/** Minimal pg-compatible client interface used by the PostgreSQL adapter. */
export type PostgresClient = {
  query(sql: string, values?: readonly unknown[]): Promise<{ rows: readonly unknown[] }>;
};

/** PostgreSQL adapter configuration. Pass either a pg-compatible client or a connection string. */
export type PostgresStoreInput = { client: PostgresClient } | { connectionString: string };

/** Creates an AuthorStore backed by PostgreSQL tables from `schema.sql`. */
export function postgresStore(input: PostgresStoreInput): AuthorStore {
  const db: PostgresClient = "client" in input ? input.client : new Pool({ connectionString: input.connectionString });
  return {
    getRoles: (query) => getRoles(db, query),
    hasRole: (query) => hasRole(db, query),
    grantRole: (role) =>
      exec(
        db,
        `INSERT INTO author_roles (id, entity_type, entity_id, role, scope_type, scope_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          crypto.randomUUID(),
          role.entityType,
          role.entityId,
          role.role,
          role.scopeType ?? null,
          role.scopeId ?? null,
          new Date(),
        ],
      ),
    revokeRole: (role) =>
      exec(
        db,
        `DELETE FROM author_roles WHERE entity_type = $1 AND entity_id = $2 AND role = $3 AND scope_type IS NOT DISTINCT FROM $4 AND scope_id IS NOT DISTINCT FROM $5`,
        [role.entityType, role.entityId, role.role, role.scopeType ?? null, role.scopeId ?? null],
      ),
    getPermissions: (query) => getPermissions(db, query),
    hasPermission: (query) => hasPermission(db, query),
    grantPermission: (permission) =>
      exec(
        db,
        `INSERT INTO author_permissions (id, entity_type, entity_id, action, resource_type, resource_id, effect, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          crypto.randomUUID(),
          permission.entityType,
          permission.entityId,
          permission.action,
          permission.resourceType,
          permission.resourceId ?? null,
          permission.effect,
          new Date(),
        ],
      ),
    revokePermission: (permission) =>
      exec(
        db,
        `DELETE FROM author_permissions WHERE entity_type = $1 AND entity_id = $2 AND action = $3 AND resource_type = $4 AND resource_id IS NOT DISTINCT FROM $5 AND effect = $6`,
        [
          permission.entityType,
          permission.entityId,
          permission.action,
          permission.resourceType,
          permission.resourceId ?? null,
          permission.effect,
        ],
      ),
    getRelations: (query) => getRelations(db, query),
    hasRelation: (query) => hasRelation(db, query),
    createRelation: (relation) =>
      exec(
        db,
        `INSERT INTO author_relations (id, subject_type, subject_id, relation, object_type, object_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
        [
          crypto.randomUUID(),
          relation.subjectType,
          relation.subjectId,
          relation.relation,
          relation.objectType,
          relation.objectId,
          new Date(),
        ],
      ),
    deleteRelation: (relation) =>
      exec(
        db,
        `DELETE FROM author_relations WHERE subject_type = $1 AND subject_id = $2 AND relation = $3 AND object_type = $4 AND object_id = $5`,
        [relation.subjectType, relation.subjectId, relation.relation, relation.objectType, relation.objectId],
      ),
    writeAuditLog: (entry) =>
      exec(
        db,
        `INSERT INTO author_audit_logs (id, entity_type, entity_id, action, resource_type, resource_id, allowed, reason, matched_policies, metadata, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          entry.id,
          entry.entityType,
          entry.entityId,
          entry.action,
          entry.resourceType,
          entry.resourceId,
          entry.allowed,
          entry.reason,
          JSON.stringify(entry.matchedPolicies),
          JSON.stringify(entry.metadata ?? {}),
          entry.createdAt,
        ],
      ),
  };
}

async function exec(db: PostgresClient, sql: string, values: readonly unknown[]): Promise<void> {
  await db.query(sql, values);
}

async function getRoles(db: PostgresClient, input: GetRolesInput): Promise<RoleGrant[]> {
  const where = equals([
    ["entity_type", input.entityType],
    ["entity_id", input.entityId],
    ["scope_type", input.scopeType],
    ["scope_id", input.scopeId],
  ]);
  const result = await db.query(
    `SELECT id, entity_type, entity_id, role, scope_type, scope_id, created_at FROM author_roles WHERE ${where.sql}`,
    where.values,
  );
  return result.rows.map(readRole).filter(isPresent);
}

async function hasRole(db: PostgresClient, input: HasRoleInput): Promise<boolean> {
  const where = equals([
    ["entity_type", input.entityType],
    ["entity_id", input.entityId],
    ["role", input.role],
    ["scope_type", input.scopeType],
    ["scope_id", input.scopeId],
  ]);
  const result = await db.query(`SELECT 1 FROM author_roles WHERE ${where.sql} LIMIT 1`, where.values);
  return result.rows.length > 0;
}

async function getPermissions(db: PostgresClient, input: GetPermissionsInput): Promise<PermissionGrant[]> {
  const where = equals([
    ["entity_type", input.entityType],
    ["entity_id", input.entityId],
    ["resource_type", input.resourceType],
    ["resource_id", input.resourceId],
  ]);
  const result = await db.query(
    `SELECT id, entity_type, entity_id, action, resource_type, resource_id, effect, created_at FROM author_permissions WHERE ${where.sql}`,
    where.values,
  );
  return result.rows.map(readPermission).filter(isPresent);
}

async function hasPermission(db: PostgresClient, input: HasPermissionInput): Promise<boolean> {
  const where = equals([
    ["entity_type", input.entityType],
    ["entity_id", input.entityId],
    ["action", input.action],
    ["resource_type", input.resourceType],
    ["resource_id", input.resourceId],
  ]);
  const result = await db.query(
    `SELECT COALESCE(BOOL_OR(effect = 'deny'), false) AS has_deny, COALESCE(BOOL_OR(effect = 'allow'), false) AS has_allow FROM author_permissions WHERE ${where.sql}`,
    where.values,
  );
  const row = result.rows[0];
  return isRecord(row) && !isTrue(row.has_deny) && isTrue(row.has_allow);
}

async function getRelations(db: PostgresClient, input: GetRelationsInput): Promise<RelationTuple[]> {
  const where = equals([
    ["subject_type", input.subjectType],
    ["subject_id", input.subjectId],
    ["relation", input.relation],
    ["object_type", input.objectType],
    ["object_id", input.objectId],
  ]);
  const result = await db.query(
    `SELECT id, subject_type, subject_id, relation, object_type, object_id, created_at FROM author_relations WHERE ${where.sql}`,
    where.values,
  );
  return result.rows.map(readRelation).filter(isPresent);
}

async function hasRelation(db: PostgresClient, input: HasRelationInput): Promise<boolean> {
  const where = equals([
    ["subject_type", input.subjectType],
    ["subject_id", input.subjectId],
    ["relation", input.relation],
    ["object_type", input.objectType],
    ["object_id", input.objectId],
  ]);
  const result = await db.query(`SELECT 1 FROM author_relations WHERE ${where.sql} LIMIT 1`, where.values);
  return result.rows.length > 0;
}

function equals(filters: readonly (readonly [string, string | undefined])[]): { sql: string; values: string[] } {
  const values: string[] = [];
  const clauses: string[] = [];
  for (const [column, value] of filters) {
    if (value === undefined) continue;
    values.push(value);
    clauses.push(`${column} = $${values.length}`);
  }
  return { sql: clauses.length === 0 ? "TRUE" : clauses.join(" AND "), values };
}

function isTrue(value: unknown): boolean {
  return value === true;
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

function readRole(row: unknown): RoleGrant | null {
  if (!isRecord(row)) return null;
  const id = stringAt(row, "id");
  const entityType = stringAt(row, "entity_type");
  const entityId = stringAt(row, "entity_id");
  const role = stringAt(row, "role");
  const createdAt = dateAt(row, "created_at");
  if (!id || !entityType || !entityId || !role || !createdAt) return null;
  return optional(
    { id, entityType, entityId, role, createdAt },
    "scopeType",
    stringAt(row, "scope_type"),
    "scopeId",
    stringAt(row, "scope_id"),
  );
}

function readPermission(row: unknown): PermissionGrant | null {
  if (!isRecord(row)) return null;
  const id = stringAt(row, "id");
  const entityType = stringAt(row, "entity_type");
  const entityId = stringAt(row, "entity_id");
  const action = stringAt(row, "action");
  const resourceType = stringAt(row, "resource_type");
  const effect = effectAt(row, "effect");
  const createdAt = dateAt(row, "created_at");
  if (!id || !entityType || !entityId || !action || !resourceType || !effect || !createdAt) return null;
  return optional(
    { id, entityType, entityId, action, resourceType, effect, createdAt },
    "resourceId",
    stringAt(row, "resource_id"),
  );
}

function readRelation(row: unknown): RelationTuple | null {
  if (!isRecord(row)) return null;
  const id = stringAt(row, "id");
  const subjectType = stringAt(row, "subject_type");
  const subjectId = stringAt(row, "subject_id");
  const relation = stringAt(row, "relation");
  const objectType = stringAt(row, "object_type");
  const objectId = stringAt(row, "object_id");
  const createdAt = dateAt(row, "created_at");
  return id && subjectType && subjectId && relation && objectType && objectId && createdAt
    ? { id, subjectType, subjectId, relation, objectType, objectId, createdAt }
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringAt(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" ? value : undefined;
}

function effectAt(row: Record<string, unknown>, key: string): PolicyEffect | undefined {
  const value = row[key];
  return value === "allow" || value === "deny" ? value : undefined;
}

function dateAt(row: Record<string, unknown>, key: string): Date | undefined {
  const value = row[key];
  if (value instanceof Date) return value;
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function optional<T extends object, K1 extends string, K2 extends string>(
  base: T,
  key: K1,
  value: string | undefined,
  key2?: K2,
  value2?: string | undefined,
): T & Partial<Record<K1 | K2, string>> {
  return {
    ...base,
    ...(value === undefined ? {} : { [key]: value }),
    ...(key2 === undefined || value2 === undefined ? {} : { [key2]: value2 }),
  };
}
