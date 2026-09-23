CREATE TABLE author_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  role TEXT NOT NULL,
  scope_type TEXT,
  scope_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX author_roles_entity_idx ON author_roles (entity_type, entity_id);
CREATE INDEX author_roles_scope_idx ON author_roles (scope_type, scope_id);
CREATE INDEX author_roles_lookup_idx ON author_roles (entity_type, entity_id, role, scope_type, scope_id);

CREATE TABLE author_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX author_permissions_entity_idx ON author_permissions (entity_type, entity_id);
CREATE INDEX author_permissions_resource_idx ON author_permissions (resource_type, resource_id);
CREATE INDEX author_permissions_lookup_idx ON author_permissions (entity_type, entity_id, action, resource_type, resource_id, effect);

CREATE TABLE author_relations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX author_relations_subject_idx ON author_relations (subject_type, subject_id);
CREATE INDEX author_relations_object_idx ON author_relations (object_type, object_id);
CREATE UNIQUE INDEX author_relations_unique_idx ON author_relations (subject_type, subject_id, relation, object_type, object_id);

CREATE TABLE author_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  allowed BOOLEAN NOT NULL,
  reason TEXT NOT NULL,
  matched_policies JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX author_audit_logs_entity_idx ON author_audit_logs (entity_type, entity_id);
CREATE INDEX author_audit_logs_resource_idx ON author_audit_logs (resource_type, resource_id);
CREATE INDEX author_audit_logs_created_at_idx ON author_audit_logs (created_at);
