import { localBrowser, Stagehand, type WebMCPTool } from "@browserbasehq/stagehand";
import { z } from "zod";
import { createToolRegistry } from "./tools.ts";

const orderSchema = z.object({
  livemode: z.boolean(),
  currency: z.string(),
  totalAmount: z.number(),
  lineItems: z.array(z.object({ name: z.string(), minorUnitsAmount: z.number() })),
});
const toolOutputSchema = z.object({
  content: z.array(z.object({ text: z.string().optional() })).optional(),
});
const inputSchemaSchema = z.object({
  properties: z.record(z.string(), z.unknown()).default({}),
});
const accepts = (field: string) => (tool: WebMCPTool) =>
  field in inputSchemaSchema.parse(tool.inputSchema).properties;

const preview = process.argv.includes("--preview");
const url =
  process.env.STRIPE_URL ??
  (preview ? "https://buy.stripe.com/test_fZuaEW5UndC54Sy5gN6J200" : undefined);
if (!url) throw new Error("Set STRIPE_URL");
if (!preview && process.env.CONFIRM_PURCHASE !== "yes") {
  throw new Error("Set CONFIRM_PURCHASE=yes. This can charge a real card.");
}
const maxTotal = Number(process.env.MAX_TOTAL_MINOR);
if (!preview && !(maxTotal > 0)) throw new Error("Set MAX_TOTAL_MINOR");

async function invoke(
  tool: WebMCPTool,
  input: Record<string, string | boolean> = {},
  timeout = 30_000,
) {
  const result = await (await tool.invoke({ input: input as never })).result({ timeout });
  if (result.status !== "Completed") {
    throw new Error(`${tool.name} ${result.status}: ${result.errorText ?? ""}`);
  }
  return (toolOutputSchema.parse(result.output).content ?? [])
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
}

const env = process.env;
const browser = await localBrowser.launch({ headless: env.HEADLESS === "yes" });

