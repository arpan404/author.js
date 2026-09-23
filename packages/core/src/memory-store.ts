import type {
  AuditEntry,
  AuthorStore,
  DeleteRelationInput,
  GetPermissionsInput,
  GetRelationsInput,
  GetRolesInput,
  HasPermissionInput,
  HasRelationInput,
  HasRoleInput,
  PermissionGrant,
  PermissionGrantInput,
  RelationTuple,
  RelationTupleInput,
  RevokePermissionInput,
  RevokeRoleInput,
  RoleGrant,
  RoleGrantInput,
} from "./types.js";

function id(): string {
  return crypto.randomUUID();
}

function sameOptional(left: string | undefined, right: string | undefined): boolean {
  return right === undefined || left === right;
}

function entityKey(type: string, entityId: string): string {
  return `${type.length}:${type}|${entityId.length}:${entityId}`;
}

function subjectKey(type: string | undefined, subjectId: string | undefined): string | null {
  if (type === undefined || subjectId === undefined) return null;
  return entityKey(type, subjectId);
}

/** In-memory store useful for tests, demos, and local development. */
export type MemoryStore = AuthorStore & {
  readonly roles: readonly RoleGrant[];
  readonly permissions: readonly PermissionGrant[];
  readonly relations: readonly RelationTuple[];
  readonly auditLogs: readonly AuditEntry[];
  hasRole(input: HasRoleInput): boolean;
  hasPermission(input: HasPermissionInput): boolean;
  hasRelation(input: HasRelationInput): boolean;
};

/**
 * Creates an in-memory AuthorStore.
 *
 * Data is process-local and cleared when the process exits.
 */
