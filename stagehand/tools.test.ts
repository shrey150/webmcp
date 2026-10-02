import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate, setTimeout } from "node:timers/promises";
import type { WebMCPTool } from "@browserbasehq/stagehand";
import { createToolRegistry, type ToolLog, type ToolPage } from "./tools.ts";

function tool(name: string, fields: string[] = [], frameId = "main"): WebMCPTool {
  // Tests exercise discovery and identity only; invocation is supplied by Stagehand.
  return {
    name,
    frameId,
    description: name,
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(
        fields.map((field) => [field, { type: "string", default: "secret" }]),
      ),
    },
  } as unknown as WebMCPTool;
}

class FakePage implements ToolPage {
  added?: Parameters<ToolPage["onToolsAdded"]>[0];
  removed?: Parameters<ToolPage["onToolsRemoved"]>[0];
  snapshotCalls = 0;
  unsubscribed = 0;
  seed: WebMCPTool[] = [];
  deferredSeed?: Promise<WebMCPTool[]>;

  async tools() {
    assert.ok(this.added && this.removed, "both subscriptions must precede the snapshot");
    this.snapshotCalls++;
    return this.deferredSeed ?? this.seed;
  }
  async onToolsAdded(listener: NonNullable<FakePage["added"]>) {
    this.added = listener;
    return {
      unsubscribe: async () => {
        this.added = undefined;
        this.unsubscribed++;
      },
    };
  }
  async onToolsRemoved(listener: NonNullable<FakePage["removed"]>) {
    this.removed = listener;
    return {
      unsubscribe: async () => {
        this.removed = undefined;
        this.unsubscribed++;
      },
    };
  }
}

test("preexisting tools are immediately available; logs contain no schema defaults", async () => {
  const page = new FakePage();
  const existing = tool("fill_payment_form", ["cardNumber"]);
  page.seed = [existing];
  const logs: ToolLog[] = [];
  const registry = await createToolRegistry(page, { log: (event) => logs.push(event) });
  try {
    assert.equal(registry.get(existing.name), existing);
    assert.equal(await registry.waitFor(existing.name), existing);
    assert.deepEqual(logs, [
      { event: "initial", name: "fill_payment_form", fields: ["cardNumber"] },
    ]);
    assert.ok(!JSON.stringify(logs).includes("secret"));
  } finally {
    await registry.dispose();
  }
});

test("delayed registration resolves a wait without polling", async () => {
  const page = new FakePage();
  const registry = await createToolRegistry(page);
  try {
    const waiting = registry.waitFor("submit_payment", { timeout: 1000 });
    await setImmediate();
    const added = tool("submit_payment");
    page.added?.([added]);
    assert.equal(await waiting, added);
    assert.equal(page.snapshotCalls, 1);
  } finally {
    await registry.dispose();
  }
});

test("a conditional field arriving after settling is filled before newly offered submission", async () => {
  const page = new FakePage();
  const initialSubmit = tool("submit_payment");
  page.seed = [tool("fill_payment_form", ["email"]), initialSubmit];
  const registry = await createToolRegistry(page);
  const remaining = new Set(["email", "phoneNumber"]);
  const next = () =>
    registry.waitForAny(
      [
        {
          name: "fill_payment_form",
          predicate: (form) => {
            const properties = form.inputSchema?.properties;
            return (
              properties !== null &&
              typeof properties === "object" &&
              [...remaining].some((field) => field in properties)
            );
          },
        },
        { name: "submit_payment", predicate: (submit) => submit !== initialSubmit },
      ],
      { timeout: 1000 },
    );
  try {
    assert.equal((await next()).name, "fill_payment_form");
    remaining.delete("email");
    let resolved = false;
    const conditional = next().then((form) => {
      resolved = true;
      return form;
    });
    await setTimeout(350); // Later than the runner's 300ms settling pause.
    assert.equal(resolved, false, "old form and preexisting submit tool must not end the wait");
    const phoneForm = tool("fill_payment_form", ["email", "phoneNumber"]);
    page.added?.([phoneForm]);
    assert.equal(await conditional, phoneForm);
    remaining.delete("phoneNumber");
    const ready = next();
    const newSubmit = tool("submit_payment");
    page.added?.([newSubmit]);
    assert.equal(await ready, newSubmit);
    assert.equal(page.snapshotCalls, 1, "schema waits must use events, not polling");
  } finally {
    await registry.dispose();
  }
});

test("replacement refreshes schemas and removals respect frame identity", async () => {
  const page = new FakePage();
  page.seed = [tool("fill_payment_form", ["cardNumber"])];
  const logs: ToolLog[] = [];
  const registry = await createToolRegistry(page, { log: (event) => logs.push(event) });
  try {
    const updated = tool("fill_payment_form", ["email"]);
    page.added?.([updated]);
    assert.equal(registry.get(updated.name), updated);
    assert.equal(logs.at(-1)?.event, "updated");
    const other = tool(updated.name, ["postalCode"], "iframe");
    page.added?.([other]);
    assert.throws(() => registry.get(updated.name), /Multiple frames/);
    assert.equal(registry.get(updated.name, "iframe"), other);
    page.removed?.([{ name: updated.name, frameId: "main" }]);
    assert.equal(registry.get(updated.name), other);
    page.removed?.([{ name: other.name, frameId: "iframe" }]);
    assert.equal(registry.get(updated.name), undefined);
  } finally {
    await registry.dispose();
  }
});

test("missing tools time out; disposal rejects pending waits and unsubscribes once", async () => {
  const page = new FakePage();
  const registry = await createToolRegistry(page);
  await assert.rejects(registry.waitFor("missing", { timeout: 5 }), /Timed out/);
  const rejected = assert.rejects(registry.waitFor("pending"), /disposed/);
  await registry.dispose();
  await rejected;
  await registry.dispose();
  assert.equal(page.unsubscribed, 2);
  await assert.rejects(registry.waitFor("after-close"), /disposed/);
  assert.throws(() => registry.get("after-close"), /disposed/);
});

test("in-flight snapshot cannot resurrect removals or overwrite newer schemas", async () => {
  const page = new FakePage();
  const old = tool("fill_payment_form", ["cardNumber"]);
  const removed = tool("submit_payment");
  let resolveSeed!: (seed: WebMCPTool[]) => void;
  page.deferredSeed = new Promise((resolve) => {
    resolveSeed = resolve;
  });
  const creating = createToolRegistry(page);
  await setImmediate();
  assert.equal(page.snapshotCalls, 1);
  const updated = tool(old.name, ["email"]);
  page.added?.([updated]);
  page.removed?.([{ name: removed.name, frameId: removed.frameId }]);
  resolveSeed([old, removed]);
  const registry = await creating;
  try {
    assert.equal(registry.get(old.name), updated);
    assert.equal(registry.get(removed.name), undefined);
  } finally {
    await registry.dispose();
  }
});

test("failed initial snapshot cleans up both subscriptions", async () => {
  const page = new FakePage();
  page.tools = async () => {
    throw new Error("snapshot failed");
  };
  await assert.rejects(createToolRegistry(page), /snapshot failed/);
  assert.equal(page.unsubscribed, 2);
});
