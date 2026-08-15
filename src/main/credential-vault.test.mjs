import assert from "node:assert/strict";
import test from "node:test";
import { projectIdentityCredentialKey, validateCredentialKey, zentaoTokenCredentialKey } from "./credential-key.ts";

test("credential vault accepts only Main-owned device, identity and ZenTao keys", () => {
  assert.equal(validateCredentialKey("device:license:identity"), "device:license:identity");
  assert.equal(projectIdentityCredentialKey("project-one", "operator"), "test:project:project-one:identity:operator");
  assert.equal(
    validateCredentialKey("test:project:project-one:identity:operator"),
    "test:project:project-one:identity:operator",
  );
  assert.equal(zentaoTokenCredentialKey("company-zentao"), "test:zentao:company-zentao:token");
  assert.equal(validateCredentialKey("test:zentao:company-zentao:token"), "test:zentao:company-zentao:token");
  for (const invalid of [
    "channel:feishu:account-one",
    "test:project:../escape:identity:operator",
    "test:project:project-one:identity:operator:password",
    "test:zentao:../escape:token",
    "test:zentao:company-zentao:password",
    "",
  ]) {
    assert.throws(() => validateCredentialKey(invalid), /Invalid credential key/);
  }
});
