const PROJECT_ID = /^[a-z][a-z0-9-]{1,63}$/;
const IDENTITY_ID = /^[a-z][a-z0-9-]{0,63}$/;

export function projectIdentityCredentialKey(projectId: string, identityId: string): string {
  if (!PROJECT_ID.test(projectId) || !IDENTITY_ID.test(identityId)) throw new Error("Invalid credential identity");
  return `test:project:${projectId}:identity:${identityId}`;
}

export function zentaoTokenCredentialKey(connectionId: string): string {
  if (!PROJECT_ID.test(connectionId)) throw new Error("Invalid ZenTao connection");
  return `test:zentao:${connectionId}:token`;
}

export function validateCredentialKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed === "device:license:identity") return trimmed;
  const zentao = /^test:zentao:([^:]+):token$/.exec(trimmed);
  if (zentao) {
    try {
      if (zentaoTokenCredentialKey(zentao[1]) !== trimmed) throw new Error();
    } catch {
      throw new Error("Invalid credential key");
    }
    return trimmed;
  }
  const match = /^test:project:([^:]+):identity:([^:]+)$/.exec(trimmed);
  if (!match) throw new Error("Invalid credential key");
  try {
    if (projectIdentityCredentialKey(match[1], match[2]) !== trimmed) throw new Error();
  } catch {
    throw new Error("Invalid credential key");
  }
  return trimmed;
}
