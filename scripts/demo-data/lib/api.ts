import type { ApiError as ApiErrorBody, LoginResponse, Page } from "@lazyit/shared";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    message: string,
  ) {
    super(message);
  }
}

const RETRYABLE = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 6;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Query = Record<string, string | number | boolean | undefined>;

export class Client {
  constructor(
    readonly base: string,
    private readonly token?: string,
  ) {}

  withToken(token: string): Client {
    return new Client(this.base, token);
  }

  url(path: string, query?: Query): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) params.set(key, String(value));
    }
    const qs = params.toString();
    return `${this.base}${path}${qs ? `?${qs}` : ""}`;
  }

  async request<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(this.url(path, query), {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (err) {
        if (attempt >= MAX_ATTEMPTS) {
          throw new ApiError(0, method, path, `network error: ${(err as Error).message}`);
        }
        await sleep(backoff(attempt));
        continue;
      }
      if (RETRYABLE.has(res.status) && attempt < MAX_ATTEMPTS) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
        continue;
      }
      const text = await res.text();
      const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
      if (!isJson && text.trimStart().startsWith("<")) {
        throw new ApiError(
          res.status,
          method,
          path,
          "got an HTML page instead of the API; LAZYIT_URL must be the API base (https://<host>/api on a deployed instance)",
        );
      }
      const data: unknown = isJson && text ? JSON.parse(text) : undefined;
      if (!res.ok) throw new ApiError(res.status, method, path, errorMessage(data, res.status));
      return data as T;
    }
  }

  get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>("GET", path, undefined, query);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body ?? {});
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body);
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PUT", path, body);
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }

  // Offset pages are only stable over a unique sort key, so callers pass one and a short read is reported.
  async all<T extends { id: string }>(path: string, query: Query = {}): Promise<T[]> {
    const first = await this.get<T[] | Page<T>>(path, { ...query, limit: 200, offset: 0 });
    if (Array.isArray(first)) return first;
    const byId = new Map(first.items.map((item) => [item.id, item]));
    for (let offset = first.items.length; offset < first.total; offset += 200) {
      const page = await this.get<Page<T>>(path, { ...query, limit: 200, offset });
      if (page.items.length === 0) break;
      for (const item of page.items) byId.set(item.id, item);
    }
    if (byId.size < first.total) {
      console.warn(`   warning: read ${byId.size} of ${first.total} rows from ${path}; a re-run may report duplicates as failures`);
    }
    return [...byId.values()];
  }

  async total(path: string, query: Query = {}): Promise<number> {
    const page = await this.get<Page<unknown>>(path, { ...query, limit: 1 });
    return page.total;
  }
}

function backoff(attempt: number): number {
  return Math.min(30_000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
}

function errorMessage(data: unknown, status: number): string {
  const body = data as Partial<ApiErrorBody> | undefined;
  const message = body?.message;
  if (Array.isArray(message)) return message.join("; ");
  if (typeof message === "string") return message;
  return `HTTP ${status}`;
}

// The login limiter is per IP (10 a minute), so a 429 here waits out the window instead of failing.
export async function login(client: Client, identifier: string, password: string): Promise<LoginResponse> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await client.request<LoginResponse>("POST", "/auth/login", {
        identifier,
        password,
        rememberMe: false,
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 429 && attempt < 8) {
        await sleep(15_000);
        continue;
      }
      throw err;
    }
  }
}

export async function pool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const index = next++;
      await worker(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
}

export function isStatus(err: unknown, ...statuses: number[]): boolean {
  return err instanceof ApiError && statuses.includes(err.status);
}
