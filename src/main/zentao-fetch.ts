import type { ClientRequest, ClientRequestConstructorOptions, IncomingMessage } from "electron";
import { isUnsafeZentaoHost } from "./zentao-client.ts";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export type ZentaoRequestFactory = (options: ClientRequestConstructorOptions) => ClientRequest;
export type ZentaoHostResolver = (host: string) => Promise<string[]>;

function responseHeaders(response: IncomingMessage): Headers {
  const headers = new Headers();
  for (let index = 0; index + 1 < response.rawHeaders.length; index += 2) {
    headers.append(response.rawHeaders[index]!, response.rawHeaders[index + 1]!);
  }
  return headers;
}

export function createElectronZentaoFetch(
  requestFactory: ZentaoRequestFactory,
  resolveHost?: ZentaoHostResolver,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const normalized = new Request(input, init);
    const url = new URL(normalized.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("ZenTao requests require HTTP(S)");
    if (resolveHost) {
      const addresses = await resolveHost(url.hostname);
      if (addresses.length === 0 || addresses.some(isUnsafeZentaoHost))
        throw new Error("ZenTao host resolved unsafely");
    }
    const signal = normalized.signal;
    if (signal.aborted) throw signal.reason;
    const body = normalized.body ? Buffer.from(await normalized.arrayBuffer()) : null;

    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const request = requestFactory({
        method: normalized.method,
        url: url.href,
        redirect: "manual",
        bypassCustomProtocolHandlers: true,
      });
      const cleanup = (): void => signal.removeEventListener("abort", onAbort);
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        request.abort();
        reject(error);
      };
      const onAbort = (): void => fail(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
      request.on("redirect", () => fail(new Error("ZenTao redirect rejected")));
      request.on("response", (response) => {
        if (settled) return request.abort();
        const chunks: Buffer[] = [];
        let ended = false;
        let size = 0;
        const onData = (chunk: Buffer): void => {
          size += chunk.byteLength;
          if (size > MAX_RESPONSE_BYTES) return fail(new Error("ZenTao response too large"));
          chunks.push(Buffer.from(chunk));
        };
        const onEnd = (): void => {
          if (ended || settled) return;
          ended = true;
          settled = true;
          cleanup();
          response.removeListener("data", onData);
          response.removeListener("end", onEnd);
          response.removeListener("error", fail);
          response.removeListener("aborted", onAborted);
          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode,
              statusText: response.statusMessage,
              headers: responseHeaders(response),
            }),
          );
        };
        const onAborted = (): void => fail(new Error("ZenTao response aborted"));
        response.on("data", onData);
        response.on("end", onEnd);
        response.on("error", fail);
        response.on("aborted", onAborted);
      });
      request.on("error", fail);
      for (const [name, value] of normalized.headers) request.setHeader(name, value);
      signal.addEventListener("abort", onAbort, { once: true });
      if (body) request.write(body);
      request.end();
    });
  }) as typeof fetch;
}
