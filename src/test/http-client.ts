import type { Server } from "node:http";
import type { Express } from "express";

/**
 * Minimal HTTP test client: a real ephemeral listener plus a cookie jar, so the
 * tests exercise the same cookie parsing, CSRF and middleware stack as a
 * browser would without adding a supertest dependency.
 */

export class CookieJar {
  private readonly cookies = new Map<string, string>();

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  set(name: string, value: string | undefined): void {
    if (value === undefined) {
      this.cookies.delete(name);
    } else {
      this.cookies.set(name, value);
    }
  }

  header(): string | undefined {
    if (this.cookies.size === 0) return undefined;

    return [...this.cookies.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  clear(): void {
    this.cookies.clear();
  }

  /** Applies Express `Set-Cookie` headers, honouring expiration/deletion. */
  apply(setCookies: readonly string[]): void {
    for (const raw of setCookies) {
      const [pair, ...attributes] = raw.split(";");
      if (!pair) continue;

      const separator = pair.indexOf("=");
      if (separator <= 0) continue;

      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      const lowerAttributes = attributes.join(";").toLowerCase();
      const isDeletion =
        /max-age=0\b/.test(lowerAttributes) || /expires=.*1970/.test(lowerAttributes);

      if (isDeletedValue(value) || isDeletion) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }
}

function isDeletedValue(value: string): boolean {
  return value.length === 0;
}

export interface TestResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
  readonly setCookies: readonly string[];
}

export interface RequestOptions {
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  /** Send the jar's CSRF cookie in the header. Defaults to true for writes. */
  readonly csrf?: boolean;
  /** Overrides the jar's Cookie header, for replaying captured credentials. */
  readonly cookie?: string;
  readonly bearer?: string;
}

export interface TestApi {
  readonly baseUrl: string;
  readonly jar: CookieJar;
  request(method: string, path: string, options?: RequestOptions): Promise<TestResponse>;
  get(path: string, options?: RequestOptions): Promise<TestResponse>;
  post(path: string, options?: RequestOptions): Promise<TestResponse>;
  put(path: string, options?: RequestOptions): Promise<TestResponse>;
  patch(path: string, options?: RequestOptions): Promise<TestResponse>;
  delete(path: string, options?: RequestOptions): Promise<TestResponse>;
  close(): Promise<void>;
}

export async function createTestApi(app: Express): Promise<TestApi> {
  const jar = new CookieJar();

  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Test server did not bind to a TCP port");
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;

  async function request(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<TestResponse> {
    const headers: Record<string, string> = { accept: "application/json", ...options.headers };

    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }

    if (options.bearer) {
      headers.authorization = `Bearer ${options.bearer}`;
    } else if (options.cookie !== undefined) {
      headers.cookie = options.cookie;
    } else {
      const cookie = jar.header();
      if (cookie) headers.cookie = cookie;
    }

    const wantsCsrf = options.csrf ?? (method !== "GET" && method !== "HEAD");
    const csrfToken = jar.get("hos_csrf");

    if (wantsCsrf && csrfToken && !options.bearer && options.cookie === undefined) {
      headers["x-csrf-token"] = csrfToken;
    }

    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: "manual",
    });

    const setCookies = response.headers.getSetCookie();
    jar.apply(setCookies);

    const contentType = response.headers.get("content-type") ?? "";
    const body: unknown =
      response.status === 204
        ? null
        : contentType.includes("application/json")
          ? await response.json()
          : await response.text();

    return { status: response.status, headers: response.headers, body, setCookies };
  }

  return {
    baseUrl,
    jar,
    request,
    get: (path, options) => request("GET", path, options),
    post: (path, options) => request("POST", path, options),
    put: (path, options) => request("PUT", path, options),
    patch: (path, options) => request("PATCH", path, options),
    delete: (path, options) => request("DELETE", path, options),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
