import assert from "node:assert/strict";
import test from "node:test";

import { buildOssAuthorization, parseOssConfig } from "../../scripts/publish-oss.mjs";

test("OSS V1 signature matches an independently computed vector", () => {
  const { authorization, stringToSign } = buildOssAuthorization({
    accessKeyId: "test",
    accessKeySecret: "testsecret",
    method: "PUT",
    contentType: "application/octet-stream",
    date: "Thu, 15 Aug 2026 00:00:00 GMT",
    resource: "/bucket/path/latest.yml",
  });

  assert.equal(stringToSign, "PUT\n\napplication/octet-stream\nThu, 15 Aug 2026 00:00:00 GMT\n/bucket/path/latest.yml");
  assert.equal(authorization, "OSS test:wFeBKk/Q8sRkWCsg5HCDThPJnk4=");
});

test("OSS config parser derives bucket, prefix, and upload URL", () => {
  const config = parseOssConfig("https://shenzhen-agent.oss-cn-shenzhen.aliyuncs.com/updates");
  assert.equal(config.bucket, "shenzhen-agent");
  assert.equal(config.prefix, "updates");
  assert.equal(config.resourceFor("latest.yml"), "/shenzhen-agent/updates/latest.yml");
  assert.equal(
    config.uploadUrlFor("latest.yml"),
    "https://shenzhen-agent.oss-cn-shenzhen.aliyuncs.com/updates/latest.yml",
  );
});
