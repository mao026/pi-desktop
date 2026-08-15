# Device License Operations

## Fixed Public Configuration

The desktop build is fixed to:

```text
baseUrl=https://shenzhen-agent.oss-cn-shenzhen.aliyuncs.com/
publicKey=MCowBQYDK2VwAyEArlgfFl3vIySNqW2Gdj6Un/SX25Wc2aL/Iy8MfLVaEmE=
```

The same values live in `config/device-license-public.json` and are embedded into Main at build time. Runtime environment variables cannot replace this trust root.

The private Ed25519 signing key exists only on this management machine:

```text
/Users/m/.pi-test-license-authority/license-ed25519-private.pem
```

Do not upload, copy into the repository, or add this private key to CI. Back it up to an encrypted offline location. Losing it prevents issuing or revoking licenses accepted by already-built clients.

## Issue An Active License

1. In the app, open `设备授权` and copy the full 64-character `设备标识`.
2. Run:

```bash
cd /Users/m/workSpace/pi-desktop
npm run license:make -- <64位小写设备标识> --license-id lic-YYYYMMDD-001
```

The wrapper uses the management-machine private key, writes to `/Users/m/Desktop/pi-test-license-upload`, verifies the generated signature against the public build configuration, and prints the generated file path. Upload that exact signed JSON as:

```text
licenses/<64位小写设备标识>.json
```

Its public URL will be:

```text
https://shenzhen-agent.oss-cn-shenzhen.aliyuncs.com/licenses/<64位小写设备标识>.json
```

Set the object to public read and `Cache-Control: no-cache`. Then click `重新检查授权` in the app.

The minimum desktop version defaults to the current `package.json` version (`0.1.7`). Pass `--minimum-version x.y.z` only when intentionally requiring a newer client.

## Revoke A License

Generate a signed revoked object and overwrite the same OSS path:

```bash
cd /Users/m/workSpace/pi-desktop
npm run license:make -- <64位小写设备标识> --license-id lic-YYYYMMDD-001 --revoked
```

Do not revoke by deleting the object. A signed `revoked` object distinguishes revocation from a network or OSS failure.

## JSON Template

See `docs/device-license.template.json` for the field shape. The template itself is not uploadable. The signature covers every field except `signature`, so editing any generated field invalidates the file. Always upload output from `scripts/issue-device-license.mjs`.

## OSS Requirements

- HTTPS only and no redirects.
- Exact license objects are public read; directory listing remains disabled.
- Set `Cache-Control: no-cache` on every license object.
- Do not place OSS write credentials in the desktop app or build.
- Never upload the authorization private key to OSS.
