import { safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import { validateCredentialKey } from "./credential-key.ts";

type VaultFile = {
  version: 1;
  entries: Record<string, string>;
};

export class CredentialVault {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private read(): VaultFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<VaultFile>;
      if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== "object") {
        throw new Error("Invalid credential vault format");
      }
      return { version: 1, entries: parsed.entries };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, entries: {} };
      throw error;
    }
  }

  private write(data: VaultFile): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, this.filePath);
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      /* best effort on Windows */
    }
  }

  private assertAvailable(): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("OS credential encryption is unavailable; credentials were not persisted");
    }
  }

  has(key: string): boolean {
    this.assertAvailable();
    return this.read().entries[validateCredentialKey(key)] !== undefined;
  }

  get(key: string): Record<string, unknown> | null {
    this.assertAvailable();
    const encrypted = this.read().entries[validateCredentialKey(key)];
    if (!encrypted) return null;
    const plaintext = safeStorage.decryptString(Buffer.from(encrypted, "base64"));
    const parsed = JSON.parse(plaintext) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid credential payload");
    return parsed as Record<string, unknown>;
  }

  set(key: string, value: Record<string, unknown>): void {
    this.assertAvailable();
    const data = this.read();
    const encrypted = safeStorage.encryptString(JSON.stringify(value));
    data.entries[validateCredentialKey(key)] = encrypted.toString("base64");
    this.write(data);
  }

  delete(key: string): void {
    const data = this.read();
    delete data.entries[validateCredentialKey(key)];
    this.write(data);
  }
}
