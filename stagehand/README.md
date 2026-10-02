# Check out a Stripe page with WebMCP + Stagehand

Opens a Stripe Checkout page, drives it through its WebMCP tools
(`select_payment_method`, `fill_payment_form`, and `submit_payment`), and
prints the order from `get_order_summary`.

Tool discovery uses `page.onToolsAdded()` and `page.onToolsRemoved()` rather than
polling. The registry keeps the latest definition when a same-named tool changes
its input schema and removes tools when their frame or document disappears.

## Requirements

- Node.js 24 and pnpm 10.32.1.
- Google Chrome with WebMCP support (tested with Chrome 153). Stagehand enables the browser flags.
- A Stripe Checkout URL (a payment link, or a page embedding Stripe Elements).

This example pins the Stagehand 4.2 preview built from main commit
`5788121e60c2648654c2b36ec7755030f0015fab`. The hooks are not available in 4.1.

**Preview packaging issue:** the published alpha currently bundles a runtime with
protocol `2.0.0`, while its SDK requires `2.1.0-alpha-5788121...`. A clean launch
fails with `StagehandRuntimeIncompatibleError`. Until a matching preview is
published, build the SDK and extension together from the pinned main commit:

```sh
# From this sample's stagehand directory:
git clone https://github.com/browserbase/stagehand.git /tmp/stripe-stagehand-main
git -C /tmp/stripe-stagehand-main checkout 5788121e60c2648654c2b36ec7755030f0015fab
cd /tmp/stripe-stagehand-main
pnpm install --frozen-lockfile --filter '@browserbasehq/stagehand...' --filter '@browserbasehq/stagehand-extension...'
pnpm exec turbo run build --filter=@browserbasehq/stagehand
pnpm --dir packages/sdk-ts pack --pack-destination ../../artifacts
cd -
pnpm add /tmp/stripe-stagehand-main/artifacts/browserbasehq-stagehand-4.1.0.tgz
```

The source manifest still says `4.1.0`; this tarball contains the pinned main
source and a matching runtime, not the published 4.1 release. This temporary local
install changes your package manifest and lockfile; do not include those local
paths in a contribution.

## Preview without paying

```sh
pnpm install
pnpm demo
```

The demo opens the [public test payment link](https://buy.stripe.com/test_fZuaEW5UndC54Sy5gN6J200)
included in this sample: **WebMCP sandbox — Cheeky Pint Pro, $9/month**. It verifies
that the checkout is in test mode, switches Card → Bank → Card when Bank is
available, changes billing country Hong Kong → United States when supported,
and fills synthetic buyer details with Stripe's `4242` test card. It waits for
`submit_payment` to become available and stops **without invoking it**. No API key,
model, or `.env` file is required.

Watch the browser beside the terminal: `[tools:added]`, `[tools:updated]`, and
`[tools:removed]` report the live definitions, including their input field names.
Field values and payment details are not logged.

On this form, Card exposes card number, expiry, CVC, and billing fields. Bank
(`link_instant_debit`) replaces those with email and `institutionSearch`. After
choosing Hong Kong, `billingPostalCode` and the visible ZIP input disappear;
choosing United States restores them. Once the required card fields are complete,
`submit_payment` becomes available. This
demonstrates both changing input schemas and a new action becoming available on
the same page. No bank account is connected and no subscription is purchased.

For a terminal without a display:

```sh
HEADLESS=yes pnpm demo
```

Set `KEEP_OPEN=yes` to inspect the final page or `SCREENSHOT_PATH=checkout.png` to
save it. `STRIPE_URL` can select another test checkout; preview refuses a live-mode
checkout before filling any fields and ignores payment details from the environment.

## Run

```sh
pnpm install
cp .env.example .env
```

Fill in `.env`, then:

```sh
pnpm start
```

For `pnpm start`, `CONFIRM_PURCHASE=yes` is required. The run aborts if the total exceeds
`MAX_TOTAL_MINOR` (minor units, so `900` is $9.00).

`KEEP_OPEN=yes` leaves the browser up after paying.

## Notes on the WebMCP tools

- Field names differ per session: sessions that collect shipping expose
  `shipping*`, others expose `billing*`. The script re-reads the current schema
  before each fill, so fields introduced by a preceding update can be used.
- `fill_payment_form` often re-renders and never acks. The script fills one
  field per call and warns on a missing ack; it still requires the submission tool
  before proceeding. Hooks do not fix invocation errors.
- Hooks report future changes. Subscribe before navigation; call `page.tools()`
  once to seed any existing tools. The registry reconciles events that arrive
  during that initial snapshot and unsubscribes on cleanup.
- A new form field can update an existing tool rather than add a separate tool.
  Tools are identified by frame ID and name, not name alone.

Stripe documents payment-method-dependent inputs and progressive disclosure of the
submission tool in [Designing Checkout for AI agents](https://stripe.dev/blog/how-stripe-is-designing-checkout-for-ai-agents).
Availability varies by session; inspect the actual events instead of assuming that
every conditional UI field creates a tool. See the [Stripe WebMCP guide](https://docs.stripe.com/agentic-commerce/agents/webmcp).

## Development

```sh
pnpm lint
pnpm typecheck
pnpm test
```

Run `pnpm format` to apply formatting and lint fixes.