export function memoryStore(): MemoryStore {
  const roles: RoleGrant[] = [];
  const permissions: PermissionGrant[] = [];
  const relations: RelationTuple[] = [];
  const auditLogs: AuditEntry[] = [];
  const rolesByEntity = new Map<string, RoleGrant[]>();
  const permissionsByEntity = new Map<string, PermissionGrant[]>();
  const relationsBySubject = new Map<string, RelationTuple[]>();

  const roleBucket = (entityType: string, entityId: string) =>
    readBucket(rolesByEntity, entityKey(entityType, entityId));
  const permissionBucket = (entityType: string, entityId: string) =>
    readBucket(permissionsByEntity, entityKey(entityType, entityId));

  return {
    roles,
    permissions,
    relations,
    auditLogs,
    async getRoles(input: GetRolesInput) {
      return roleBucket(input.entityType, input.entityId).filter(
        (role) => sameOptional(role.scopeType, input.scopeType) && sameOptional(role.scopeId, input.scopeId),
      );
    },
    hasRole(input: HasRoleInput) {
      return roleBucket(input.entityType, input.entityId).some(
        (role) =>
          role.role === input.role &&
          sameOptional(role.scopeType, input.scopeType) &&
          sameOptional(role.scopeId, input.scopeId),
      );
    },
    async grantRole(input: RoleGrantInput) {
      const role = { ...input, id: id(), createdAt: new Date() };
      roles.push(role);
      writeBucket(rolesByEntity, entityKey(input.entityType, input.entityId)).push(role);
    },
    async revokeRole(input: RevokeRoleInput) {
      const matches = (role: RoleGrant) =>
        role.entityType === input.entityType &&
        role.entityId === input.entityId &&
        role.role === input.role &&
        role.scopeType === input.scopeType &&
        role.scopeId === input.scopeId;
      removeFirst(roles, matches);
      removeFirst(writeBucket(rolesByEntity, entityKey(input.entityType, input.entityId)), matches);
    },
    async getPermissions(input: GetPermissionsInput) {
      return permissionBucket(input.entityType, input.entityId).filter(
        (permission) =>
          sameOptional(permission.resourceType, input.resourceType) &&
          sameOptional(permission.resourceId, input.resourceId),
      );
    },
    hasPermission(input: HasPermissionInput) {
      const matches = (permission: PermissionGrant) =>
        permission.action === input.action &&
        sameOptional(permission.resourceType, input.resourceType) &&
        sameOptional(permission.resourceId, input.resourceId);
      const grants = permissionBucket(input.entityType, input.entityId);
      const deny = grants.some((permission) => matches(permission) && permission.effect === "deny");
      const allow = grants.some((permission) => matches(permission) && permission.effect === "allow");
      return !deny && allow;
    },
    async grantPermission(input: PermissionGrantInput) {
      const permission = { ...input, id: id(), createdAt: new Date() };
      permissions.push(permission);
      writeBucket(permissionsByEntity, entityKey(input.entityType, input.entityId)).push(permission);
    },
    async revokePermission(input: RevokePermissionInput) {
      const matches = (permission: PermissionGrant) =>
        permission.entityType === input.entityType &&
        permission.entityId === input.entityId &&
        permission.action === input.action &&
        permission.resourceType === input.resourceType &&
        permission.resourceId === input.resourceId &&
        permission.effect === input.effect;
      removeFirst(permissions, matches);
      removeFirst(writeBucket(permissionsByEntity, entityKey(input.entityType, input.entityId)), matches);
    },
    async getRelations(input: GetRelationsInput) {
      return relationCandidates(relations, relationsBySubject, input).filter((relation) =>
        matchesRelation(relation, input),
      );
    },
    hasRelation(input: HasRelationInput) {
      return relationCandidates(relations, relationsBySubject, input).some((relation) =>
        matchesRelation(relation, input),
      );
    },
    async createRelation(input: RelationTupleInput) {
      const exists = relationCandidates(relations, relationsBySubject, input).some(
        (relation) =>
          relation.subjectType === input.subjectType &&
          relation.subjectId === input.subjectId &&
          relation.relation === input.relation &&
          relation.objectType === input.objectType &&
          relation.objectId === input.objectId,
      );
      if (exists) return;
      const relation = { ...input, id: id(), createdAt: new Date() };
      relations.push(relation);
      const key = subjectKey(input.subjectType, input.subjectId);
      if (key) writeBucket(relationsBySubject, key).push(relation);
    },
    async deleteRelation(input: DeleteRelationInput) {
      const matches = (relation: RelationTuple) =>
        relation.subjectType === input.subjectType &&
        relation.subjectId === input.subjectId &&
        relation.relation === input.relation &&
        relation.objectType === input.objectType &&
        relation.objectId === input.objectId;
      removeFirst(relations, matches);
      const key = subjectKey(input.subjectType, input.subjectId);
      if (key) removeFirst(writeBucket(relationsBySubject, key), matches);
    },
    async writeAuditLog(entry: AuditEntry) {
      auditLogs.push(entry);
    },
  };
}

function readBucket<Value>(index: Map<string, Value[]>, key: string): readonly Value[] {
  return index.get(key) ?? [];
}

function writeBucket<Value>(index: Map<string, Value[]>, key: string): Value[] {
  const existing = index.get(key);
  if (existing) return existing;
  const created: Value[] = [];
  index.set(key, created);
  return created;
}

function removeFirst<Value>(items: Value[], matches: (item: Value) => boolean): void {
  const index = items.findIndex(matches);
  if (index >= 0) items.splice(index, 1);
}

function relationCandidates(
  relations: readonly RelationTuple[],
  relationsBySubject: Map<string, RelationTuple[]>,
  input: GetRelationsInput,
): readonly RelationTuple[] {
  const key = subjectKey(input.subjectType, input.subjectId);
  if (!key) return relations;
  return relationsBySubject.get(key) ?? [];
}

function matchesRelation(relation: RelationTuple, input: GetRelationsInput): boolean {
  return (
    sameOptional(relation.subjectType, input.subjectType) &&
    sameOptional(relation.subjectId, input.subjectId) &&
    sameOptional(relation.relation, input.relation) &&
    sameOptional(relation.objectType, input.objectType) &&
    sameOptional(relation.objectId, input.objectId)
  );
}
