import type { Page, WebMCPTool } from "@browserbasehq/stagehand";

type Identity = Pick<WebMCPTool, "frameId" | "name">;
type Subscription = { unsubscribe(): Promise<void> };
export type ToolPage = {
  tools: Page["tools"];
  onToolsAdded(listener: Parameters<Page["onToolsAdded"]>[0]): Promise<Subscription>;
  onToolsRemoved(listener: Parameters<Page["onToolsRemoved"]>[0]): Promise<Subscription>;
};
export type ToolLog = {
  event: "initial" | "added" | "updated" | "removed";
  name: string;
  fields: string[];
};
type Change = { added: WebMCPTool[] } | { removed: Identity[] };
type ToolQuery = {
  name: string;
  frameId?: string;
  predicate?: (tool: WebMCPTool) => boolean;
};
type Waiter = {
  queries: ToolQuery[];
  resolve(tool: WebMCPTool): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};
const identity = (tool: Identity) => JSON.stringify([tool.frameId, tool.name]);

export async function createToolRegistry(
  page: ToolPage,
  options: { log?: (log: ToolLog) => void } = {},
) {
  const current = new Map<string, WebMCPTool>();
  const pending = new Set<Waiter>();
  const subscriptions: Subscription[] = [];
  const buffered: Change[] = [];
  let phase: "subscribing" | "seeding" | "ready" | "disposed" = "subscribing";
  let disposing: Promise<void> | undefined;

  function log(event: ToolLog["event"], tool: Identity & Partial<WebMCPTool>) {
    // Never pass tool arguments, responses, or schema defaults to the logger.
    options.log?.({
      event,
      name: tool.name,
      fields: Object.keys(tool.inputSchema?.properties ?? {}),
    });
  }

  function get(name: string, frameId?: string): WebMCPTool | undefined {
    if (phase === "disposed") throw new Error("WebMCP registry is disposed");
    if (frameId !== undefined) return current.get(identity({ name, frameId }));
    const matches = [...current.values()].filter((tool) => tool.name === name);
    if (matches.length > 1) throw new Error(`Multiple frames expose "${name}"; specify frameId`);
    return matches[0];
  }

  function find(queries: ToolQuery[]) {
    for (const { name, frameId, predicate } of queries) {
      const tool = get(name, frameId);
      if (tool && (!predicate || predicate(tool))) return tool;
    }
  }

  function apply(change: Change, announce: boolean) {
    if ("added" in change) {
      for (const tool of change.added) {
        const event = current.has(identity(tool)) ? "updated" : "added";
        current.set(identity(tool), tool); // Replace the complete definition, including its schema.
        if (announce) log(event, tool);
      }
    } else {
      for (const tool of change.removed) {
        const previous = current.get(identity(tool));
        current.delete(identity(tool));
        if (announce) log("removed", previous ?? tool);
      }
    }
  }

  function receive(change: Change) {
    // Events before both subscriptions are ready are covered by the later snapshot.
    if (phase === "subscribing" || phase === "disposed") return;
    if (phase === "seeding") {
      buffered.push(change);
      return;
    }
    apply(change, true);
    for (const waiter of pending) {
      try {
        const tool = find(waiter.queries);
        if (!tool) continue;
        clearTimeout(waiter.timer);
        pending.delete(waiter);
        waiter.resolve(tool);
      } catch (error) {
        clearTimeout(waiter.timer);
        pending.delete(waiter);
        waiter.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  async function waitForAny(queries: ToolQuery[], { timeout = 30_000 } = {}) {
    if (!queries.length) throw new Error("At least one tool query is required");
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2_147_483_647) {
      throw new Error("timeout must be a positive, finite timer duration");
    }
    const tool = find(queries);
    if (tool) return tool;
    return new Promise<WebMCPTool>((resolve, reject) => {
      const waiter: Waiter = {
        queries,
        resolve,
        reject,
        timer: setTimeout(() => {
          pending.delete(waiter);
          const names = queries.map(({ name }) => `"${name}"`).join(" or ");
          reject(
            new Error(`Timed out waiting for matching WebMCP tool ${names} after ${timeout}ms`),
          );
        }, timeout),
      };
      pending.add(waiter);
    });
  }

  function waitFor(
    name: string,
    { timeout, ...query }: Omit<ToolQuery, "name"> & { timeout?: number } = {},
  ) {
    return waitForAny([{ name, ...query }], { timeout });
  }

  function dispose(): Promise<void> {
    if (disposing) return disposing;
    phase = "disposed";
    current.clear();
    for (const waiter of pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("WebMCP registry disposed while waiting for a tool"));
    }
    pending.clear();
    disposing = Promise.allSettled(
      subscriptions.map((subscription) => subscription.unsubscribe()),
    ).then((results) => {
      const errors = results
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (errors.length)
        throw new AggregateError(errors, "Could not unsubscribe from WebMCP events");
    });
    return disposing;
  }

  try {
    const results = await Promise.allSettled([
      page.onToolsAdded((added) => receive({ added })),
      page.onToolsRemoved((removed) => receive({ removed })),
    ]);
    for (const result of results)
      if (result.status === "fulfilled") subscriptions.push(result.value);
    const errors = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, "Could not subscribe to WebMCP events");
    phase = "seeding";
    const seed = await page.tools();
    apply({ added: seed }, false);
    // Events received while the snapshot was in flight win over that snapshot.
    for (const change of buffered) apply(change, false);
    buffered.length = 0;
    phase = "ready";
    for (const tool of current.values()) log("initial", tool);
    return { get, waitFor, waitForAny, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