try {
  await Stagehand.create({ browser });
  const page = await browser.context.newPage();
  // Hooks report future changes. Subscribe before navigation and seed any
  // existing tools once; waiting for a tool no longer polls page.tools().
  const tools = await createToolRegistry(page, {
    log: ({ event, name, fields }) =>
      console.log(`[tools:${event}] ${name}${fields.length ? ` (${fields.join(", ")})` : ""}`),
  });
  try {
    await page.goto(url);
    const mcp = async (name: string, input: Record<string, string | boolean> = {}) =>
      invoke(await tools.waitFor(name), input);
    const summary = async () => orderSchema.parse(JSON.parse(await mcp("get_order_summary")));
    const initial = await summary();
    if (preview && initial.livemode) {
      throw new Error("Preview requires a test-mode Checkout. No fields were filled.");
    }
    console.log("Checkout", initial);
    const initialSubmit = tools.get("submit_payment");
    await mcp("select_payment_method", { payment_method_type: "card" });
    await tools.waitFor("fill_payment_form", { predicate: accepts("cardNumber") });

    if (preview) {
      console.log("Demo step: Card selected; card fields are exposed.");
      const select = await tools.waitFor("select_payment_method");
      const methodInput = inputSchemaSchema.parse(select.inputSchema).properties
        .payment_method_type;
      const methods = z.object({ enum: z.array(z.string()).default([]) }).parse(methodInput ?? {});
      if (methods.enum.includes("link_instant_debit")) {
        console.log("Demo step: Switch to Bank; wait for the bank form schema.");
        await invoke(select, { payment_method_type: "link_instant_debit" });
        await tools.waitFor("fill_payment_form", {
          predicate: (tool) => accepts("institutionSearch")(tool) && !accepts("cardNumber")(tool),
        });
        console.log("Demo step: Switch back to Card; wait for card fields to return.");
        await mcp("select_payment_method", { payment_method_type: "card" });
        await tools.waitFor("fill_payment_form", {
          predicate: (tool) => accepts("cardNumber")(tool) && !accepts("institutionSearch")(tool),
        });
      } else {
        console.log("Demo step: Bank is not advertised; continuing with Card.");
      }
      const cardForm = await tools.waitFor("fill_payment_form");
      if (accepts("billingCountry")(cardForm)) {
        for (const country of ["HK", "US"]) {
          const postalCodeExpected = country === "US";
          console.log(
            `Demo step: Billing country ${country}; wait for ZIP field to ${postalCodeExpected ? "appear" : "disappear"}.`,
          );
          await invoke(
            await tools.waitFor("fill_payment_form"),
            { billingCountry: country },
            5_000,
          ).catch(() => {
            console.warn("Country update was not acknowledged; waiting for its schema change.");
          });
          await tools.waitFor("fill_payment_form", {
            predicate: (tool) =>
              accepts("billingCountry")(tool) &&
              accepts("billingPostalCode")(tool) === postalCodeExpected,
          });
        }
      }
    }

    // Preview always uses synthetic test details, even if live values are set
    // in the environment. It never invokes submit_payment.
    const values = preview
      ? {
          email: "demo@example.com",
          shippingName: "Demo Shopper",
          shippingAddressLine1: "1 Dr Carlton B Goodlett Pl",
          shippingLocality: "San Francisco",
          shippingAdministrativeArea: "CA",
          shippingPostalCode: "94102",
          billingName: "Demo Shopper",
          billingAddressLine1: "1 Dr Carlton B Goodlett Pl",
          billingLocality: "San Francisco",
          billingAdministrativeArea: "CA",
          billingPostalCode: "94102",
          phoneNumberCountryCode: "US",
          phoneNumber: "2025550100",
          cardNumber: "4242424242424242",
          cardExpiry: "12 / 34",
          cardCvc: "123",
          cardUseShippingAsBilling: true,
          enableStripePass: false,
        }
      : {
          shippingName: env.SHIPPING_NAME,
          shippingAddressLine1: env.SHIPPING_LINE1,
          shippingAddressLine2: env.SHIPPING_LINE2,
          shippingLocality: env.SHIPPING_CITY,
          shippingAdministrativeArea: env.SHIPPING_STATE,
          shippingPostalCode: env.SHIPPING_POSTAL_CODE,
          billingName: env.SHIPPING_NAME,
          billingAddressLine1: env.SHIPPING_LINE1,
          billingLocality: env.SHIPPING_CITY,
          billingAdministrativeArea: env.SHIPPING_STATE,
          billingPostalCode: env.SHIPPING_POSTAL_CODE,
          phoneNumberCountryCode: env.BUYER_PHONE_COUNTRY ?? "US",
          phoneNumber: env.BUYER_PHONE,
          cardNumber: env.CARD_NUMBER?.replaceAll(" ", ""),
          cardExpiry: env.CARD_EXPIRY,
          cardCvc: env.CARD_CVC,
          cardUseShippingAsBilling: true,
          enableStripePass: false,
          email: env.BUYER_EMAIL,
        };
    const remaining = new Map(
      Object.entries(values).filter((entry): entry is [string, string | boolean] => {
        const [, value] = entry;
        return value !== undefined && value !== "";
      }),
    );

    // Re-read the current definition after each update. Country/payment choices
    // can replace a same-named tool with a different input schema.
    for (;;) {
      const form = await tools.waitForAny([
        {
          name: "fill_payment_form",
          predicate: (tool) => {
            const accepted = inputSchemaSchema.parse(tool.inputSchema).properties;
            return [...remaining.keys()].some((field) => field in accepted);
          },
        },
        // A submission tool already advertised on the empty form is not a
        // readiness signal. Require a new definition in that case.
        { name: "submit_payment", predicate: (tool) => tool !== initialSubmit },
      ]);
      if (form.name === "submit_payment") break;
      const accepted = inputSchemaSchema.parse(form.inputSchema).properties;
      const next = [...remaining].find(([field]) => field in accepted);
      if (!next) continue;
      const [field, value] = next;
      remaining.delete(field);
      console.log("Filling", field);
      // A re-render may apply the value but cancel the response. Do not repeat
      // the mutation blindly; the final readiness check must still pass.
      await invoke(form, { [field]: value }, 5_000).catch(() => {
        console.warn(
          `No successful acknowledgement for ${field}; checking readiness before submission.`,
        );
      });
      await page.waitForTimeout(300);
    }

    await tools.waitFor("submit_payment");
    const due = await summary();
    console.log("Ready for review", due);
    if (preview) {
      console.log("Preview complete: submit_payment is available. No payment submitted.");
    } else {
      if (due.totalAmount > maxTotal) {
        throw new Error(`Total ${due.totalAmount} > MAX_TOTAL_MINOR ${maxTotal}`);
      }

      console.log("Paying", due);
      await mcp("submit_payment");
      await page.waitForTimeout(15_000);
      console.log("Final", await summary().catch(() => due));
    }

    if (env.SCREENSHOT_PATH) await page.screenshot({ path: env.SCREENSHOT_PATH });
    if (env.KEEP_OPEN === "yes") {
      console.log("Leaving the browser open. Ctrl+C to exit.");
      await new Promise<void>(() => {});
    }
  } finally {
    await tools.dispose();
  }
} finally {
  await browser.close();
}
