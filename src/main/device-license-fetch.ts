import type { ClientRequest, ClientRequestConstructorOptions, IncomingMessage } from "electron";

export type DeviceLicenseRequestFactory = (options: ClientRequestConstructorOptions) => ClientRequest;

function responseHeaders(response: IncomingMessage): Headers {
  const headers = new Headers();
  for (let index = 0; index + 1 < response.rawHeaders.length; index += 2) {
    headers.append(response.rawHeaders[index]!, response.rawHeaders[index + 1]!);
  }
  return headers;
}

function responseBody(
  response: IncomingMessage,
  request: ClientRequest,
  signal: AbortSignal | null,
): ReadableStream<Uint8Array> {
  let finished = false;
  let cleanup = (): void => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const onData = (chunk: Buffer): void => {
        if (!finished) controller.enqueue(chunk);
      };
      const onEnd = (): void => {
        if (finished) return;
        finished = true;
        cleanup();
        controller.close();
      };
      const onError = (error: Error): void => {
        if (finished) return;
        finished = true;
        cleanup();
        controller.error(error);
      };
      const onAborted = (): void => onError(new Error("Device license response aborted"));
      const onSignalAbort = (): void => {
        onError(
          signal?.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError"),
        );
        request.abort();
      };
      cleanup = () => {
        response.removeListener("data", onData);
        response.removeListener("end", onEnd);
        response.removeListener("error", onError);
        response.removeListener("aborted", onAborted);
        signal?.removeEventListener("abort", onSignalAbort);
      };
      response.on("data", onData);
      response.on("end", onEnd);
      response.on("error", onError);
      response.on("aborted", onAborted);
      signal?.addEventListener("abort", onSignalAbort, { once: true });
      if (signal?.aborted) onSignalAbort();
    },
    cancel() {
      if (finished) return;
      finished = true;
      cleanup();
      request.abort();
    },
  });
}

export function createElectronDeviceLicenseFetch(requestFactory: DeviceLicenseRequestFactory): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET") return Promise.reject(new Error("Device license requests require GET"));
    const signal = init?.signal ?? null;
    if (signal?.aborted) return Promise.reject(signal.reason);

    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const request = requestFactory({ method: "GET", url, redirect: "manual", bypassCustomProtocolHandlers: true });
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      };
      const onAbort = (): void => {
        fail(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
        request.abort();
      };
      request.on("redirect", () => {
        fail(new Error("Device license redirect rejected"));
        request.abort();
      });
      request.on("response", (response) => {
        if (settled) return request.abort();
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        const status = response.statusCode;
        const body =
          status === 204 || status === 205 || status === 304 ? null : responseBody(response, request, signal);
        resolve(
          new Response(body, {
            status,
            statusText: response.statusMessage,
            headers: responseHeaders(response),
          }),
        );
      });
      request.on("error", fail);
      for (const [name, value] of new Headers(init?.headers)) request.setHeader(name, value);
      signal?.addEventListener("abort", onAbort, { once: true });
      request.end();
    });
  }) as typeof fetch;
}
